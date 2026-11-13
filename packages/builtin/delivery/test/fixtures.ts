import type { AssistantMessage, FileChanges, ToolResultMessage, UserMessage } from "@plume/contract";

export function user(timestamp = 1, text = "User request", synthetic = false): UserMessage {
	return { role: "user", timestamp, content: [{ type: "text", text }], synthetic };
}

export function answer(timestamp = 10, text = "Delivered", stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		timestamp,
		content: [{ type: "text", text }],
		stopReason,
		api: "openai-chat-completions",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

export function result(details: unknown, isError = false, output = "Tool output"): ToolResultMessage {
	return { role: "toolResult", toolCallId: "call", toolName: "bash", timestamp: 2, content: [{ type: "text", text: output }], details, isError };
}

/** 本体记下了改动的一条工具结果（`ToolResultMessage.changes`）。 */
export function changed(ids: string[], warning?: string, isError = false): ToolResultMessage {
	const changes: FileChanges = { ids, paths: ids.map((id) => `/work/${id}`), ...(warning ? { warning } : {}) };
	return { ...result({}, isError), changes };
}
