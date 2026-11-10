/**
 * 分支：给切换菜单列出来，以及在它们之间切换。
 */

import type { BranchList, OpResult } from "../api.ts";
import { END_OF_OPTIONS, git } from "./exec.ts";
import { gitBranch, isGitRepo } from "./probe.ts";
import { say } from "./say.ts";

/** 本地和远端分支。 */
export async function listBranches(cwd: string): Promise<BranchList> {
	if (!(await isGitRepo(cwd))) return { current: null, local: [], remote: [] };

	const [current, refs] = await Promise.all([
		gitBranch(cwd),
		/*
		 * 要完整的引用路径，不要短名：短名分不清。`refs/remotes/origin/HEAD` 短成没有斜杠的 `origin`，按「有没有斜杠」
		 * 就被当成本地分支；本地分支又常叫 `feat/xxx`，有斜杠被当成远端。前缀说得一清二楚。
		 */
		git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).catch(() => ""),
	]);

	const local: string[] = [];
	const remote: string[] = [];
	for (const line of refs.split("\n")) {
		const ref = line.trim();
		if (!ref) continue;
		if (ref.startsWith("refs/heads/")) local.push(ref.slice("refs/heads/".length));
		else if (ref.startsWith("refs/remotes/")) {
			const name = ref.slice("refs/remotes/".length);
			// `origin/HEAD` 是个符号指针，不是能检出的地方。
			if (name.endsWith("/HEAD")) continue;
			remote.push(name);
		}
	}
	const known = new Set(local);
	return {
		current,
		local: local.sort(),
		// 本地已有同名分支的远端分支，检出的就是本地那个。
		remote: remote.filter((r) => !known.has(r.split("/").slice(1).join("/"))).sort(),
	};
}

/**
 * 切分支，宁可拒绝也不覆盖。没提交的改动会被覆盖时 `git switch` 自己会停，它说的比这一层编的有用，原样交给人。
 * 远端分支不是能站的地方：切到它就是建一个跟踪它的本地分支（`--track`）。是不是本地分支靠查，不靠数斜杠。
 */
export async function switchBranch(cwd: string, branch: string): Promise<OpResult> {
	try {
		const isLocal = await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
			.then(() => true)
			.catch(() => false);
		await git(cwd, isLocal ? ["switch", END_OF_OPTIONS, branch] : ["switch", "--track", END_OF_OPTIONS, branch]);
		return { ok: true };
	} catch (cause) {
		const message = cause instanceof Error && "stderr" in cause ? String(cause.stderr) : String(cause);
		return { ok: false, error: message.trim() || say().switchFailed };
	}
}
