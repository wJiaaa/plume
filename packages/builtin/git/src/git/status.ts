/**
 * 暂存区和工作区，两张单子。
 *
 * 暂存区的意义就在这一分：下一个提交里有什么、没有什么。这里的东西都是报告这两张单子，或者把文件在两者之间挪动。
 */

import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { GitOperation, GitStatus, GitStatusFile, OpResult, UpstreamDistance, WorkspaceStat } from "../api.ts";
import { classify, readCapped } from "./diff.ts";
import { END_OF_OPTIONS, git, mapLimit, MAX_BLOB_BYTES, MAX_FILES, run } from "./exec.ts";
import { parseNumstat, parseStatusZ, statusBranch } from "./parse.ts";
import { gitBranch, isGitRepo } from "./probe.ts";
import { classifyRemote } from "./remote-state.ts";
import { withView, type RepoView } from "./view.ts";

/**
 * 有多少没提交，不建 diff。
 *
 * 输入框上方一直显示这个数，所以要便宜。和面板数法一样：同样从 `status -uall` 开始、同样截在 `MAX_FILES`、
 * 同样跳过超过 `MAX_BLOB_BYTES` 的文件——计数说 34k、点开的面板说 10k，就有一个在撒谎。
 * status 只跑一次：`--branch` 已经回答了「是不是仓库、哪个分支、有没有第一个提交」。
 */
export async function workspaceStat(cwd: string): Promise<WorkspaceStat> {
	const none: WorkspaceStat = { branch: null, added: 0, removed: 0, files: 0 };
	return (await withView(cwd, (view) => workspaceStatIn(view, none)).catch(() => null)) ?? none;
}

async function workspaceStatIn(view: RepoView, none: WorkspaceStat): Promise<WorkspaceStat> {
	const { cwd } = view;
	let status: string;
	try {
		status = await view.git(["status", "--porcelain=v1", "-uall", "-z", "--branch", "--ignore-submodules=dirty"]);
	} catch {
		return none;
	}
	const parsed = parseStatusZ(status);
	const { branch, born: hasHead } = statusBranch(parsed.header);
	const entries = parsed.entries.slice(0, MAX_FILES);

	// 跟踪的改动一次 `--numstat` 全拿到；二进制按 0 行算。
	const tracked = hasHead ? await numstat(view, ["diff", "--numstat", "-z", "--ignore-submodules=dirty", "HEAD"]) : new Map<string, never>();

	let added = 0;
	let removed = 0;
	const fresh: string[] = [];
	for (const { path } of entries) {
		const known = tracked.get(path);
		if (known) {
			added += known.added;
			removed += known.removed;
			continue;
		}
		fresh.push(path);
	}
	// 没跟踪的：每一行都是新增。一起读，新目录里一堆文件是常态。
	for (const count of await mapLimit(fresh, (path) => countNewFile(cwd, path))) added += count.added;

	return { branch, added, removed, files: entries.length };
}

/**
 * 检出着的分支离上游多远，给输入框上方的分支签用。两次调用而不是 `gitStatus`：那个要走一遍工作区，这个每一轮
 * 结束都读。按上次获取时的远端分支算，这里不获取。没有上游（从没推过、游离）为空：没有距离可说。
 */
export async function upstreamDistance(cwd: string): Promise<UpstreamDistance | null> {
	return (await withView(cwd, upstreamDistanceIn).catch(() => null)) ?? null;
}

async function upstreamDistanceIn(view: RepoView): Promise<UpstreamDistance | null> {
	const [upstream, counts] = await Promise.all([
		view.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).then(
			(out) => out.trim(),
			() => "",
		),
		view.git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).catch(() => ""),
	]);
	const [ahead, behind] = counts
		.trim()
		.split(/\s+/)
		.map((n) => Number.parseInt(n, 10));
	if (!upstream || ahead === undefined || behind === undefined || !Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
	return { upstream, ahead, behind };
}

/** 空树：仓库的第一个提交也有东西可比。 */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * 没做完的操作，看 git 留在目录里的标记文件。这些是每个工作树各自的，所以路径从 `--git-dir` 来（链接的工作树里是
 * `.git/worktrees/<名字>`），不用共享的 `--git-common-dir`，否则会把主检出的变基报成这个的。
 * 每次都读：冲突的合并留下脏的工作区，变基让 HEAD 游离——不读的话，停在半路的变基会被画成普通的游离检出，
 * 还给出 git 会拒绝的推送、拉取按钮。
 */
