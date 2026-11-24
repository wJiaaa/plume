/**
 * plume.scripts 逻辑入口经 `ctx.serve` 暴露给界面入口的接口。
 * 按 @plume/rpc 约定，所有方法参数个数严格固定（禁用可选参数和剩余参数）。
 */

import type { ProjectScript, RepoScriptsResult, ScriptInput } from "./types.ts";

interface RunScriptOutcome {
	tab: string;
	/** 仅在脚本配置了 `previewUrl` 且开启 `autoOpenPreview` 时非空。 */
	previewUrl: string | null;
}

export interface ScriptsApi {
	runScript(sessionId: string, scriptId: string): Promise<RunScriptOutcome>;
	revealTerminal(sessionId: string, tab: string): Promise<void>;
	/** `projectId` 为 null 时修改全局默认脚本，否则修改该项目覆盖（首次编辑时从全局默认拷贝一份）。 */
	saveScript(projectId: string | null, scriptId: string | null, input: ScriptInput): Promise<ProjectScript>;
	deleteScript(projectId: string | null, scriptId: string): Promise<void>;
	/** 移除该项目的独立覆盖，恢复继承全局默认脚本。 */
	resetProject(projectId: string): Promise<void>;
	/** 将 `.plume/scripts.json` 中的一条脚本显式导入到指定项目配置中。 */
	importRepoScript(projectId: string, input: ScriptInput): Promise<ProjectScript>;
	readRepoScripts(projectPath: string): Promise<RepoScriptsResult>;
}
