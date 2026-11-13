/**
 * 工作树那一半经 `ctx.serve` 开给界面入口的接口，两边共用的类型。和 `GitApi` 并成一个对象开出去，所以方法名都带着工作树。
 */

/** 插件给对话建的工作树都在这种分支上：自动清理只认它，分支签见到它就把位置让给工作树签。 */
export const SESSION_BRANCH_PREFIX = "plume/session-";

/** 一个对话自己的工作树，建好时记下。 */
export interface SessionWorktree {
	/** 开出它的项目目录：会话原来的工作目录。 */
	project: string;
	/** 工作树自己的根目录。 */
	root: string;
	/** 会话在哪跑：`root`，或者项目是仓库的子目录时是它里面的同一个子目录。 */
	cwd: string;
	/** `plume/session-<会话 id 前八位>`。 */
	branch: string;
	/** 切出时项目检出着的分支，合回去、同步都对着它；游离 HEAD 时没有。 */
	base?: string;
}

/** 插件按会话记下的东西：有工作树，或者要过却没建成（原因是 git 的原话）。 */
export interface SessionRecord {
	worktree?: SessionWorktree;
	error?: string;
}

/** 工作树对着基分支的样子，每次现问 git。 */
export interface WorktreeState {
	branch: string;
	/** 合回去、同步对着的分支；一个都找不到时为空。 */
	base: string | null;
	/** 目录还在（归档、删除时收走了就不在，提交都在分支上）。 */
	present: boolean;
	/** 不计合并提交。 */
	ahead: number;
	behind: number;
	/** 没提交的文件数（含没跟踪的）。 */
	uncommitted: number;
	/** 停在一次同步的中途。 */
	merging: boolean;
	conflicted: string[];
}

/** 为什么不做：工作树不在了、找不到基分支、对话在跑、正停在同步中途、项目目录里有半截合并、基分支检出在别处、git 报错。 */
type Refusal = "gone" | "no-base" | "running" | "syncing" | "busy" | "elsewhere" | "failed";

type Refused = { kind: "refused"; reason: Refusal; detail?: string };
type Uncommitted = { kind: "uncommitted"; files: number };
type Conflict = { kind: "conflict"; files: string[]; base: string };

/** 合进去了：`archived` 是这个对话已经归档着（菜单上就不再问要不要归档）。 */
export type MergeOutcome =
	| { kind: "merged"; commits: number; base: string; archived?: boolean }
	| { kind: "nothing"; base: string }
	| Uncommitted
	| Conflict
	| Refused;
export type SyncOutcome = { kind: "synced"; commits: number; base: string } | { kind: "up-to-date"; base: string } | Uncommitted | Conflict | Refused;

export interface WorktreeSettings {
	/** 工作树建在哪；空串是默认位置（`SettingsView.defaultRoot`）。开头的 `~` 是家目录。 */
	rootDir: string;
	/** 建工作树前先获取上游。 */
	fetchFirst: boolean;
	/** 每建一棵会话工作树，清掉超出 `keepLimit` 的旧的。 */
	autoClean: boolean;
	keepLimit: number;
}

export interface SettingsView extends WorktreeSettings {
	defaultRoot: string;
}

/** 设置页列出的一棵链接工作树。 */
export interface ListedWorktree {
	path: string;
	label: string;
	branch: string | null;
	/** 它挂在哪个项目的仓库上。 */
	repo: string;
}

interface Done {
	ok: boolean;
	error?: string;
}

export interface WorktreeApi {
	/** 这个目录在不在 git 仓库里：新对话的开关只在仓库里出现。 */
	isRepo(cwd: string): Promise<boolean>;
	/** 在这个目录开的下一个新对话要不要工作树：输入框上选过的，没选过就不开。 */
	worktreePick(cwd: string): Promise<boolean>;
	/** 输入框上的开关拨了一下。发出第一条消息时用掉，之后回到默认。 */
	chooseWorktree(cwd: string, on: boolean): Promise<void>;
	worktreeRecord(sessionId: string): Promise<SessionRecord | null>;
	/** 有工作树的会话 → 它的分支：侧栏行首的 ⑂ 用。 */
	worktreeBranches(): Promise<Record<string, string>>;
	worktreeState(sessionId: string): Promise<WorktreeState | null>;
	mergeWorktree(sessionId: string): Promise<MergeOutcome>;
	syncWorktree(sessionId: string): Promise<SyncOutcome>;
	/** 归档这个对话：合回去之后，人点了菜单上的「归档这个对话」。目录照归档的规矩收走。 */
	archiveSession(sessionId: string): Promise<void>;
	/** 放弃停在冲突上的同步。没什么在等时也是 true。 */
	abortWorktreeSync(sessionId: string): Promise<boolean>;
	worktreeSettings(): Promise<SettingsView>;
	saveWorktreeSettings(patch: Partial<WorktreeSettings>): Promise<SettingsView>;
	/** 这些项目目录的仓库上挂着的链接工作树。 */
	linkedWorktrees(projects: string[]): Promise<ListedWorktree[]>;
	/** 删一棵链接工作树；有没提交的改动时 git 拒绝，原因报回来。 */
	removeWorktree(repo: string, path: string): Promise<Done>;
}