async function operationInProgress(cwd: string): Promise<GitOperation | null> {
	const reported = await git(cwd, ["rev-parse", "--git-dir"])
		.then((out) => out.trim())
		.catch(() => null);
	if (!reported) return null;
	// 仓库根目录下答的是相对路径，链接的工作树里是绝对路径。
	const dir = isAbsolute(reported) ? reported : join(cwd, reported);
	const has = (name: string) =>
		access(join(dir, name))
			.then(() => true)
			.catch(() => false);
	const [rebaseMerge, rebaseApply, merge, cherry, revert, bisect] = await Promise.all([
		has("rebase-merge"),
		has("rebase-apply"),
		has("MERGE_HEAD"),
		has("CHERRY_PICK_HEAD"),
		has("REVERT_HEAD"),
		has("BISECT_LOG"),
	]);
	if (rebaseMerge || rebaseApply) return "rebase";
	if (merge) return "merge";
	if (cherry) return "cherry-pick";
	if (revert) return "revert";
	if (bisect) return "bisect";
	return null;
}

/** `rev-list --count`；范围解析不了时为空。 */
async function countCommits(view: RepoView, range: string): Promise<number | null> {
	const out = await view.git(["rev-list", "--count", END_OF_OPTIONS, range]).catch(() => null);
	if (out === null) return null;
	const count = Number.parseInt(out.trim(), 10);
	return Number.isFinite(count) ? count : null;
}

/**
 * 没有上游的分支有几个提交没推。只有远端已经有同名分支时才有得数（自己克隆后手建的分支、丢了跟踪配置）；
 * 没有就没有基准，答案是空而不是一个数。
 */
