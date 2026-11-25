import { useSyncExternalStore } from "react";

/**
 * 面板经 `PanelProps.setSessions` 说的、每个标签替哪些会话说话，标签上的等待点按它们画。
 * 只在内存里，不随标签保存：说的是此刻在跑的会话，重开应用后面板会重新说。
 */

const sessionsByTab = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
const NO_SESSIONS: readonly string[] = [];

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 换掉这个标签的那一组；和原来一样时不惊动谁。给空数组就是拿掉（标签关掉时也这样清）。 */
export function setTabSessions(tabId: string, sessionIds: readonly string[]): void {
	const before = sessionsByTab.get(tabId) ?? NO_SESSIONS;
	if (before.length === sessionIds.length && before.every((sessionId, index) => sessionId === sessionIds[index])) return;
	if (sessionIds.length > 0) sessionsByTab.set(tabId, [...sessionIds]);
	else sessionsByTab.delete(tabId);
	for (const listener of listeners) listener();
}

export function useTabSessions(tabId: string): readonly string[] {
	return useSyncExternalStore(subscribe, () => sessionsByTab.get(tabId) ?? NO_SESSIONS);
}
