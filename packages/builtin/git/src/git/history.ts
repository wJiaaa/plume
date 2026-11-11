/**
 * 提交，以及提交之间的差别；还有写历史的几件事（提交、建删分支）和碰远端的三件事。
 *
 * `gitLog` 带着父提交：旁边那张图是照它们画的，没有它们那一列点就只是一张单子，不是历史。
 */

import type { DiffFile, FileStatus, GitCommit, OpResult, RefDiff, RemoteResult } from "../api.ts";
import { readBlobs, type BlobRead } from "./blobs.ts";
import { capHunks, classify } from "./diff.ts";
import { END_OF_OPTIONS, git, MAX_FILES, run, runRemote } from "./exec.ts";
import { computeDiff } from "./line-diff.ts";
import { parseNumstat } from "./parse.ts";
import { gitBranch, isGitRepo } from "./probe.ts";
import { defaultRemote } from "./remote-state.ts";
import { say } from "./say.ts";
import { EMPTY_TREE, LOG_FORMAT } from "./status.ts";
import { fetchInView, withView, type RepoView } from "./view.ts";

export async function gitLog(cwd: string, limit = 60, ref?: string): Promise<GitCommit[]> {
	if (!(await isGitRepo(cwd))) return [];
	const out =
		(await withView(cwd, (view) =>
			view.git(["log", "--topo-order", `--max-count=${Math.min(limit, 300)}`, `--format=${LOG_FORMAT}`, ...(ref ? [END_OF_OPTIONS, ref] : [])]),
		).catch(() => null)) ?? "";
	return out
		.split("\x1e")
		.map((record) => record.replace(/^\n/, ""))
		.filter(Boolean)
		.map((record) => {
			const [sha = "", shortSha = "", subject = "", author = "", date = "", refs = "", parents = ""] = record.split("\x1f");
			return {
				sha,
				shortSha,
				subject,
				parents: parents.split(" ").filter(Boolean),
				author,
				date,
				refs: refs
					.split(", ")
					.map((name) => name.replace(/^HEAD -> /, "").trim())
					.filter((name) => name && name !== "HEAD"),
			};
		});
}

interface NamedChange {
	path: string;
	/** 「之前」那一边在哪个路径：重命名、复制是来处，别的和 `path` 相同。 */
	source: string;
	status: FileStatus;
}

/**
 * `--name-status -z` 里改了哪些文件。得边走边读：重命名（`R`）和复制（`C`，`diff.renames=copies` 时出现）占三个记号——
 * 来处、去处，别的占两个。复制出来的是一个新路径，按新增列；内容的「之前」仍是来处，和 `--numstat` 数的一致。
 */
function parseNameStatus(names: string): NamedChange[] {
	const wanted: NamedChange[] = [];
	const tokens = names.split("\0").filter(Boolean);
	for (let i = 0; i < tokens.length && wanted.length < MAX_FILES; i++) {
		const code = tokens[i] as string;
		if (!/^[A-Z]/.test(code)) continue;
		const twoPaths = /^[RC]/.test(code);
		const source = tokens[i + 1];
		const path = tokens[twoPaths ? i + 2 : i + 1];
		i += twoPaths ? 2 : 1;
		if (!path || !source) continue;
		wanted.push({ path, source, status: code.startsWith("C") ? "added" : classify(code[0] ?? "") });
	}
	return wanted;
}

/**
 * 只有文件列表：改了什么、各多少行，一个字都不读。`diffRefs` 要读每个文件的两边再逐个比，大提交上慢一个数量级；
 * 面板先拿这个列出来，内容随后到，不会先显示占位再从它的高度跳到真实高度。行数来自 `--numstat`，git 报二进制
 * 的文件标出来，不硬写一个数。
 */
async function diffSummary(view: RepoView, base: string, head: string): Promise<{ files: DiffFile[] }> {
	const [names, stats] = await Promise.all([
		view.git(["diff", "--name-status", "-z", END_OF_OPTIONS, base, head]).catch(() => ""),
		view.git(["diff", "--numstat", "-z", END_OF_OPTIONS, base, head]).catch(() => ""),
	]);
	const numbers = parseNumstat(stats);
	const files = parseNameStatus(names).map(({ path, status }): DiffFile => {
		const count = numbers.get(path);
		return { path, status, added: count?.added ?? 0, removed: count?.removed ?? 0, hunks: [], binary: count?.binary ?? false };
	});
	return { files };
}

