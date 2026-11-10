/**
 * 两次读到的 `git status` 是不是同一个答案。
 *
 * 一轮运行中面板每 1.5 秒读一次，每次都是新对象；按对象身份走的下游（尤其是改动视图重读整个 diff 的 effect）
 * 就每次都重跑。那个读比间隔还慢，面板永远在排自己的队。按内容比，没变时留住原来的对象，下游就不动。
 */

import type { GitStatus, GitStatusFile } from "../api.ts";

function sameFiles(a: GitStatusFile[], b: GitStatusFile[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((file, i) => {
		const other = b[i];
		return (
			other !== undefined &&
			file.path === other.path &&
			file.status === other.status &&
			file.added === other.added &&
			file.removed === other.removed &&
			file.staged === other.staged &&
			file.unstaged === other.unstaged
		);
	});
}

export function sameStatus(a: GitStatus | null, b: GitStatus | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.branch === b.branch &&
		a.upstream === b.upstream &&
		a.ahead === b.ahead &&
		a.behind === b.behind &&
		// 和远端的关系变了而一个文件都没动（刚发布完分支），也要算变了，否则面板一直提议「发布分支」。
		a.remoteState === b.remoteState &&
		a.remote === b.remote &&
		a.operation === b.operation &&
		a.unpushed === b.unpushed &&
		a.head === b.head &&
		sameFiles(a.staged, b.staged) &&
		sameFiles(a.unstaged, b.unstaged)
	);
}
