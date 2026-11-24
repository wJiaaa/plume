/**
 * 环境卡片两个 Git 分区共用的仓库状态缓存。
 *
 * 分支与 Git 操作分别登记进 `ui.environmentSection`（可在右键菜单独立开关），但看的是同一个 `cwd`：
 * 放这里按 `cwd` 合并并发读，避免同时发起两次 `git status`，并在任一行切分支、提交、推送、拉取或初始化后一起刷新。
 */

import { useLiveRefresh } from "@plume/ui";
import { useCallback, useEffect, useReducer } from "react";
import type { GitStatus } from "../api.ts";
import { noteBranch, readCheckout } from "./checkout.ts";
import { git } from "./remote.ts";
import { sameStatus } from "./same-status.ts";
import { noteUpstream } from "./upstream-distance.ts";

const statusCache = new Map<string, GitStatus>();
const statusInflight = new Map<string, Promise<void>>();
const statusListeners = new Set<(cwd: string) => void>();

function notifyListeners(cwd: string): void {
	for (const listener of statusListeners) listener(cwd);
}

function readSharedStatus(cwd: string, force = false): Promise<void> {
	if (!force) {
		const inflight = statusInflight.get(cwd);
		if (inflight) return inflight;
	}
	const flight = git()
		.status(cwd)
		.then(
			(next) => {
				noteUpstream(cwd, next.branch, next.upstream ? { upstream: next.upstream, ahead: next.ahead, behind: next.behind } : null);
				noteBranch(cwd, next.branch);
				const prev = statusCache.get(cwd) ?? null;
				if (!sameStatus(prev, next)) {
					statusCache.set(cwd, next);
					notifyListeners(cwd);
				}
			},
			() => {},
		)
		.finally(() => {
			if (statusInflight.get(cwd) === flight) statusInflight.delete(cwd);
		});
	statusInflight.set(cwd, flight);
	return flight;
}

/** 切分支、提交、推送、拉取或初始化后，让环境行与分支签一起拿到最新状态。 */
export async function refreshEnvGit(cwd: string): Promise<void> {
	await readCheckout(cwd);
	await readSharedStatus(cwd, true);
}

export function useSharedRepoStatus(cwd: string | null, enabled: boolean, running: boolean): GitStatus | null {
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (!cwd || !enabled) return;
		const listener = (at: string) => {
			if (at === cwd) rerender();
		};
		statusListeners.add(listener);
		return () => void statusListeners.delete(listener);
	}, [cwd, enabled]);

	const refresh = useCallback(() => {
		if (!cwd || !enabled) return;
		return readSharedStatus(cwd);
	}, [cwd, enabled]);

	useLiveRefresh(refresh, running);
	return cwd && enabled ? (statusCache.get(cwd) ?? null) : null;
}