async function parentOf(view: RepoView, sha: string): Promise<string> {
	return view
		.git(["rev-parse", "--verify", `${sha}^`])
		.then((out) => out.trim())
		.catch(() => EMPTY_TREE);
}

/** 一个提交的文件列表，不带内容。和 `commitDiff` 配对。 */
export async function commitDiffSummary(cwd: string, sha: string): Promise<{ files: DiffFile[] }> {
	if (!(await isGitRepo(cwd))) return { files: [] };
	return (await withView(cwd, async (view) => diffSummary(view, await parentOf(view, sha), sha)).catch(() => null)) ?? { files: [] };
}

/**
 * 历史上任意两点的差别。一个提交改了什么、两个分支差多少、暂存了什么，对 git 是同一个问题换了端点；
 * `head` 为空表示暂存区，暂存视图的内容就这么来。
 */
export async function diffRefs(cwd: string, base: string, head: string | null): Promise<RefDiff> {
	const empty: RefDiff = { files: [], added: 0, removed: 0 };
	if (!(await isGitRepo(cwd))) return empty;
	return (await withView(cwd, (view) => diffRefsIn(view, base, head)).catch(() => null)) ?? empty;
}

async function diffRefsIn(view: RepoView, base: string, head: string | null): Promise<RefDiff> {
	const range = head ? [END_OF_OPTIONS, base, head] : ["--cached", END_OF_OPTIONS, base];
	const names = await view.git(["diff", "--name-status", "-z", ...range]).catch(() => "");
	const wanted = parseNameStatus(names);

	// 两边各一批：「之前」是比较的起点（改了名的读来处），「之后」是另一个引用，没有就是暂存区（`:path`）。空串表示没有这一边。
	const befores = await readBlobs(
		view,
		wanted.map(({ path, source, status }) => (status === "added" && source === path ? "" : `${head ? base : "HEAD"}:${source}`)),
	);
	const afters = await readBlobs(
		view,
		wanted.map(({ path, status }) => (status === "deleted" ? "" : head ? `${head}:${path}` : `:${path}`)),
	);

	const files: DiffFile[] = [];
	let added = 0;
	let removed = 0;
	wanted.forEach(({ path, source, status }, i) => {
		const before = sideOf(befores[i] ?? null, status === "added" && source === path);
		const after = sideOf(afters[i] ?? null, status === "deleted");
		// 太大不比的整个丢掉，不报一半。
		if (before === null || after === null) return;
		// 和工作区的 diff 一样：二进制照样列出来、标上，没有 hunk，不把 PNG 头当几行文字比。
		if (before.binary || after.binary) {
			files.push({ path, status, added: 0, removed: 0, hunks: [], binary: true, bytes: after.bytes || before.bytes });
			return;
		}
		// 行数从 diff 本身数，总数和画出来的 hunk 永远对得上。
		const diff = computeDiff(before.text, after.text);
		added += diff.added;
		removed += diff.removed;
		files.push({ path, status, added: diff.added, removed: diff.removed, hunks: capHunks(diff.hunks) });
	});
	return { files, added, removed };
}

/**
 * 比较的一边：不存在是空的文字，太大是 null——前者是 diff 的一边，后者让文件从列表里拿掉。有 NUL 字节就是二进制，
 * 和 `diff.ts` 的 `sideOf`、git 自己的判断一样。
 */
function sideOf(read: BlobRead | null, absent: boolean): { text: string; binary: boolean; bytes: number } | null {
	if (absent || !read) return { text: "", binary: false, bytes: 0 };
	if (!read.content) return null;
	const binary = read.content.includes(0);
	return { text: binary ? "" : read.content.toString("utf8"), binary, bytes: read.content.length };
}

/** 一个提交自己的 diff：对父提交，第一个提交对空树。 */
export async function commitDiff(cwd: string, sha: string): Promise<RefDiff> {
	const empty: RefDiff = { files: [], added: 0, removed: 0 };
	if (!(await isGitRepo(cwd))) return empty;
	return (await withView(cwd, async (view) => diffRefsIn(view, await parentOf(view, sha), sha)).catch(() => null)) ?? empty;
}

