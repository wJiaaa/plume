import { createContext, useEffect, useSyncExternalStore } from "react";

/**
 * 哪些子会话的卡由它自己的视图画（`ConversationProps.approvals: "here"`，视图在屏上）：主输入框上方就不再压一张。
 * 视图不在屏上时撤掉认领，卡回到主输入框上方。只管这一个窗口：弹到独立窗口的视图认领不到主窗口，两边各一张，谁先答算谁的。
 */

/** 视图此刻在不在屏上：面板按 `PanelProps.shown` 给，不在面板里的视图（页面）算在屏上。 */
export const ViewShown = createContext(true);

// 按次数记：同一个会话的视图换位置（弹出、收回）时新的先挂上、旧的后卸掉，只记有没有会把新的认领一起撤掉。
const counts = new Map<string, number>();
let claimed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(): void {
	claimed = new Set(counts.keys());
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 挂着期间认领这个会话的卡；不给就什么都不认领。 */
export function useApprovalClaim(sessionId: string | undefined): void {
	useEffect(() => {
		if (!sessionId) return;
		counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
		publish();
		return () => {
			const left = (counts.get(sessionId) ?? 1) - 1;
			if (left > 0) counts.set(sessionId, left);
			else counts.delete(sessionId);
			publish();
		};
	}, [sessionId]);
}

/** 此刻由自己的视图画卡的子会话。 */
export function useClaimedApprovals(): ReadonlySet<string> {
	return useSyncExternalStore(subscribe, () => claimed);
}
