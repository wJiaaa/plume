/**
 * 一个对话自己的工作树，从建出来到收走：建、现在什么样、收回、检出回来、清掉旧的。
 *
 * 贯穿全部的一条：分支比目录活得久。工作树是分支的一个检出，提交了的东西都在分支上，目录可以收走、再原样检出回来。
 * 唯一会丢的是没提交的改动，这里没有哪一步会不经人点头丢掉它。
 */

import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { OpResult } from "../api.ts";
import { END_OF_OPTIONS, git, output, run, runRemote, succeeds } from "../git/exec.ts";
import { parseStatusZ, type WorktreeRecord } from "../git/parse.ts";
import { canonicalPath, samePath } from "../git/paths.ts";
import { worktreeRecords } from "../git/probe.ts";
import { SESSION_BRANCH_PREFIX, type SessionWorktree, type WorktreeState } from "./api.ts";
import { say } from "./say.ts";

/** 建工作树前获取上游最多等多久：网络卡住时不该让第一条消息一直发不出去。 */
const FETCH_TIMEOUT_MS = 20_000;

/** 目录所在的检出的根；不在检出里是 null。 */
export async function repoRoot(dir: string): Promise<string | null> {
	return existsSync(dir) ? (await output(dir, ["rev-parse", "--show-toplevel"])) || null : null;
}