export async function createBranch(cwd: string, name: string, from?: string): Promise<OpResult> {
	const clean = name.trim();
	if (!clean) return { ok: false, error: say().branchNameEmpty };
	return run(cwd, ["switch", "-c", clean, ...(from ? [END_OF_OPTIONS, from] : [])]);
}

export async function deleteBranch(cwd: string, name: string, force = false): Promise<OpResult> {
	return run(cwd, ["branch", force ? "-D" : "-d", END_OF_OPTIONS, name]);
}

/**
 * 每种远端调用最多等多久。后台悄悄的获取绝不能被感觉到，很快放弃；人按了按钮的获取可以慢，他看着、能取消；
 * 推送、拉取在大仓库上可能要几分钟，上限只是不让一个永不回答的主机把面板一直占着。
 */
const QUIET_FETCH_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 20_000;
const PUSH_PULL_TIMEOUT_MS = 120_000;

async function remoteNames(cwd: string): Promise<string[]> {
	const out = await git(cwd, ["remote"]).catch(() => "");
	return out
		.split("\n")
		.map((name) => name.trim())
		.filter(Boolean);
}

export async function pushBranch(cwd: string, { signal }: { signal?: AbortSignal } = {}): Promise<RemoteResult> {
	// `gitBranch` 是 `symbolic-ref`：游离时为空，不会推出 `push -u origin HEAD`。
	const branch = await gitBranch(cwd);
	if (!branch) return { ok: false, error: say().notOnBranch };

	// 第一次推送带 `-u`，让分支有上游，而不是因为没有上游失败。
	const hasUpstream = await git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"])
		.then(() => true)
		.catch(() => false);
	if (hasUpstream) return runRemote(cwd, ["push"], { timeoutMs: PUSH_PULL_TIMEOUT_MS, signal });

	// 不写死 origin：远端叫别的名字的仓库会直接失败，报的是一个不存在的远端。
	const remotes = await remoteNames(cwd);
	const remote = defaultRemote(remotes);
	if (!remote) return { ok: false, error: remotes.length === 0 ? say().noRemote : say().manyRemotes };
	return runRemote(cwd, ["push", "-u", END_OF_OPTIONS, remote, branch], { timeoutMs: PUSH_PULL_TIMEOUT_MS, signal });
}

/** `--ff-only`：合并提交、更别说冲突，不该从一个按钮开始。 */
export async function pullBranch(cwd: string, { signal }: { signal?: AbortSignal } = {}): Promise<RemoteResult> {
	return runRemote(cwd, ["pull", "--ff-only"], { timeoutMs: PUSH_PULL_TIMEOUT_MS, signal });
}

/**
 * 问远端现在有什么，让 ahead / behind 说的是现在。没有远端时直接说成功、什么都不跑：`git fetch` 在那里什么都不做
 * 也返回 0，报成「刷新成功」会让人以为屏幕上的数刚被确认过。
 * `quiet` 是面板自己发起的那种（没人点）：在视图里获取，不执行仓库配置里的程序，见 `view.ts`。
 */
export async function fetchRemotes(cwd: string, { signal, quiet = false }: { signal?: AbortSignal; quiet?: boolean } = {}): Promise<RemoteResult> {
	const remotes = await remoteNames(cwd);
	if (remotes.length === 0) return { ok: true };
	if (quiet) return fetchInView(cwd, { signal, timeoutMs: QUIET_FETCH_TIMEOUT_MS });
	return runRemote(cwd, ["fetch", "--prune"], { timeoutMs: FETCH_TIMEOUT_MS, signal });
}

/** 提交暂存了的：正是面板显示为已暂存的那些。 */
export async function commitStaged(cwd: string, message: string): Promise<OpResult> {
	const trimmed = message.trim();
	if (!trimmed) return { ok: false, error: say().messageEmpty };
	const staged = await git(cwd, ["diff", "--cached", "--name-only"]).catch(() => "");
	if (!staged.trim()) return { ok: false, error: say().nothingStaged };
	return run(cwd, ["commit", "-m", trimmed]);
}
