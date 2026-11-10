import { useSyncExternalStore } from "react";

/** 主进程推送独立窗口中的会话，侧栏将这些会话一起点亮。 */
let sessions: readonly string[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const sessionWindows = {
	set(ids: readonly string[]) {
		sessions = ids;
		for (const listener of listeners) listener();
	},
	use: () => useSyncExternalStore(subscribe, () => sessions),
};
