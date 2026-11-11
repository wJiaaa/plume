import type { AgentEvent, SessionSummary } from "@plume/contract";
import type { SessionChange } from "@plume/contract/ui";

const listeners = new Set<(event: SessionChange) => void>();

export function subscribeSessionChanges(listener: (event: SessionChange) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * 只公布落盘消息和会话状态，流式草稿不触发插件重新读取。`sessions` 事件每次带来整份名单，只为新出现和摘要变了的会话
 * 发 `summary`：一个会话跑起来，不该叫订阅的插件把每个会话都重读一遍。
 */
export function publishSessionChanges(event: AgentEvent, previous: readonly SessionSummary[]): void {
	const changes: SessionChange[] = [];
	if (event.type === "message")
		changes.push({ sessionId: event.sessionId, type: "messages", ...(event.message.role === "toolResult" ? { tools: [event.message.toolName] } : {}) });
	else if (event.type === "rewound") changes.push({ sessionId: event.sessionId, type: "messages" });
	else if (event.type === "sessions") {
		const before = new Map(previous.map((session) => [session.id, session]));
		for (const session of event.sessions) {
			const old = before.get(session.id);
			if (!old || !sameSummary(old, session)) changes.push({ sessionId: session.id, type: "summary" });
		}
		const after = new Set(event.sessions.map((session) => session.id));
		for (const session of previous) if (!after.has(session.id)) changes.push({ sessionId: session.id, type: "deleted" });
	}
	for (const change of changes)
		for (const listener of listeners) {
			try {
				listener(change);
			} catch (error) {
				console.error("插件会话订阅出错：", error);
			}
		}
}

/** 每次事件里的摘要都是新对象，按字段比；`model`、`stop` 这类小对象按内容比。 */
function sameSummary(a: SessionSummary, b: SessionSummary): boolean {
	const left = a as unknown as Record<string, unknown>;
	const right = b as unknown as Record<string, unknown>;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		const x = left[key];
		const y = right[key];
		if (x === y) continue;
		if (typeof x !== "object" || typeof y !== "object" || x === null || y === null || JSON.stringify(x) !== JSON.stringify(y)) return false;
	}
	return true;
}