/** 检出着的分支；游离时为空。 */
async function currentBranch(dir: string): Promise<string | null> {
	return (await output(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
}

async function branchExists(repo: string, name: string): Promise<boolean> {
	return succeeds(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
}

/**
 * 合回去、同步对着的分支：切出时记下的那个，否则是仓库的默认分支——`origin/HEAD` 指的、`main`、`master`。都不是这里的分支时为空。
 */
export async function baseOf(repo: string, recorded?: string): Promise<string | null> {
	const remote = ((await output(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])) ?? "").replace(/^origin\//, "");
	for (const name of [recorded, remote, "main", "master"]) if (name && (await branchExists(repo, name))) return name;
	return null;
}

/**
 * `range` 里干活的提交，不计合并提交。同步在工作树的分支上留一个合并提交，合回去在基分支上留一个；计进去的话，
 * 刚合完的显示「落后 1」，刚同步完的两个提交显示「领先 3」，招人去做一次什么都没有的同步或合并。
 */
export async function countCommits(repo: string, range: string): Promise<number> {
	return Number((await output(repo, ["rev-list", "--count", "--no-merges", END_OF_OPTIONS, range])) ?? 0) || 0;
}

/** 改过的和没跟踪的文件。忽略的不是谁做的改动，不算。 */
export async function uncommittedFiles(dir: string): Promise<string[]> {
	return parseStatusZ(await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => "")).entries.map((entry) => entry.path);
}

export async function isMerging(dir: string): Promise<boolean> {
	return succeeds(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
}

export async function conflictedFiles(dir: string): Promise<string[]> {
	return (await git(dir, ["diff", "--name-only", "--diff-filter=U", "-z"]).catch(() => "")).split("\0").filter(Boolean);
}

/**
 * 给一个对话开它自己的工作树：`plume/session-<id>` 分支，从项目现在的 HEAD 切出，放在 `root` 下面。
 *
 * 项目是仓库的一个子目录（一个包）时，对话落在工作树里的同一个子目录；那个子目录没提交过（副本里没有）就落在工作树根。
 * 建不成时给出 git 的原话：对话照样在项目里跑，要了副本的人得知道没拿到。
 */
export async function createSessionWorktree(
	project: string,
	sessionId: string,
	options: { root: string; fetchFirst: boolean },
): Promise<{ worktree: SessionWorktree } | { error: string }> {
	const repo = await repoRoot(project);
	if (!repo) return { error: say().notARepo };
	const id = sessionId.slice(0, 8);
	const branch = `${SESSION_BRANCH_PREFIX}${id}`;
	const target = join(options.root, `${basename(repo) || "repo"}-${id}`);
	// 从哪切出来的，合回去才有去处；游离 HEAD 时没有。
	const base = (await currentBranch(project)) ?? undefined;
	// 获取失败（离线、没凭据）不挡着建工作树。
	if (options.fetchFirst) await runRemote(project, ["fetch", "--all", "--prune"], { timeoutMs: FETCH_TIMEOUT_MS });
	try {
		await mkdir(dirname(target), { recursive: true });
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	// `-B`：同名分支留着（同一个 id 前缀的旧会话）时重置它，而不是失败。
	const added = await run(project, ["worktree", "add", "-B", branch, END_OF_OPTIONS, target]);
	if (!added.ok) return { error: added.error ?? say().createFailed };
	// git 列出来的写法：之后拿它和 `git worktree list` 比，比不上的写法会让清理删掉正在用的那棵。
	const root = canonicalPath(target);
	const inside = relative(canonicalPath(repo), canonicalPath(project));
	const nested = inside && !inside.startsWith("..") && !isAbsolute(inside) ? join(root, inside) : null;
	const cwd = nested && existsSync(nested) ? nested : root;
	return { worktree: { project, root, cwd, branch, ...(base ? { base } : {}) } };
}

export async function worktreeState(tree: SessionWorktree): Promise<WorktreeState | null> {
	const repo = await repoRoot(tree.project);
	if (!repo) return null;
	const present = existsSync(tree.root);
	const base = await baseOf(repo, tree.base);
	const counted = base !== null && (await branchExists(repo, tree.branch));
	const merging = present ? await isMerging(tree.root) : false;
	return {
		branch: tree.branch,
		base,
		present,
		ahead: counted ? await countCommits(repo, `${base}..${tree.branch}`) : 0,
		behind: counted ? await countCommits(repo, `${tree.branch}..${base}`) : 0,
		uncommitted: present ? (await uncommittedFiles(tree.root)).length : 0,
		merging,
		conflicted: merging ? await conflictedFiles(tree.root) : [],
	};
}

/** `root` 是不是 `repo` 的一棵链接工作树。主检出从不算：`git worktree list` 把它列在第一个。 */
async function isWorktreeOf(repo: string, root: string): Promise<boolean> {
	if (samePath(repo, root)) return false;
	return (await worktreeRecords(repo)).slice(1).some((tree) => samePath(tree.path, root));
}

/**
 * 删一棵链接工作树，所有删除都走这里：收回、自动清理、设置页里的删除。
 *
 * 不带 `force` 时 git 拒绝有改动的那棵，拒绝原样报回来；`force` 只给人点过头要丢掉的。手动删掉的目录 `remove` 会失败而
 * git 还登记着它，`prune` 清掉登记。这里自己从不删目录：主检出也在 git 会拒绝的那些里面。
 */
export async function removeLinkedWorktree(repo: string, root: string, force = false): Promise<OpResult> {
	if (!(await isWorktreeOf(repo, root))) return { ok: false, error: say().notLinkedWorktree };
	const removed = await run(repo, ["worktree", "remove", ...(force ? ["--force"] : []), root]);
	if (!removed.ok && existsSync(root)) {
		const changes = force ? [] : await uncommittedFiles(root);
		return changes.length > 0 ? { ok: false, error: say().worktreeDirty(changes.length) } : removed;
	}
	await run(repo, ["worktree", "prune"]);
	return { ok: true };
}

export interface Reclaimed {
	removed: boolean;
	/** 留下了：里面有没提交的改动。 */
	kept?: "uncommitted";
	/** 分支也删了：上面的提交都已经在基分支里。 */
	branchDropped?: boolean;
}

/**
 * 收回一个对话的工作树：目录收走，分支留着，提交都还在，之后能原样检出回来（`restoreWorktree`）。有没提交的改动就不收。
 * `dropMergedBranch` 在分支上的提交全在基分支里时把分支也删掉，删了什么都不丢。
 */
export async function reclaimWorktree(tree: SessionWorktree, options: { dropMergedBranch?: boolean } = {}): Promise<Reclaimed> {
	const repo = await repoRoot(tree.project);
	if (!repo) return { removed: false };
	let removed = false;
	if (existsSync(tree.root)) {
		if (!(await isWorktreeOf(repo, tree.root))) return { removed: false };
		if ((await uncommittedFiles(tree.root)).length > 0 || (await isMerging(tree.root))) return { removed: false, kept: "uncommitted" };
		removed = (await removeLinkedWorktree(repo, tree.root)).ok;
		if (!removed) return { removed: false };
	}
	let branchDropped = false;
	if (options.dropMergedBranch && (await branchExists(repo, tree.branch))) {
		const base = await baseOf(repo, tree.base);
		if (base && base !== tree.branch && (await succeeds(repo, ["merge-base", "--is-ancestor", END_OF_OPTIONS, tree.branch, base]))) {
			branchDropped = (await run(repo, ["branch", "-D", END_OF_OPTIONS, tree.branch])).ok;
		}
	}
	return { removed, branchDropped };
}

export type Restored = { ok: true; fresh: boolean } | { ok: false; error: string };

/**
 * 在原来的地方把工作树检出回来：分支在就从分支，不在就从基分支新切（`fresh`），分支只在提交都进了基分支之后才删，所以不丢东西。
 * 原来的路径而不是今天的设置：对话自己的历史按绝对路径提到文件，模型接着那段历史往下做。
 */
export async function restoreWorktree(tree: SessionWorktree): Promise<Restored> {
	const repo = await repoRoot(tree.project);
	if (!repo) return { ok: false, error: say().projectNotARepo(tree.project) };
	// 手动删掉的目录留着登记，git 不肯在上面再加一棵。
	await run(repo, ["worktree", "prune"]);
	if (await branchExists(repo, tree.branch)) {
		const done = await run(repo, ["worktree", "add", END_OF_OPTIONS, tree.root, tree.branch]);
		return done.ok ? { ok: true, fresh: false } : { ok: false, error: done.error ?? "git worktree add" };
	}
	const base = await baseOf(repo, tree.base);
	if (!base) return { ok: false, error: say().noBase };
	const done = await run(repo, ["worktree", "add", "-b", tree.branch, END_OF_OPTIONS, tree.root, base]);
	return done.ok ? { ok: true, fresh: true } : { ok: false, error: done.error ?? "git worktree add" };
}

/**
 * 插件建的工作树超过 `keepLimit` 时腾地方，旧的先走。
 *
 * 只认插件自己的（`plume/session-` 分支上的链接工作树），其中只收能收的：没有未归档的对话在用（`inUse` 是它们的工作目录）、
 * 没有没提交的改动、从不 `--force`。分支留着，对话回来时检出回来。
 */
export async function cleanOldWorktrees(repoCwd: string, keepLimit: number, inUse: readonly string[]): Promise<number> {
	const repo = await repoRoot(repoCwd);
	if (!repo) return 0;
	const ours = (await worktreeRecords(repo))
		.slice(1)
		.filter((tree) => tree.branch?.startsWith(SESSION_BRANCH_PREFIX))
		.map((tree) => tree.path);
	const limit = Math.max(1, keepLimit);
	if (ours.length <= limit) return 0;
	// 对话的目录可以是工作树里的一个子目录，所以「在用」是在它里面或就是它。
	const using = inUse.map((cwd) => canonicalPath(cwd));
	const held = (tree: string) => {
		const root = canonicalPath(tree);
		return using.some((cwd) => {
			const inside = relative(root, cwd);
			return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
		});
	};
	const aged = await Promise.all(
		ours.map(async (path) => ({
			path,
			mtime: await stat(path).then(
				(entry) => entry.mtimeMs,
				() => 0,
			),
		})),
	);
	aged.sort((a, b) => a.mtime - b.mtime);
	let cleaned = 0;
	for (const tree of aged) {
		if (cleaned >= ours.length - limit) break;
		if (!held(tree.path) && (await removeLinkedWorktree(repo, tree.path)).ok) cleaned++;
	}
	return cleaned;
}

/** 设置页列的：这个目录的仓库上挂着的链接工作树。 */
export async function linkedWorktrees(dir: string): Promise<WorktreeRecord[]> {
	if (!(await repoRoot(dir))) return [];
	return (await worktreeRecords(dir)).slice(1).map((tree) => ({ ...tree, path: canonicalPath(tree.path) }));
}
