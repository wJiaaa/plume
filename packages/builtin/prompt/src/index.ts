/**
 * 内置插件 plume.prompt：发给模型的系统提示词和消息里的环境信息。
 *
 * 挂在 `model.context` 的最外层（order -1000）：先把各段系统提示词、每个新日期后面的 `<env>`、插话和打断的说明补进去，
 * 再交给里层。所以其他插件的层拿到的已经是完整的一份，按段改、删、加都和以前一样；要整个换掉系统提示词，
 * 在更里面的层里把 `sections` 换掉就行。
 *
 * 每次请求都按磁盘现状组一份，但发出去的是这个会话冻结的那份：里层交回来的段和模型此刻以为的不一样时，改动作为一条增量消息
 * 接在这一轮的开头（见 `update.ts`、`frozen.ts`），系统提示词这段前缀一直不变，服务商的缓存才接得上。工具表也一样：一轮里照冻结的
 * 那份发，插件装卸、重载带来的变化在下一轮开头才换上（见 `frozen.ts`）。
 */

import { join } from "node:path";
import type { Plugin } from "@plume/contract";
import { withEnvironment } from "./environment.ts";
import { FrozenPrompts } from "./frozen.ts";
import { findRepoRoot, isIsolatedWorktree, loadMagpieInstructions, loadProjectInstructions } from "./instructions.ts";
import { withSteeringNote } from "./steering.ts";
import { buildPromptSections } from "./system.ts";

/** 比插件常用的 order 都小：先于它们补上默认的内容。 */
const ORDER = -1000;

export default {
	name: "plume.prompt",
	apply(ctx) {
		const frozen = new FrozenPrompts(join(ctx.dataDir, "frozen"), (message) => ctx.log.warn(message));
		ctx.sessions.onDeleted((sessionId) => frozen.forget(sessionId));
		ctx.hook(
			"model.context",
			async (input, next) => {
				const kinds = new Map(ctx.tools.list().flatMap((tool) => (tool.kind ? [[tool.name, tool.kind] as const] : [])));
				const [projectInstructions, gitRepo, isolatedWorktree, magpieInstructions] = await Promise.all([
					loadProjectInstructions(input.cwd),
					// 在仓库的子目录里（单仓多包里打开 `packages/x`）也是在仓库里。
					findRepoRoot(input.cwd).then((root) => root !== null),
					isIsolatedWorktree(input.cwd),
					loadMagpieInstructions(ctx.appDataDir, ctx.log),
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
					isGitRepo: gitRepo,
					isolatedWorktree,
					projectInstructions,
					tone: input.personalization.tone,
					// Magpie 分发的共享指令和人自己的全局指令放进同一段。
					customInstructions: [magpieInstructions, input.personalization.customInstructions.trim()].filter(Boolean).join("\n\n"),
					scratchDir: input.scratchDir,
				});
				const request = await frozen.prepare(input.sessionId, input.messages);
				const output = await next({ ...input, sections: [...sections, ...input.sections], messages: withEnvironment(withSteeringNote(request.messages)) });
				return { ...output, ...request.settle(output.sections, output.messages, output.tools) };
			},
			{ order: ORDER },
		);
	},
} satisfies Plugin;
