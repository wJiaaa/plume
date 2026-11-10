/**
 * 工作区里的仓库，仓库里的工作树。
 *
 * 一个文件夹下放着三个检出，是一个工作区里的三个仓库，不是三个工作区。找它们是有界的遍历：深层的 node_modules 不值那几秒。
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { OpResult, RepoRef } from "../api.ts";
import { git } from "./exec.ts";
import { canonicalPath } from "./paths.ts";
import { gitBranch, isGitRepo, worktreeRecords } from "./probe.ts";

/** 找仓库时从不进去的目录。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", "target", "vendor", ".next", ".venv"]);

/**
 * 工作区下的每一个仓库，不只是工作区本身：前端后端、分开版本管理的几个服务常常放在一起，只认根目录就看不见其余的。
 * 往下两层，够覆盖常见的布局（`~/work/*`、`repo/*`），又不会把整个家目录走一遍。
 */
export async function listRepos(root: string): Promise<RepoRef[]> {
	const found: RepoRef[] = [];
	if (await isGitRepo(root)) found.push({ path: root, label: basename(root), branch: await gitBranch(root), worktree: false });

	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > 2 || found.length >= 24) return;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
			const child = join(dir, entry.name);
			// `.git` 可以是目录（普通克隆），也可以是文件（链接的工作树）。
			const isRepo = await stat(join(child, ".git"))
				.then(() => true)
				.catch(() => false);
			if (isRepo) {
				if (!found.some((repo) => repo.path === child)) {
					found.push({ path: child, label: relative(root, child) || basename(child), branch: await gitBranch(child), worktree: false });
				}
				// 仓库自己的子目录是它的事。
				continue;
			}
			await walk(child, depth + 1);
		}
	};
	await walk(root, 1);
	return found;
}

/**
 * 挂在一个仓库上的工作树：同一份历史的第二个检出，在另一个分支上。面板把它们当作可以切过去的地方，
 * 不当作另外的仓库。第一条是主检出，其余是链接的。
 */
export async function listWorktrees(cwd: string): Promise<RepoRef[]> {
	if (!(await isGitRepo(cwd))) return [];
	return (await worktreeRecords(cwd)).map((tree, index) => {
		const at = canonicalPath(tree.path);
		return { path: at, label: basename(at), branch: tree.branch, worktree: index > 0 };
	});
}

/**
 * 把一个普通目录变成仓库。面板常常看着一个刚建出来的项目，「不是仓库」有明显的下一步。不提交：第一个提交是个决定，面板就在旁边。
 */
export async function initRepo(cwd: string): Promise<OpResult> {
	if (await isGitRepo(cwd)) return { ok: true };
	try {
		await git(cwd, ["init"]);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
