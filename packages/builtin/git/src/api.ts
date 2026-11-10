/**
 * plume.git 两个入口共用的接口：逻辑入口经 `ctx.serve` 开出 `GitApi`，界面入口经 `ui.remote<GitApi>()` 调。
 *
 * 每个方法的参数个数写死（可选的写成 `| null`）：运行时会在末尾追加 CallContext，可选参数会被它顶掉。
 * 远端的三个调用（拉取、推送、获取）和生成提交说明会卡在网络上，界面用 `.cancel()` 叫停，这边接 `call.signal`。
 */

import type { CallContext } from "@plume/contract";

export interface DiffLine {
	type: "context" | "add" | "remove";
	text: string;
	oldLine?: number;
	newLine?: number;
}

export interface DiffHunk {
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

/** 一个文件的改动，所有 diff 视图都画这个形状。 */
export interface DiffFile {
	path: string;
	status: FileStatus;
	added: number;
	removed: number;
	hunks: DiffHunk[];
	/** 不是文本：没有 hunk，行数为 0。照样列出来，界面画图或写大小。 */
	binary?: boolean;
	/** 存在的那一边的字节数，给二进制那一行用。 */
	bytes?: number;
}

export interface RefDiff {
	files: DiffFile[];
	added: number;
	removed: number;
}

export interface WorkspaceDiff extends RefDiff {
	branch: string | null;
}

export interface GitStatusFile {
	path: string;
	status: FileStatus;
	/** 两个可以同时为真：暂存了一部分之后又改了。 */
	staged: boolean;
	unstaged: boolean;
	added: number;
	removed: number;
}

/** 让推送、拉取停下来的未完成操作。 */
export type GitOperation = "rebase" | "merge" | "cherry-pick" | "revert" | "bisect";

export type RemoteState =
	/** 还没有提交，没有东西能推。 */
	| "no-commits"
	/** 变基、合并……停在半路，先收尾。 */
	| "in-progress"
	/** 不在分支上。 */
	| "detached"
	/** 没有远端：只在本地用，很正常。 */
	| "none"
	/** 有远端，这个分支没有上游。 */
	| "no-upstream"
	/** 有上游。 */
	| "tracking";

export interface GitStatus {
	branch: string | null;
	upstream: string | null;
	/** 没有上游时两个都是 0（`git status` 只给这么多），所以先看 `remoteState`；要显示的数是 `unpushed`。 */
	ahead: number;
	behind: number;
	staged: GitStatusFile[];
	unstaged: GitStatusFile[];
	remoteState: RemoteState;
	/** 推送会去的远端；挑不出来时为空。 */
	remote: string | null;
	/** `remoteState` 为 `in-progress` 时是哪一种。 */
	operation: GitOperation | null;
	/** 这里有、远端没有的提交数。空表示没法回答（远端从没见过这个分支），不是 0。 */
	unpushed: number | null;
	/** 游离 HEAD 指着的短 sha；在分支上时为空。 */
	head: string | null;
}

export interface GitCommit {
	sha: string;
	shortSha: string;
	subject: string;
	/** 全部父提交，界面据此画分叉和合流。 */
	parents: string[];
	author: string;
	/** ISO 8601，按界面语言在界面里格式化。 */
	date: string;
	/** 指着这个提交的分支名和标签名，去掉了前缀。 */
	refs: string[];
}

export interface BranchList {
	current: string | null;
	local: string[];
	/** 远端分支，去掉了本地已有同名分支的那些。 */
	remote: string[];
}

/** Git 面板能切过去的一个仓库或工作树。 */
export interface RepoRef {
	/** 工作目录的绝对路径。 */
	path: string;
	/** 相对工作区的路径；工作区根目录本身是文件夹名。 */
	label: string;
	branch: string | null;
	/** 是链接的工作树，不是主检出。 */
	worktree: boolean;
}

/** 一个目录是不是仓库；git 答不上来时说明原因（按当前界面语言）。 */
interface RepoProbe {
	repo: boolean;
	branch: string | null;
	problem?: string;
}

export interface WorkspaceStat {
	branch: string | null;
	added: number;
	removed: number;
	files: number;
}

export interface UpstreamDistance {
	upstream: string;
	ahead: number;
	behind: number;
}

export interface OpResult {
	ok: boolean;
	error?: string;
}

export interface RemoteResult extends OpResult {
	/** 调用方叫停的：不算失败，什么都不用说。 */
	cancelled?: boolean;
}

/** 二进制文件的一边，画成图用。 */
export interface DiffBlob {
	dataUrl: string;
	bytes: number;
}

export interface GitApi {
	/** 工作区本身：是不是仓库、在哪个分支，git 答不上来的原因。 */
	probe(root: string, call: CallContext): Promise<RepoProbe>;
	/** 工作区下的每一个仓库：前端后端分开放在一起很常见。 */
	repos(root: string, call: CallContext): Promise<RepoRef[]>;
	/** 一个仓库链接出去的工作树。 */
	worktrees(cwd: string, call: CallContext): Promise<RepoRef[]>;
	init(cwd: string, call: CallContext): Promise<OpResult>;
	status(cwd: string, call: CallContext): Promise<GitStatus>;
	/** 有多少没提交：输入框上方一直显示，只数不算 diff。 */
	stat(cwd: string, call: CallContext): Promise<WorkspaceStat>;
	/** 当前分支离上游多远，按上次获取时的远端分支算；没有上游为空。 */
	upstream(cwd: string, call: CallContext): Promise<UpstreamDistance | null>;
	branches(cwd: string, call: CallContext): Promise<BranchList>;
	switchBranch(cwd: string, branch: string, call: CallContext): Promise<OpResult>;
	createBranch(cwd: string, name: string, from: string | null, call: CallContext): Promise<OpResult>;
	deleteBranch(cwd: string, name: string, force: boolean, call: CallContext): Promise<OpResult>;
	log(cwd: string, limit: number, ref: string | null, call: CallContext): Promise<GitCommit[]>;
	/** 一个提交相对它的父提交改了什么。 */
	commitDiff(cwd: string, sha: string, call: CallContext): Promise<RefDiff>;
	/** 一个提交的文件列表，不带内容：先列出来，diff 随后到。 */
	commitDiffSummary(cwd: string, sha: string, call: CallContext): Promise<{ files: DiffFile[] }>;
	/** 历史上任意两点；`head` 为空时拿暂存区和 `base` 比。 */
	diffRefs(cwd: string, base: string, head: string | null, call: CallContext): Promise<RefDiff>;
	/** 没提交的改动；`index` 是只看没暂存的那部分。 */
	workspaceDiff(cwd: string, base: "head" | "index", call: CallContext): Promise<WorkspaceDiff>;
	/** 二进制文件的一边（图片），画不了时为空。 */
	blob(cwd: string, path: string, side: "head" | "work", call: CallContext): Promise<DiffBlob | null>;
	stage(cwd: string, paths: string[], call: CallContext): Promise<OpResult>;
	unstage(cwd: string, paths: string[], call: CallContext): Promise<OpResult>;
	/** 不可撤销：没跟踪的文件直接删掉。 */
	discard(cwd: string, paths: string[], call: CallContext): Promise<OpResult>;
	/** 提交面板上显示为已暂存的那些。 */
	commitStaged(cwd: string, message: string, call: CallContext): Promise<OpResult>;
	/** 用默认模型按暂存的改动（没有暂存就按工作区）写一句提交说明。 */
	generateCommitMessage(cwd: string, call: CallContext): Promise<{ ok: boolean; message?: string; error?: string }>;
	/** 生成提交说明用哪种语言（`commit-language.ts` 里的 id）。 */
	commitLanguage(call: CallContext): Promise<string>;
	setCommitLanguage(id: string, call: CallContext): Promise<void>;
	push(cwd: string, call: CallContext): Promise<RemoteResult>;
	pull(cwd: string, call: CallContext): Promise<RemoteResult>;
	/** `fetch --prune`，让 ahead / behind 说的是远端现在的样子；`quiet` 是面板自己在后台取，超时更短。 */
	fetch(cwd: string, quiet: boolean, call: CallContext): Promise<RemoteResult>;
}
