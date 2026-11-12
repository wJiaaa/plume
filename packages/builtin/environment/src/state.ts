import type { SessionSummary } from "@plume/contract";
import type { Remote, UiContext } from "@plume/contract/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { EnvironmentApi } from "./api.ts";

export interface Children {
	children: SessionSummary[];
	error?: string;
}
const NONE: Children = { children: [] };

/**
 * 界面入口的两样状态：
 * - 子会话列表：画得出来时（卡片开着、子会话列表面板开着）每两秒读一次，窗口藏起来时不读，回到前台马上读；
 * - 子会话面板该画哪一个：按会话记着，卡片和列表面板点了一行写进来，面板读。
 */
export function createState(api: Remote<EnvironmentApi>, ui: UiContext) {
	const opened = new Map<string, string>();
	const listeners = new Set<() => void>();
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	ui.effect(() => listeners.clear());
	return {
		openChild(sessionId: string, childId: string) {
			opened.set(sessionId, childId);
			for (const listener of listeners) listener();
			ui.openPanel("child", sessionId);
		},
		useOpenedChild(sessionId: string): string | undefined {
			return useSyncExternalStore(subscribe, () => opened.get(sessionId));
		},
		useChildren(sessionId: string, shown: boolean): Children {
			const [value, setValue] = useState<Children & { id: string }>({ ...NONE, id: sessionId });
			useEffect(() => {
				if (!shown) return;
				let live = true;
				let pending = false;
				const refresh = async () => {
					if (pending || document.hidden) return;
					pending = true;
					try {
						const children = await api.children(sessionId);
						if (live) setValue({ children, id: sessionId });
					} catch (error) {
						if (live) setValue((current) => ({ ...current, error: String(error), id: sessionId }));
					} finally {
						pending = false;
					}
				};
				void refresh();
				const timer = setInterval(() => void refresh(), 2000);
				window.addEventListener("focus", refresh);
				document.addEventListener("visibilitychange", refresh);
				return () => {
					live = false;
					clearInterval(timer);
					window.removeEventListener("focus", refresh);
					document.removeEventListener("visibilitychange", refresh);
				};
			}, [sessionId, shown]);
			// 换了会话、新的还没读到时不画上一个会话的。
			return value.id === sessionId ? value : NONE;
		},
	};
}
export type EnvironmentState = ReturnType<typeof createState>;
