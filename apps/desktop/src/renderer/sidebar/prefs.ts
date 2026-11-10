/**
 * 侧栏的显示偏好：会话全归档了的项目收不收起（见 `grouping.ts`）。只在界面里生效，记在 localStorage 里，和转录的显示偏好一样。
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

export function useHideEmptiedProjects(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current,
	);
}
