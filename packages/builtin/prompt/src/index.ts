/**
 * 内置插件 plume.prompt：发给模型的系统提示词写什么。
 *
 * 挂在 `model.context` 的外层（order -1000）：先把各段系统提示词补进去，再交给里层。所以其他插件的层拿到的已经是完整的一份，
 * 按段改、删、加都和以前一样；要整个换掉系统提示词，在更里面的层里把 `sections` 换掉就行。计划模式在它外面（-1001）设好只读，
 * 它据此点名只读那一档的 shell。
 *
 * 身份和准则人能换（设置 › 个性化「身份与准则」，见 `presets.ts`）：一个会话用哪一套在它第一次请求时定下，之后不变。
 *
 * 会话内冻结、中途的改动作为增量送达、消息里的日期和插话说明不在这里，由本体包在整条钩子链外面（`packages/core/agent/src/prompt/`）。
 */

import type { Plugin } from "@plume/contract";
import type { PromptApi } from "./api.ts";
import { createPresets } from "./presets.ts";
import { findRepoRoot, isIsolatedWorktree, loadMagpieInstructions, loadProjectInstructions } from "./instructions.ts";
import { buildPromptSections } from "./system.ts";

/** 比插件常用的 order 都小：先于它们补上默认的内容。 */
const ORDER = -1000;

export default {
	name: "plume.prompt",
	apply(ctx) {
		const presets = createPresets(ctx);
		ctx.sessions.onDeleted((sessionId) => presets.forget(sessionId));
		// 删会话时插件没在跑（停用着、删到一半退出）留下的身份与准则，对着现有的会话清掉。
		void ctx.sessions
			.list()
			.then((all) => presets.keepOnly(all.map((session) => session.id)))
			.catch((error: unknown) => ctx.log.warn(`清理已删会话的身份与准则失败：${error instanceof Error ? error.message : String(error)}`));
		ctx.serve({
			view: () => presets.view(),
			save: (id, draft) => presets.save(id, draft),
			remove: (id) => presets.remove(id),
			reset: (id) => presets.reset(id),
			select: (id) => presets.select(id),
		} satisfies PromptApi);
		ctx.hook(
			"model.context",
			async (input, next) => {
				const kinds = new Map(ctx.tools.list().flatMap((tool) => (tool.kind ? [[tool.name, tool.kind] as const] : [])));
				const repoRoot = findRepoRoot(input.cwd);
				const [projectInstructions, gitRepo, isolatedWorktree, magpieInstructions, persona] = await Promise.all([
					loadProjectInstructions(input.cwd, repoRoot),
					// 在仓库的子目录里（单仓多包里打开 `packages/x`）也是在仓库里。
					repoRoot.then((root) => root !== null),
					isIsolatedWorktree(input.cwd),
					loadMagpieInstructions(ctx.appDataDir, ctx.log),
					presets.forRequest(input),
				]);
				const sections = buildPromptSections({
					cwd: input.cwd,
					projectRoots: input.projectRoots,
					platform: process.platform,
					// 本体按权限模式和外层的只读（计划模式）选好的那个，和工具经 `run.exec` 跑命令时用的是同一个。
					shell: input.shell,
					// 工具做的是哪种活按注册它的插件的声明（`ToolDefinition.kind`）认，只看这一轮真给模型的那些。
					tools: input.tools.map((tool) => ({ name: tool.name, kind: kinds.get(tool.name) })),
					modelName: input.model.name,
					permissionMode: input.permissionMode,
					readOnly: input.readOnly,
					isGitRepo: gitRepo,
					isolatedWorktree,
					projectInstructions,
					tone: input.personalization.tone,
					// Magpie 分发的共享指令和人自己的全局指令放进同一段。
					customInstructions: [magpieInstructions, input.personalization.customInstructions.trim()].filter(Boolean).join("\n\n"),
					scratchDir: input.scratchDir,
					persona,
				});
				return next({ ...input, sections: [...sections, ...input.sections] });
			},
			{ order: ORDER },
		);
	},
} satisfies Plugin;
