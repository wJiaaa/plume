/** 项目脚本的共享类型（逻辑入口与界面入口共用）。 */

export const SCRIPT_ICONS = ["play", "test", "lint", "configure", "build", "debug"] as const;

export type ScriptIconId = (typeof SCRIPT_ICONS)[number];

export interface ProjectScript {
	id: string;
	name: string;
	command: string;
	icon: ScriptIconId;
	/** 新建对话工作树后自动运行；同一列表内最多一条。 */
	runOnWorktreeCreate?: boolean;
	/** 仅在 `runOnWorktreeCreate` 为真时生效：等待脚本执行完成后再启动首轮对话。 */
	waitForSetup?: boolean;
	/** 会话归档或删除时自动关闭该脚本占用的终端。 */
	stopOnArchive?: boolean;
	/** 运行后可打开的预览地址（如 `http://localhost:5173`）。 */
	previewUrl?: string;
	/** 运行脚本时自动打开 `previewUrl`。 */
	autoOpenPreview?: boolean;
}

export type ScriptInput = Omit<ProjectScript, "id">;

export interface ScriptsSettings {
	/** 项目没有独立配置时继承的全局默认脚本。 */
	globalScripts: ProjectScript[];
	/** 按项目 id 覆盖的脚本列表。 */
	byProject: Record<string, ProjectScript[]>;
}

export type RepoScriptsResult = { status: "missing" } | { status: "invalid"; error: string } | { status: "valid"; scripts: ScriptInput[] };

export interface SetupRunStatus {
	scriptName: string;
	tab: string;
}
