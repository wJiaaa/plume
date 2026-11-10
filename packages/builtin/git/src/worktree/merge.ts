/**
 * 把对话的工作树合回它切出来的分支，把那个分支的新提交带进工作树。
 *
 * 两样都宁可拒绝也不猜：有没提交的改动、已经有一次合并在进行、基分支检出在别的工作树里。合回去有冲突立刻退回，
 * 人工作的检出里从不留半截合并，冲突连同文件报回去，对话可以先同步、在自己的工作树里解决，再干净地合。
 * 同步的冲突留在工作树里，那里正是该解决它的地方。都不推送。
 */

import { existsSync } from "node:fs";
import { END_OF_OPTIONS, git, run } from "../git/exec.ts";
import { samePath } from "../git/paths.ts";
import { worktreeRecords } from "../git/probe.ts";
import type { MergeOutcome, SessionWorktree, SyncOutcome } from "./api.ts";
import { baseOf, conflictedFiles, countCommits, isMerging, repoRoot, uncommittedFiles } from "./lifecycle.ts";

type Located = { repo: string; root: string | null; base: string; branch: string };
type Refused = Extract<MergeOutcome, { kind: "refused" }>;

/** 仓库、基分支、工作树的目录——收走了时是 null。 */
async function locate(tree: SessionWorktree): Promise<Located | Refused> {
	const repo = await repoRoot(tree.project);
	if (!repo) return { kind: "refused", reason: "gone" };
	const base = await baseOf(repo, tree.base);
	if (!base) return { kind: "refused", reason: "no-base" };
	return { repo, root: existsSync(tree.root) ? tree.root : null, base, branch: tree.branch };
}

/** 哪个检出（含主检出）检出着 `branch`；没有时是 null。 */
async function checkedOutAt(repo: string, branch: string): Promise<string | null> {
	return (await worktreeRecords(repo)).find((tree) => tree.branch === branch)?.path ?? null;
}

export async function mergeIntoBase(tree: SessionWorktree): Promise<MergeOutcome> {
	const at = await locate(tree);
	if ("kind" in at) return at;
	const { repo, root, base, branch } = at;
	// 收走了的照样能合：提交在分支上，而有改动的目录从不收走。
	if (root) {
		const files = (await uncommittedFiles(root)).length;
		if (files > 0) return { kind: "uncommitted", files };
		if (await isMerging(root)) return { kind: "refused", reason: "syncing" };
	}
	const commits = await countCommits(repo, `${base}..${branch}`);
	if (commits === 0) return { kind: "nothing", base };
	// i18n-exempt：写进提交历史的话，和 git 自己写的一样用英文。
	const message = `Merge branch '${branch}'`;
	const holder = await checkedOutAt(repo, base);
	if (holder === null) return mergeUnchecked(repo, base, branch, message, commits);
	// 检出在另一个工作树里：挪动它会让那个目录的文件落在自己的 HEAD 后面。
	if (!samePath(holder, repo)) return { kind: "refused", reason: "elsewhere", detail: holder };
	return mergeInCheckout(repo, base, branch, message, commits);
}

/** 基分支检出在项目目录里：在那里合，目录里的文件跟着走。任何失败（冲突也是）都退回。 */
async function mergeInCheckout(repo: string, base: string, branch: string, message: string, commits: number): Promise<MergeOutcome> {
	if (await isMerging(repo)) return { kind: "refused", reason: "busy" };
	const done = await run(repo, ["merge", "--no-ff", "--no-edit", "-m", message, END_OF_OPTIONS, branch]);
	if (done.ok) return { kind: "merged", commits, base };
	const conflicted = await conflictedFiles(repo);
	if (await isMerging(repo)) await run(repo, ["merge", "--abort"]);
	return conflicted.length > 0
		? { kind: "conflict", files: conflicted, base }
		: { kind: "refused", reason: "failed", ...(done.error ? { detail: done.error } : {}) };
}

/**
 * 基分支哪里都没检出：不用改任何目录里的文件。算出合并的结果（`merge-tree`）、提交、挪分支——`git merge` 的那几步，
 * 少了写没人开着的文件。挪的时候带上旧值，中间有新提交落进来就失败，而不是把它盖掉。
 */
async function mergeUnchecked(repo: string, base: string, branch: string, message: string, commits: number): Promise<MergeOutcome> {
	const result = await git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", END_OF_OPTIONS, base, branch]).then(
		(text) => ({ clean: true, text, code: 0 }),
		(error: { stdout?: string; code?: number }) => ({ clean: false, text: String(error.stdout ?? ""), code: error.code ?? -1 }),
	);
	const lines = result.text.trim().split("\n");
	if (!result.clean) {
		// 退出码 1 是冲突：第一行是树，后面是文件。别的是 git 自己失败了。
		if (result.code === 1 && lines.length > 1) return { kind: "conflict", files: [...new Set(lines.slice(1).filter(Boolean))], base };
		return { kind: "refused", reason: "failed", detail: result.text.trim() || "git merge-tree" };
	}
	const [tree] = lines;
	const baseTip = await git(repo, ["rev-parse", `refs/heads/${base}`]).then(
		(text) => text.trim(),
		() => "",
	);
	const branchTip = await git(repo, ["rev-parse", `refs/heads/${branch}`]).then(
		(text) => text.trim(),
		() => "",
	);
	const commit =
		tree && baseTip && branchTip
			? await git(repo, ["commit-tree", tree, "-p", baseTip, "-p", branchTip, "-m", message]).then(
					(text) => text.trim(),
					() => "",
				)
			: "";
	if (!commit) return { kind: "refused", reason: "failed", detail: "git commit-tree" };
	const moved = await run(repo, ["update-ref", `refs/heads/${base}`, commit, baseTip]);
	return moved.ok ? { kind: "merged", commits, base } : { kind: "refused", reason: "failed", ...(moved.error ? { detail: moved.error } : {}) };
}

/** 基分支的新提交以一次合并带进工作树。冲突留着等在那里干活的人（这个对话或者人）解决、提交；`abortSync` 退回。 */
export async function syncFromBase(tree: SessionWorktree): Promise<SyncOutcome> {
	const at = await locate(tree);
	if ("kind" in at) return at;
	const { repo, root, base, branch } = at;
	// 同步要往目录里写，得有目录。
	if (!root) return { kind: "refused", reason: "gone" };
	if (await isMerging(root)) return { kind: "conflict", files: await conflictedFiles(root), base };
	const files = (await uncommittedFiles(root)).length;
	if (files > 0) return { kind: "uncommitted", files };
	const commits = await countCommits(repo, `${branch}..${base}`);
	if (commits === 0) return { kind: "up-to-date", base };
	const done = await run(root, ["merge", "--no-edit", END_OF_OPTIONS, base]);
	if (done.ok) return { kind: "synced", commits, base };
	const conflicted = await conflictedFiles(root);
	if (conflicted.length > 0) return { kind: "conflict", files: conflicted, base };
	if (await isMerging(root)) await run(root, ["merge", "--abort"]);
	return { kind: "refused", reason: "failed", ...(done.error ? { detail: done.error } : {}) };
}

/** 退回停在冲突上的同步。没什么在等时也是 true。 */
export async function abortSync(tree: SessionWorktree): Promise<boolean> {
	if (!existsSync(tree.root) || !(await isMerging(tree.root))) return true;
	return (await run(tree.root, ["merge", "--abort"])).ok;
}
