/**
 * Enforces protocol-level invariants on conversation history before sending to providers.
 *
 * All major LLM providers enforce strict tool pairing rules on the wire:
 * 1. OpenAI Responses:
 *    Every `function_call` must be accompanied by its `function_call_output`.
 *    An unanswered tool call causes HTTP 400 (`No tool output found for function call ...`).
 * 2. Anthropic Messages:
 *    Every `tool_use` block in an assistant message must have a matching `tool_result`
 *    in the immediately following user message. Missing results cause HTTP 400.
 * 3. OpenAI Chat Completions:
 *    An assistant message with `tool_calls` must be followed by `role: "tool"` messages
 *    responding to each `tool_call_id`. Missing results cause HTTP 400.
 *
 * If a session's history contains an assistant message with tool calls that were never
 * answered (e.g. aborted mid-turn, process crash before execution, or network disconnect),
 * sending it raw crashes the conversation irrevocably.
 *
 * This sanitizer synthesizes a clear error toolResult for any unanswered toolCall,
 * preserving turn atomicity and repairing protocol invariants without losing history.
 */

import type { Message, ToolResultMessage } from "../types.ts";

export function sanitizeToolPairing(messages: Message[]): Message[] {
	const out: Message[] = [];

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		// Only results consumed by their immediately preceding call turn belong on the wire.
		// Keep the original persisted transcript intact for recall and diagnostics.
		if (message.role === "toolResult") continue;
		out.push(message);

		if (message.role !== "assistant") continue;

		const toolCalls = message.content.filter((c) => c.type === "toolCall");
		if (toolCalls.length === 0) continue;

		// Collect the toolResults in the immediately following run
		const results = new Map<string, ToolResultMessage>();
		let after = i + 1;
		for (; after < messages.length; after++) {
			const next = messages[after];
			if (next.role !== "toolResult") break;
			if (!results.has(next.toolCallId)) results.set(next.toolCallId, next);
		}

		for (const call of toolCalls) {
			out.push(results.get(call.id) ?? {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				/*
				 * Nothing here says whether the call started, so the model must not assume it did not:
				 * re-running an edit or a command that already landed does the work twice.
				 */
				content: [{ type: "text", text: "[Turn was interrupted before this call returned. It may or may not have taken effect; check the current state before re-running it.]" }],
				isError: true,
				timestamp: message.timestamp,
			});
		}
		i = after - 1;
	}

	return out;
}
