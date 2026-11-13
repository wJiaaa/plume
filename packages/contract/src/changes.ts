/** 文件工具留下的本轮净变化；快照和撤销由提供 file.changes 服务的插件负责。 */
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
 * 工具结果的 `details` 带上这几个字段，就是声明「这次调用改了文件，改动快照记在服务 `file.changes` 里」：`changeId` 是一处，
 * `changeIds` 是几处（命令改的），`changeWarning` 是有改动没记全时给人看的话。要知道一段对话改了哪些文件的插件按它们找，
 * 不认是哪个工具交的。`details` 里别的字段照旧归插件。
 */
export interface FileChangeDetails {
	changeId?: string;
	changeIds?: string[];
	changeWarning?: string;
}

/**
 * 工具结果的 `details` 带上这几个字段，就是声明「这次调用改了一个文件，改的是这几处」：转录的通用卡片按它画 diff、写 +N −M，
 * 一段活的那一行把各次的加减合起来。和 `FileChangeDetails` 是两件事，常常一起带：那个说改动快照记在服务里（能撤销、能汇总），
 * 这个只说这一次改了什么给人看；命令改的文件只有快照，没有这一份。`details` 里别的字段照旧归插件。
 */
export interface FileDiffDetails {
	/** 改的是哪个文件，给人看的写法（工作目录里的写相对路径）；diff 按它的扩展名配色。 */
	path: string;
	added: number;
	removed: number;
	hunks: ChangeHunk[];
}

/** 快照标识来自工具结果的 `FileChangeDetails`，不接受界面传来的文件原文。 */
export interface FileChangesService {
	collect(sessionId: string, cwd: string, ids: readonly string[]): Promise<FileChangesSummary>;
	/** path 不给时撤销全部；写入前重新校验快照、当前内容和项目边界。 */
	undo(sessionId: string, cwd: string, ids: readonly string[], path?: string): Promise<void>;
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
