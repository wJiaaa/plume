/**
 * 界面入口的 `ui.useSettings`、`ui.useStore`、`ui.useSessionStore`：订阅插件逻辑入口登记的值（`AgentService.watchPluginValue`）。
 *
 * 同一个值不管有几个组件在用只订阅一次，最后一个组件卸下时取消。值在第一次推来之前是 undefined。连接断了（agent 进程退出、
 * 插件停用）留着最后一次的值，不清空：界面不闪成空的，进程回来、插件重新登记以后由新的订阅接上。
 */

import type { AgentService, PluginValueKind } from "@plume/contract";
import type { Remote } from "@plume/rpc";
import { useCallback, useSyncExternalStore } from "react";

interface Feed {
	value: unknown;
	listeners: Set<() => void>;
	stop: () => void;
}

const feeds = new Map<string, Feed>();

function feedOf(agent: Remote<AgentService>, plugin: string, kind: PluginValueKind, key: string, sessionId: string | undefined): string {
	const id = JSON.stringify([plugin, kind, key, sessionId ?? null]);
	if (feeds.has(id)) return id;
	const call = agent.watchPluginValue(plugin, kind, key, sessionId);
	const feed: Feed = { value: undefined, listeners: new Set(), stop: () => call.cancel() };
	feeds.set(id, feed);
	void (async () => {
		try {
			for await (const value of call) {
				feed.value = value;
				for (const listener of [...feed.listeners]) listener();
			}
		} catch {
			// 取消、agent 进程退出：留着最后的值。
		}
	})();
	return id;
}

/** 订阅一个值的 React hook；`sessionId` 只给按会话的。 */
export function usePluginValue<T>(
	agent: Remote<AgentService>,
	plugin: string,
	kind: PluginValueKind,
	key: string,
	sessionId: string | undefined,
): T | undefined {
	const id = JSON.stringify([plugin, kind, key, sessionId ?? null]);
	// subscribe 每次渲染都换一个的话，React 每次渲染都退订再订阅：唯一的订阅者一走 feed 就拆了，新的从 undefined 开始，
	// 值推来、重画、又拆掉，界面永远拿不到值。所以只在订的东西变了时换。
	const subscribe = useCallback(
		(listener: () => void) => {
			const feed = feeds.get(feedOf(agent, plugin, kind, key, sessionId)) as Feed;
			feed.listeners.add(listener);
			return () => {
				feed.listeners.delete(listener);
				if (feed.listeners.size > 0) return;
				feed.stop();
				if (feeds.get(id) === feed) feeds.delete(id);
			};
		},
		[agent, plugin, kind, key, sessionId, id],
	);
	return useSyncExternalStore(subscribe, () => feeds.get(id)?.value as T | undefined);
}
