import type { Remote, UiContext } from "@plume/contract/ui";
import { useCallback, useSyncExternalStore } from "react";
import type { DeliveryApi, TurnDelivery } from "./api.ts";

interface Target {
	timestamp: number;
	path?: string;
}
type Report = Awaited<ReturnType<DeliveryApi["report"]>>;
interface Selection {
	review: Target | null;
	report: Report | null;
}
interface Snapshot {
	data: TurnDelivery | null;
	undoing: boolean;
	reporting: boolean;
}
interface Entry {
	snapshot: Snapshot;
	listeners: Set<() => void>;
	revision: number;
	read: ReturnType<Remote<DeliveryApi>["get"]> | null;
	focus: (() => void) | null;
}

/** 每次插件加载独立一份；卡片和面板按会话、轮次共读，不留下全局监听。 */
export function createDeliveryState(api: Remote<DeliveryApi>, ui: UiContext) {
	const entries = new Map<string, Entry>();
	const selections = new Map<string, Selection>();
	const reportRequests = new Map<string, number>();
	const selectionListeners = new Set<() => void>();
	const empty: Selection = { review: null, report: null };
	const entryFor = (sessionId: string, timestamp: number) => {
		const key = `${sessionId}:${timestamp}`;
		let entry = entries.get(key);
		if (!entry) {
			if (entries.size >= 32) {
				for (const [oldKey, old] of entries) {
					if (old.listeners.size || old.snapshot.undoing || old.snapshot.reporting) continue;
					entries.delete(oldKey);
					break;
				}
			}
			entry = { snapshot: { data: null, undoing: false, reporting: false }, listeners: new Set(), revision: 0, read: null, focus: null };
			entries.set(key, entry);
		}
		return entry;
	};
	const update = (entry: Entry, value: Partial<Snapshot>) => {
		entry.snapshot = { ...entry.snapshot, ...value };
		for (const listener of entry.listeners) listener();
	};
	const refresh = async (sessionId: string, timestamp: number, entry: Entry) => {
		if (entry.snapshot.undoing) return;
		const revision = ++entry.revision;
		entry.read?.cancel();
		const read = api.get(sessionId, timestamp);
		entry.read = read;
		try {
			const data = await read;
			if (entry.revision === revision) update(entry, { data });
		} catch (error) {
			if (entry.revision === revision && entry.listeners.size) ui.notify(String(error), "error");
		} finally {
			if (entry.read === read) entry.read = null;
		}
	};
	function useDelivery(sessionId: string, timestamp: number) {
		const entry = entryFor(sessionId, timestamp);
		const subscribe = useCallback(
			(listener: () => void) => {
				entry.listeners.add(listener);
				if (entry.listeners.size === 1) {
					entry.focus = () => {
						void refresh(sessionId, timestamp, entry);
					};
					window.addEventListener("focus", entry.focus);
					entry.focus();
				}
				return () => {
					entry.listeners.delete(listener);
					if (!entry.listeners.size) {
						if (entry.focus) window.removeEventListener("focus", entry.focus);
						entry.focus = null;
						++entry.revision;
						entry.read?.cancel();
						entry.read = null;
					}
				};
			},
			[entry, sessionId, timestamp],
		);
		return useSyncExternalStore(subscribe, () => entry.snapshot);
	}
	function useSelection(sessionId: string | undefined) {
		const subscribe = useCallback((listener: () => void) => {
			selectionListeners.add(listener);
			return () => {
				selectionListeners.delete(listener);
			};
		}, []);
		return useSyncExternalStore(subscribe, () => (sessionId ? (selections.get(sessionId) ?? empty) : empty));
	}
	const select = (sessionId: string, value: Partial<Selection>) => {
		selections.set(sessionId, { ...(selections.get(sessionId) ?? empty), ...value });
		for (const listener of selectionListeners) listener();
	};
	const undo = async (sessionId: string, timestamp: number, path?: string) => {
		const entry = entryFor(sessionId, timestamp);
		const files = entry.snapshot.data?.files ?? [];
		if (entry.snapshot.undoing || !files.length) return false;
		if (path ? !files.some((file) => file.path === path && file.canUndo) : !files.every((file) => file.canUndo)) return false;
		// 先到的读不能盖回撤销后的状态；锁在共享条目里，两个界面不能同时撤。
		++entry.revision;
		entry.read?.cancel();
		update(entry, { undoing: true });
		try {
			const data = await api.undo(sessionId, timestamp, path);
			update(entry, { data });
			if (!data.files.length && selections.get(sessionId)?.review?.timestamp === timestamp) {
				select(sessionId, { review: null });
				ui.closePanel("review", sessionId);
			}
			return true;
		} finally {
			update(entry, { undoing: false });
			// 失败也重查：文件可能已被外部修改，旧的 canUndo 不应继续承诺可撤。
			if (entry.listeners.size) void refresh(sessionId, timestamp, entry);
		}
	};
	const report = async (sessionId: string, timestamp: number) => {
		const entry = entryFor(sessionId, timestamp);
		if (entry.snapshot.reporting) return null;
		const request = (reportRequests.get(sessionId) ?? 0) + 1;
		reportRequests.set(sessionId, request);
		update(entry, { reporting: true });
		try {
			const value = await api.report(sessionId, timestamp);
			if (reportRequests.get(sessionId) !== request) return null;
			select(sessionId, { report: value });
			return value;
		} finally {
			update(entry, { reporting: false });
		}
	};
	return { useDelivery, useSelection, select, undo, report };
}

export type DeliveryState = ReturnType<typeof createDeliveryState>;