async function unpushedWithoutUpstream(view: RepoView, remote: string, branch: string): Promise<number | null> {
	const exists = await view
		.git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`])
		.then(() => true)
		.catch(() => false);
	if (!exists) return null;
	return countCommits(view, `${remote}/${branch}..HEAD`);
}

/**
 * 按暂存区分开的状态。porcelain 每行第一个字母是暂存区、第二个是工作区，所以一个文件可以两边都有：暂存了一部分，
 * 之后又改了。合成一张单子，人就会只提交一半想提交的。
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
	const empty: GitStatus = {
		branch: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		staged: [],
		unstaged: [],
		remoteState: "none",
		remote: null,
		operation: null,
		unpushed: null,
		head: null,
	};
	if (!(await isGitRepo(cwd))) return empty;
	return (await withView(cwd, (view) => gitStatusIn(view)).catch(() => null)) ?? empty;
}

async function gitStatusIn(view: RepoView): Promise<GitStatus> {
	const { cwd } = view;
	// 四个互不相关的问题一起问：一轮进行时每 1.5 秒跑一次，慢的是 status，另外三个和它重叠，不加延迟。
	// 分支、未完成的操作、远端列表只读引用、标记文件和配置，在真实仓库上问；status 在视图里。
	const [branch, porcelain, operation, remoteList] = await Promise.all([
		gitBranch(cwd),
		view.git(["status", "--porcelain=v1", "-uall", "-z", "--branch", "--ignore-submodules=dirty"]).catch(() => ""),
		operationInProgress(cwd),
		git(cwd, ["remote"]).catch(() => ""),
	]);
	const remotes = remoteList
		.split("\n")
		.map((name) => name.trim())
		.filter(Boolean);

	const { header, entries } = parseStatusZ(porcelain);
	const upstreamMatch = header.match(/\.\.\.(\S+)/);
	const aheadMatch = header.match(/ahead (\d+)/);
	const behindMatch = header.match(/behind (\d+)/);

	const [stagedStat, unstagedStat] = await Promise.all([
		numstat(view, ["diff", "--numstat", "-z", "--cached"]),
		numstat(view, ["diff", "--numstat", "-z", "--ignore-submodules=dirty"]),
	]);

	const staged: GitStatusFile[] = [];
	const unstaged: GitStatusFile[] = [];
	// 两遍：先建单子，再一起补没跟踪文件要的行数——在循环里逐个读就是一个文件一次往返。
	const fresh: GitStatusFile[] = [];
	for (const { code, path } of entries.slice(0, MAX_FILES)) {
		const index = code[0];
		const tree = code[1];
		if (index && index !== " " && index !== "?") {
			staged.push({ path, status: classify(index), staged: true, unstaged: false, ...counts(stagedStat.get(path)) });
		}
		if (tree && tree !== " ") {
			const untracked = index === "?" || tree === "?";
			const file: GitStatusFile = {
				path,
				status: untracked ? "untracked" : classify(tree),
				staged: false,
				unstaged: true,
				...(untracked ? { added: 0, removed: 0 } : counts(unstagedStat.get(path))),
			};
			unstaged.push(file);
			if (untracked) fresh.push(file);
		}
	}

	const freshCounts = await mapLimit(fresh, (file) => countNewFile(cwd, file.path));
	fresh.forEach((file, i) => {
		file.added = freshCounts[i]?.added ?? 0;
		file.removed = freshCounts[i]?.removed ?? 0;
	});

	const upstream = upstreamMatch?.[1] ?? null;
	const ahead = Number.parseInt(aheadMatch?.[1] ?? "0", 10);
	const standing = classifyRemote({ header, branch, upstream, operation, remotes });

	// 只有 no-upstream 且挑得出远端时要多问一次，常见的两种情况不多花。
	let unpushed: number | null = null;
	if (standing.state === "tracking") unpushed = ahead;
	else if (standing.state === "no-upstream" && standing.remote && branch) unpushed = await unpushedWithoutUpstream(view, standing.remote, branch);

	// 游离时 HEAD 指着哪，面板好说点比「不在分支上」更有用的话。只在没有分支名时读。
	const head =
		standing.state === "detached"
			? await view
					.git(["rev-parse", "--short", "HEAD"])
					.then((out) => out.trim() || null)
					.catch(() => null)
			: null;

	return {
		branch,
		upstream,
		ahead,
		behind: Number.parseInt(behindMatch?.[1] ?? "0", 10),
		staged,
		unstaged,
		remoteState: standing.state,
		remote: standing.remote,
		operation,
		unpushed,
		head,
	};
}

function counts(stat: { added: number; removed: number } | undefined): { added: number; removed: number } {
	return { added: stat?.added ?? 0, removed: stat?.removed ?? 0 };
}

async function numstat(view: RepoView, args: string[]): Promise<Map<string, { added: number; removed: number }>> {
	return parseNumstat(await view.git(args).catch(() => ""));
}

/** 没跟踪的文件没有另一边可比，每一行都算新增。 */
async function countNewFile(cwd: string, path: string): Promise<{ added: number; removed: number }> {
	const buffer = (await readCapped(join(cwd, path), MAX_BLOB_BYTES))?.buffer;
	if (!buffer || buffer.includes(0)) return { added: 0, removed: 0 };
	const text = buffer.toString("utf8");
	return { added: text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length, removed: 0 };
}

export async function stagePaths(cwd: string, paths: string[]): Promise<OpResult> {
	return run(cwd, ["add", "--", ...paths]);
}

/** 用 `restore --staged` 而不是 `reset`：第一个提交之前 `reset HEAD` 没有东西可对。 */
export async function unstagePaths(cwd: string, paths: string[]): Promise<OpResult> {
	return run(cwd, ["restore", "--staged", "--", ...paths]);
}

/**
 * 丢掉工作区的改动。没跟踪的文件直接删（没有版本可还原）。分两次调用：`restore` 拒绝它不跟踪的路径。
 */
export async function discardPaths(cwd: string, paths: string[]): Promise<OpResult> {
	const tracked: string[] = [];
	const untracked: string[] = [];
	for (const path of paths) {
		const known = await git(cwd, ["ls-files", "--error-unmatch", "--", path])
			.then(() => true)
			.catch(() => false);
		(known ? tracked : untracked).push(path);
	}
	if (tracked.length) {
		const result = await run(cwd, ["restore", "--worktree", "--", ...tracked]);
		if (!result.ok) return result;
	}
	if (untracked.length) return run(cwd, ["clean", "-fd", "--", ...untracked]);
	return { ok: true };
}

export const LOG_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1f%P%x1e";
