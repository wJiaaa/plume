/**
 * 侧栏的显示偏好：会话全归档了的项目收不收起（见 `grouping.ts`），哪些会话的后续会话收起来了（见 `SessionRows.tsx`）。
 * 只在界面里生效，记在 localStorage 里，和转录的显示偏好一样。
 */

import { useSyncExternalStore } from "react";

const KEY = "plume.sidebar.hideEmptiedProjects";
const listeners = new Set<() => void>();
let current = read();

function read(): boolean {
	try {
		return localStorage.getItem(KEY) === "true";
	} catch {
		return false;
	}
}

export function setHideEmptiedProjects(on: boolean): void {
	current = on;
	localStorage.setItem(KEY, String(on));
	for (const listener of listeners) listener();
}

const THREAD_FOLD = "plume.sidebar.thread.";

/** 会话 `sessionId` 的后续会话收起来了没有：只记收起的，展开是缺省。 */
export const threadFoldKey = (sessionId: string) => THREAD_FOLD + sessionId;

/** 删掉的会话（`gone` 认它）不再留收起的记录。 */
export function forgetThreadFolds(gone: (sessionId: string) => boolean): void {
	try {
		const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
		for (const key of keys) if (key?.startsWith(THREAD_FOLD) && gone(key.slice(THREAD_FOLD.length))) localStorage.removeItem(key);
	} catch {
		/* 读写不了 localStorage 时也就没有要清的。 */
	}
}

export function useHideEmptiedProjects(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current,
	);
}
