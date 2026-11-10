/**
 * 不在屏上的会话的视图：插件的子会话（侧边聊天、子 Agent）画在面板和卡片里，审批卡压在主输入框上方，它们要的是
 * 屏上那个会话以外的视图。谁订阅就读一份、跟着事件流走，没人订阅了就扔掉。
 *
 * 事件怎么改一份视图（`viewChange`）和屏上那个会话共用：两边各合一遍，规则只有一份。
 */

import type { AgentEvent, AgentService, SessionView } from "@plume/contract";
import type { Remote } from "@plume/rpc";
import { useCallback, useSyncExternalStore } from "react";

type SessionEvent = Extract<AgentEvent, { sessionId: string }>;

/** 一条会话事件怎么改它的视图；不是改视图的事件（`notice`）返回 undefined。 */
export function viewChange(event: SessionEvent): ((view: SessionView) => Partial<SessionView>) | undefined {
	switch (event.type) {
		case "message":
			return (view) => {
				const progress = { ...view.progress };
				const startedAt = { ...view.startedAt };
				if (event.message.role === "toolResult") {
					delete progress[event.message.toolCallId];
					delete startedAt[event.message.toolCallId];
				}
				// 写完的回复顶替它的草稿，同一次更新里换手：分两次换，中间那一帧整条回复不见。
				return { messages: [...view.messages, event.message], progress, startedAt, ...(event.message.role === "assistant" ? { draft: undefined } : {}) };
			};
		case "rewound":
			// 截掉的那段里的调用、草稿、岔子都跟着没了；截完这个会话停着，没有在跑的。
			return (view) => ({
				messages: view.messages.slice(0, event.count),
				compactions: event.compactions,
				compactionRuns: event.runs,
				draft: undefined,
				progress: {},
				startedAt: {},
				hiccups: [],
			});
		case "draft":
			return () => ({ draft: event.draft });
		case "toolStart":
			return (view) => ({ startedAt: { ...view.startedAt, [event.toolCallId]: event.startedAt } });
		case "progress":
			return (view) => ({ progress: { ...view.progress, [event.toolCallId]: event.output } });
		case "approval":
			return () => ({ approval: event.approval, queuedApprovals: event.queuedApprovals });
		case "hiccups":
			return () => ({ hiccups: event.hiccups });
		case "compaction":
			return () => ({ compacting: event.compacting, compactions: event.compactions, compactionRuns: event.runs });
		case "queue":
			return () => ({ queue: event.queue });
		case "tasks":
			return () => ({ tasks: event.tasks });
		default:
			return undefined;
	}
}

interface Entry {
	view?: SessionView;
	listeners: Set<() => void>;
	/** 读的那一刻起到读回来之间的事件：读回来的视图已经含着其中一部分，没法分，所以读回来以后再读一遍。 */
	stale?: boolean;
}

const entries = new Map<string, Entry>();
let agent: Remote<AgentService> | undefined;

export function connectLiveSessions(service: Remote<AgentService>): void {
	agent = service;
}

function changed(entry: Entry): void {
	for (const listener of entry.listeners) listener();
}

function load(sessionId: string, entry: Entry): void {
	if (!agent) return;
	entry.stale = false;
	void agent.getSession(sessionId).then(
		(view) => {
			if (entries.get(sessionId) !== entry) return;
			if (entry.stale) return load(sessionId, entry);
			entry.view = view;
			changed(entry);
		},
		() => {
			if (entries.get(sessionId) !== entry) return;
			entry.view = undefined;
			changed(entry);
		},
	);
}

/** 事件流里来了一条：订阅着的会话跟着改。会话列表变了，摘要换成新的，会话没了就清掉。 */
export function applyLive(event: AgentEvent): void {
	if (event.type === "sessions") {
		for (const entry of entries.values()) {
			if (!entry.view) continue;
			const summary = event.sessions.find((session) => session.id === entry.view?.summary.id);
			entry.view = summary ? { ...entry.view, summary } : undefined;
			changed(entry);
		}
		return;
	}
	if (!("sessionId" in event)) return;
	const entry = entries.get(event.sessionId);
	if (!entry) return;
	const change = viewChange(event);
	if (!change) return;
	if (!entry.view) {
		entry.stale = true;
		return;
	}
	entry.view = { ...entry.view, ...change(entry.view) };
	changed(entry);
}

/** 事件流断过：订阅着的都错过了事件，全部重读。 */
export function reloadLive(): void {
	for (const [sessionId, entry] of entries) load(sessionId, entry);
}

function subscribe(sessionId: string, listener: () => void): () => void {
	let entry = entries.get(sessionId);
	if (!entry) {
		entry = { listeners: new Set() };
		entries.set(sessionId, entry);
		load(sessionId, entry);
	}
	entry.listeners.add(listener);
	const held = entry;
	return () => {
		held.listeners.delete(listener);
		if (held.listeners.size === 0 && entries.get(sessionId) === held) entries.delete(sessionId);
	};
}

/** 有人订阅着、已经读到的那份视图；没有就是 undefined。打开后台面板已经订阅的会话时直接复用，不用再读。 */
export function peekLiveSession(sessionId: string): SessionView | undefined {
	return entries.get(sessionId)?.view;
}

/** 一个会话的视图，随事件更新；还没读到、会话不在了是 undefined。插件的 `ui.useSession` 就是它。 */
export function useLiveSession(sessionId: string | undefined): SessionView | undefined {
	// 订阅函数换了 React 就先退订再重订：退订到没人订阅会扔掉视图重读，所以同一个会话要用同一个订阅函数。
	const listen = useCallback((listener: () => void) => (sessionId ? subscribe(sessionId, listener) : () => undefined), [sessionId]);
	return useSyncExternalStore(listen, () => (sessionId ? entries.get(sessionId)?.view : undefined));
}
