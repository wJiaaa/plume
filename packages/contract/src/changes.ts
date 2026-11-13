/** 替模型改过的文件：本体记下的改动快照（`ToolResultMessage.changes`）汇总成的净变化、能不能撤销，见 `PluginChanges`。 */
export interface ChangeHunk {
	oldStart: number;
	newStart: number;
	lines: ChangeLine[];
}

/** diff 里的一行；行号只在那一边有这一行时给。 */
export interface ChangeLine {
	type: "context" | "add" | "remove";
	text: string;
	oldLine?: number;
	newLine?: number;
}

export interface ChangedFile {
	/** 真实绝对路径；界面只在显示时相对化，文件菜单和撤销不丢失工作目录。 */
	path: string;
	added: number;
	removed: number;
	hunks: ChangeHunk[];
	canUndo: boolean;
	/** 不能撤销时给人看的原因，按当前界面语言返回。 */
	undoReason?: string;
	/** 不能撤销的原因归哪一类；快照读不出来时不给，那时 `FileChangesSummary.warnings` 不为空。 */
	undoProblem?: UndoProblem;
}

/** 不能自动退回的几种情况：改动来自命令、中途被别处改过、不在项目内、之后被改过。 */
export type UndoProblem = "command" | "interleaved" | "outside" | "modified";

export interface FileChangesSummary {
	files: ChangedFile[];
	warnings: string[];
}

/**
 * 工具结果的 `details` 带上这几个字段，就是声明「这次调用改了一个文件，改的是这几处」：转录的通用卡片按它画 diff、写 +N −M，
 * 一段活的那一行把各次的加减合起来。只说这一次改了什么给人看；改了哪些文件、能不能撤销是本体记的 `ToolResultMessage.changes`，
 * 不用工具声明。命令改的文件只有那一份，没有这一份。`details` 里别的字段照旧归插件。
 */
export interface FileDiffDetails {
	/** 改的是哪个文件，给人看的写法（工作目录里的写相对路径）；diff 按它的扩展名配色。 */
	path: string;
	added: number;
	removed: number;
	hunks: ChangeHunk[];
}

/**
 * `ctx.changes`：本体记下的改动快照汇总和撤销（交付卡、侧边聊天告诉主会话它改过哪些文件）。快照标识来自工具结果的
 * `ToolResultMessage.changes.ids`，不接受界面传来的文件原文；工作目录用会话自己的。本体提供，别的插件换不掉。
 */
export interface PluginChanges {
	/** 这组快照的净变化：同一文件只算首次写之前到末次写之后，改回原样的不列；快照读不出来时 `warnings` 不为空。没有这个会话时抛错。 */
	collect(sessionId: string, ids: readonly string[]): Promise<FileChangesSummary>;
	/** 撤销这组快照改过的文件，`path` 不给时全部；写入前重新校验快照、当前内容和项目边界，有一个不对就都不写，抛错的 message 给人看。 */
	undo(sessionId: string, ids: readonly string[], path?: string): Promise<void>;
}

/** 撤回、编辑重发截掉一段对话时，那段里改过的一个文件。`problem` 为 null 的能安全退回到截断点之前。 */
export interface RevertFile {
	path: string;
	added: number;
	removed: number;
	problem: UndoProblem | null;
}

/**
 * 截掉的那段改过哪些文件。`unrecorded` 说有改动没记下来（快照缺了、命令影响的文件太多没记全），这时退回的不完整，
 * 一个文件都不该写。
 */
export interface RevertPlan {
	files: RevertFile[];
	unrecorded: boolean;
}
