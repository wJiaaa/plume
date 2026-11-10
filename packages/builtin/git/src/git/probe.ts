/**
 * 是不是仓库、在哪个分支：别的 git 模块动手前都要问的两件事。单独一个模块，只依赖 `exec`，谁都能引而不成环。
 */

import { git } from "./exec.ts";
import { parseWorktreeList, type WorktreeRecord } from "./parse.ts";
import { say } from "./say.ts";

/**
 * 这个目录在不在工作树里；git 不肯回答时说明为什么。
 *
 * 全吞成 false 是另一种说法：PATH 里没有 git、目录读不了、git 拒绝碰的仓库，都会让界面对一个好好的仓库说「不是 Git 仓库」，
 * 底下还挂着「初始化仓库」——在仓库里跑 `git init`。所以原因跟着回答一起回去，显示在界面上。
 * 值得分开的三种（修法各不相同）：别的用户的检出（dubious ownership）、根本没有 git（ENOENT）、git 正常地说不是（not a git repository）。
 */
export interface Probe {
	repo: boolean;
	/** git 没能回答的原因，按当前界面语言。回答了就没有。 */
	problem?: string;
}

export async function probeRepo(cwd: string): Promise<Probe> {
	try {
		return { repo: (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true" };
	} catch (error) {
		const said = String((error as { stderr?: string })?.stderr || (error as Error)?.message || error).trim();
		const first = said.split("\n")[0] ?? said;
		// 只有这一种「不是仓库」是真话。
		if (/not a git repository/i.test(said)) return { repo: false };
		if (/ENOENT/.test(said) && /spawn git/i.test(said)) return { repo: false, problem: say().noGit };
		if (/dubious ownership/i.test(said)) {
			const where = /repository at '(.+?)'/.exec(said)?.[1] ?? cwd;
			return { repo: false, problem: say().dubious(where) };
		}
		return { repo: false, problem: say().unreadable(first) };
	}
}

/** 只看答案的调用方用。 */
export async function isGitRepo(cwd: string): Promise<boolean> {
	return (await probeRepo(cwd)).repo;
}

/**
 * 检出着的分支；不在分支上时为空。
 *
 * 只用 `symbolic-ref`：`rev-parse --abbrev-ref HEAD` 在游离时返回字符串 `"HEAD"` 而不是失败，`if (!branch)` 就把
 * 「不在分支上」读成「在一个叫 HEAD 的分支上」，推送会跑成 `push -u origin HEAD` 被拒。没有提交的仓库它也答得对：
 * 没有提交可解析，但 HEAD 已经写着第一个提交要落在哪个分支。
 */
export async function gitBranch(cwd: string): Promise<string | null> {
	return git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
		.then((out) => out.trim() || null)
		.catch(() => null);
}

/** 这个仓库的每一个检出，主检出在最前；git 不说时为空。问 git 而不是看文件夹名：只有它列出来的才是工作树。 */
export async function worktreeRecords(cwd: string): Promise<WorktreeRecord[]> {
	return parseWorktreeList(await git(cwd, ["worktree", "list", "--porcelain"]).catch(() => ""));
}
