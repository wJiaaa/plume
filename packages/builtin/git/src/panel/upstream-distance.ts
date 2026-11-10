/**
 * 当前分支离上游多远：输入框上方分支签上的 `↑18 ↓2`。
 *
 * 在它可能自己变了的时候读：项目或分支换了、一轮结束（模型会提交）、窗口回到前台（终端里提交、推送过）。
 * Git 面板每次读状态都已经知道答案（提交、推送、拉取、获取之后都会读），交过来（`noteUpstream`），面板里推送完分支签当场就变，
 * 不用再问一次 git。不按定时器读：这几个时刻之间它不会动。按上次获取时的远端分支算，这里从不获取；面板打开时会悄悄获取一次。
 */

import { useCallback, useEffect, useReducer } from "react";
import type { UpstreamDistance } from "../api.ts";
import { git } from "./remote.ts";

/** 按检出和分支分开记，别的会话的签、刚切过去的分支都不显示这一份的数。 */
const known = new Map<string, UpstreamDistance | null>();
const listeners = new Set<(key: string) => void>();
const keyOf = (cwd: string, branch: string) => `${cwd}\0${branch}`;

/** 面板读到的；只有变了才叫醒分支签。 */
export function noteUpstream(cwd: string, branch: string | null, distance: UpstreamDistance | null): void {
	if (!branch) return;
	const key = keyOf(cwd, branch);
	if (known.has(key) && JSON.stringify(known.get(key)) === JSON.stringify(distance)) return;
	known.set(key, distance);
	for (const listener of listeners) listener(key);
}

export function useUpstreamDistance(cwd: string | null, branch: string | null, running: boolean): UpstreamDistance | null {
	const [, changed] = useReducer((n: number) => n + 1, 0);
	const key = cwd && branch ? keyOf(cwd, branch) : null;

	const read = useCallback(async () => {
		if (!cwd || !branch) return;
		try {
			noteUpstream(cwd, branch, await git().upstream(cwd));
		} catch {
			// 读失败说明不了距离；签上留着上次知道的。
		}
	}, [cwd, branch]);

	useEffect(() => {
		if (!key) return;
		const listener = (at: string) => {
			if (at === key) changed();
		};
		listeners.add(listener);
		return () => void listeners.delete(listener);
	}, [key]);

	// 打开、切过来、每一轮结束时。
	useEffect(() => {
		if (!running) void read();
	}, [read, running]);

	useEffect(() => {
		if (!key) return;
		const onFocus = () => void read();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [key, read]);

	return key ? (known.get(key) ?? null) : null;
}
