/**
 * 不在屏上的会话的视图：插件的子会话（侧边聊天、子 Agent）画在面板和卡片里，审批卡压在主输入框上方，它们要的是
 * 屏上那个会话以外的视图。谁订阅就读一份、跟着事件流走，没人订阅了就扔掉。
 *
 * 事件怎么改一份视图（`viewChange`）和屏上那个会话共用：两边各合一遍，规则只有一份。读一份视图也共用（`readSessionView`）：
 * 读的期间到的事件补进读回来的那份。
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
				// 放回它自己的位置，不接在末尾：快照接上事件流时，快照里已有的几条会再收一遍（见 `readSessionView`、`follow`），
				// 放回原位就不重复，后面跟着的事件再把会话补齐。写完的回复顶替它的草稿，同一次更新里换手：分两次换，中间那一帧整条回复不见。
				return {
					messages: [...view.messages.slice(0, event.count - 1), event.message],
					progress,
					startedAt,
					...(event.message.role === "assistant" ? { draft: undefined } : {}),
				};
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

/** 正在读的会话各自攒着读的期间到的事件，见 `readSessionView`。 */
const catching = new Set<{ sessionId: string; events: SessionEvent[] }>();

/**
 * 读一个会话的整份视图，读的期间到的事件补进去：读回来的那份已经含着其中一部分，分不出是哪些，就全部按顺序再合一遍。
 * 每种事件重收一遍都落回同一个样子（`message` 按位置放，其余是整份换掉或会被后面的抵掉），所以重收不出错，也不用再读一遍。
 */
export function readSessionView(service: Remote<AgentService>, sessionId: string): Promise<SessionView> {
	const catcher = { sessionId, events: [] as SessionEvent[] };
	catching.add(catcher);
	return Promise.resolve(service.getSession(sessionId))
		.then((read) => {
			let view = read;
			for (const event of catcher.events) {
				const change = viewChange(event);
				if (change) view = { ...view, ...change(view) };
			}
			return view;
		})
		.finally(() => catching.delete(catcher));
}

interface Entry {
	view?: SessionView;
	listeners: Set<() => void>;
	/** 最近一次读：先发出、后读回来的那次不能盖掉新的（事件流断过时重读）。 */
	loading?: object;
}

const entries = new Map<string, Entry>();
let agent: Remote<AgentService> | undefined;
/** 应用手上已有的那份视图（屏上的、停着的、正在读的），见 `connectLiveSessions`。 */
let held: ((sessionId: string) => SessionView | Promise<SessionView> | undefined) | undefined;

/**
 * `local`：应用手上已有、并且一直跟着事件流的那份视图。有就直接拿来，不再整份读一遍：屏上那个会话也常被订阅（输入框旁的上下文用量、
 * 会话的面板），每次换会话都多读一遍整个会话，大会话就是几 MB 的来回。
 */
export function connectLiveSessions(service: Remote<AgentService>, local: (sessionId: string) => SessionView | Promise<SessionView> | undefined): void {
	agent = service;
	held = local;
}

function changed(entry: Entry): void {
	for (const listener of entry.listeners) listener();
}

/**
 * `reuse`：可以拿应用手上的那份（它跟着事件流，正在读的那份也补齐了读的期间的事件）。重读时不行：事件流断过，那份也错过了事件。
 */
function load(sessionId: string, entry: Entry, reuse = false): void {
	if (!agent) return;
	const token = {};
	entry.loading = token;
	void Promise.resolve((reuse ? held?.(sessionId) : undefined) ?? readSessionView(agent, sessionId)).then(
		(view) => {
			if (entries.get(sessionId) !== entry || entry.loading !== token) return;
			entry.loading = undefined;
			entry.view = view;
			changed(entry);
		},
		() => {
			if (entries.get(sessionId) !== entry || entry.loading !== token) return;
			entry.loading = undefined;
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
	for (const catcher of catching) if (catcher.sessionId === event.sessionId) catcher.events.push(event);
	const entry = entries.get(event.sessionId);
	// 还没读到的不用管：读回来时这期间的事件已经补进去了，见 `readSessionView`。
	if (!entry?.view) return;
	const change = viewChange(event);
	if (!change) return;
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
		load(sessionId, entry, true);
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
