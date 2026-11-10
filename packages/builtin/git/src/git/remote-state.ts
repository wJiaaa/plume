/**
 * 这个检出和远端是什么关系。
 *
 * 只看 `git status` 那一行的 ahead / behind 不够：没有上游时那一行不带这两个数，从没推过的分支报 `ahead: 0`，
 * 读起来就是「已同步」——说的是一个提交全在本地的仓库。所以这里认清是哪一种情况。写成纯函数：
 * 有意思的几种（变基到一半、远端不叫 origin、远端有同名分支但没跟踪）手动造很麻烦，写下来很容易。
 */

import type { GitOperation, RemoteState } from "../api.ts";

export interface RemoteStanding {
	state: RemoteState;
	/** 推送会去的远端；挑不出合理的就为空，调用方要尊重它：好几个远端又没有 origin 时，猜错比不选更糟。 */
	remote: string | null;
}

/** `## No commits yet on main`。 */
function hasNoCommits(header: string): boolean {
	return header.startsWith("No commits yet");
}

/**
 * 上游属于哪个远端。按配置的远端去比，不在第一个 `/` 处切：远端名可以带斜杠，`origin` 上的 `feature/x`
 * 和 `origin/feature` 上的 `x` 是同一个字符串，只有远端列表分得清，最长的那个才是真配置了的。
 */
export function remoteOfUpstream(upstream: string, remotes: string[]): string | null {
	let best: string | null = null;
	for (const remote of remotes) {
		if (upstream === remote || upstream.startsWith(`${remote}/`)) {
			if (!best || remote.length > best.length) best = remote;
		}
	}
	return best;
}

/** 发布一个没跟踪的分支时推到哪：只有一个就用它；好几个里有 origin 就用 origin；都不是就不选，按钮禁用。 */
export function defaultRemote(remotes: string[]): string | null {
	if (remotes.length === 0) return null;
	if (remotes.length === 1) return remotes[0] ?? null;
	return remotes.includes("origin") ? "origin" : null;
}

/**
 * 按唯一行得通的顺序分类：
 * - 半路的操作先于游离：变基全程都是游离 HEAD，反过来问每次变基都读成「不在分支上」；
 * - 没有提交先于远端：新仓库有分支名、可能也配了远端，但没东西可推，按远端分会给出一个必然失败的「发布」。
 */
export function classifyRemote({
	header,
	branch,
	upstream,
	operation,
	remotes,
}: {
	/** `## …` 去掉标记后的那一行。 */
	header: string;
	/** `symbolic-ref` 的结果，空表示不在分支上。 */
	branch: string | null;
	upstream: string | null;
	operation: GitOperation | null;
	remotes: string[];
}): RemoteStanding {
	if (operation) return { state: "in-progress", remote: null };
	if (!branch) return { state: "detached", remote: null };
	if (hasNoCommits(header)) return { state: "no-commits", remote: null };
	if (upstream) return { state: "tracking", remote: remoteOfUpstream(upstream, remotes) };
	if (remotes.length === 0) return { state: "none", remote: null };
	return { state: "no-upstream", remote: defaultRemote(remotes) };
}
