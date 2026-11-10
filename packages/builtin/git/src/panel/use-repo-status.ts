/**
 * 选中仓库的 `git status`：按需读，从不画在别的仓库底下。
 */

import { useCallback, useRef, useState } from "react";
import type { GitStatus } from "../api.ts";
import { git } from "./remote.ts";
import { sameStatus } from "./same-status.ts";
import { noteUpstream } from "./upstream-distance.ts";

export function useRepoStatus(cwd: string | null): {
	status: GitStatus | null;
	/** 新读一次：刚改过工作区的操作要等的是这个。 */
	read: () => Promise<void>;
	/** 同一时刻谁来问都共用一次读。 */
	refresh: () => Promise<void>;
} {
	// 状态和它描述的仓库绑在一起：换到 B 时 A 的文件不会挂在 B 底下（B 答上来之前是空，宁可加载中也不画错的）。
	const [held, setHeld] = useState<{ cwd: string; status: GitStatus } | null>(null);
	const status = held && held.cwd === cwd ? held.status : null;
	const currentCwd = useRef(cwd);
	currentCwd.current = cwd;

	// 什么都没变时留住原来的对象，见 `sameStatus`。
	const read = useCallback(async () => {
		if (!cwd) {
			setHeld(null);
			return;
		}
		let next: GitStatus;
		try {
			next = await git().status(cwd);
		} catch {
			return;
		}
		// 分支签显示的是同一个距离；面板里推送、获取之后最先知道的就是这次读。
		noteUpstream(cwd, next.branch, next.upstream ? { upstream: next.upstream, ahead: next.ahead, behind: next.behind } : null);
		// 读的时候面板已经换了仓库：答案是真的，但说的不是屏幕上那个。
		if (currentCwd.current !== cwd) return;
		setHeld((current) => (current?.cwd === cwd && sameStatus(current.status, next) ? current : { cwd, status: next }));
	}, [cwd]);

	/*
	 * 同一时刻的几次读共用一次：面板一挂上，分支监视和实时刷新同时要状态，不必起两个 `git status`。
	 * 只在同一个仓库里共用；操作用的是 `read`，它要的是自己改完之后的状态，不能拿点击时已经在路上的那次。
	 */
	const inflight = useRef<{ cwd: string | null; promise: Promise<void> } | null>(null);
	const refresh = useCallback(() => {
		if (inflight.current?.cwd === cwd) return inflight.current.promise;
		const flight = read().finally(() => {
			if (inflight.current?.promise === flight) inflight.current = null;
		});
		inflight.current = { cwd, promise: flight };
		return flight;
	}, [cwd, read]);

	return { status, read, refresh };
}
