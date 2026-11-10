import type { AgentEvent, SessionSummary } from "@plume/contract";
import type { SessionChange } from "@plume/contract/ui";

const listeners = new Set<(event: SessionChange) => void>();

export function subscribeSessionChanges(listener: (event: SessionChange) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** 只公布落盘消息和会话状态，流式草稿不触发插件重新读取。 */
export function publishSessionChanges(event: AgentEvent, previous: readonly SessionSummary[]): void {
	const changes: SessionChange[] = [];
	if (event.type === "message")
		changes.push({ sessionId: event.sessionId, type: "messages", ...(event.message.role === "toolResult" ? { tools: [event.message.toolName] } : {}) });
	else if (event.type === "rewound") changes.push({ sessionId: event.sessionId, type: "messages" });
	else if (event.type === "sessions") {
		for (const session of event.sessions) changes.push({ sessionId: session.id, type: "summary" });
		for (const session of previous) if (!event.sessions.some((next) => next.id === session.id)) changes.push({ sessionId: session.id, type: "deleted" });
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
