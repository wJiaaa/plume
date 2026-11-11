/**
 * 内置插件 plume.prompt：发给模型的系统提示词和消息里的环境信息。
 *
 * 挂在 `model.context` 的最外层（order -1000）：先把各段系统提示词、每个新日期后面的 `<env>`、插话和打断的说明补进去，
 * 再交给里层。所以其他插件的层拿到的已经是完整的一份，按段改、删、加都和以前一样；要整个换掉系统提示词，
 * 在更里面的层里把 `sections` 换掉就行。
 *
 * 每次请求都按磁盘现状组一份，但发出去的是这个会话冻结的那份：里层交回来的段和模型此刻以为的不一样时，改动作为一条增量消息
 * 接在这一轮的开头（见 `update.ts`、`frozen.ts`），系统提示词这段前缀一直不变，服务商的缓存才接得上。
 */

import { join } from "node:path";
import type { PermissionMode, Plugin, SandboxMode } from "@plume/contract";
import { commandShell } from "@plume/platform";
import { withEnvironment } from "./environment.ts";
import { FrozenPrompts } from "./frozen.ts";
import { findRepoRoot, isIsolatedWorktree, loadMagpieInstructions, loadProjectInstructions } from "./instructions.ts";
import { withSteeringNote } from "./steering.ts";
import { buildPromptSections } from "./system.ts";

/** 比插件常用的 order 都小：先于它们补上默认的内容。 */
const ORDER = -1000;

/**
 * 点名哪个 shell 按会话的权限模式对应的沙箱档选，和 plume.tools 的 bash 跑命令时选的是同一个（`commandShell`）：
 * Windows 上受约束的命令跑 PowerShell，完全访问跑 Git Bash；别的平台每档都是同一个 shell。
 * 插件之间不互相引用实现，这份对应和 plume.tools 的 `tools/types.ts` 里的 `SANDBOX_BY_PERMISSION` 各存一份，改一处要同步另一处。
 */
const SANDBOX_BY_PERMISSION: Record<PermissionMode, SandboxMode> = {
	ask: "read-only",
	auto: "workspace-write",
	full: "danger-full-access",
};

export default {
	name: "plume.prompt",
	apply(ctx) {
		const frozen = new FrozenPrompts(join(ctx.dataDir, "frozen"), (message) => ctx.log.warn(message));
		ctx.sessions.onDeleted((sessionId) => frozen.forget(sessionId));
		ctx.hook(
			"model.context",
			async (input, next) => {
				const [projectInstructions, gitRepo, isolatedWorktree, magpieInstructions] = await Promise.all([
					loadProjectInstructions(input.cwd),
					// 在仓库的子目录里（单仓多包里打开 `packages/x`）也是在仓库里。
					findRepoRoot(input.cwd).then((root) => root !== null),
					isIsolatedWorktree(input.cwd),
					loadMagpieInstructions(ctx.log),
				]);
				const sections = buildPromptSections({
					cwd: input.cwd,
					projectRoots: input.projectRoots,
					platform: process.platform,
					// 外层（计划模式）要求只读时命令跑在只读沙箱里，按那一档点名。
					shell: commandShell(input.readOnly ? "read-only" : SANDBOX_BY_PERMISSION[input.permissionMode]),
					tools: input.tools,
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
				return { ...output, ...request.settle(output.sections, output.messages) };
			},
			{ order: ORDER },
		);
	},
} satisfies Plugin;
