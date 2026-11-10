/**
 * 三个适配器都把推理的开始时刻和用时写在思考块上（`ThinkingContent.startedAt` / `durationMs`），界面的
 * 「思考了 N 秒」读它们。
 *
 * 三件事都要成立：推理还在写的时候快照里已有开始时刻、还没有用时（界面拿开始时刻和现在比着走秒）；
 * 推理一结束、后面的字还在流的时候，快照里已有用时；最终消息里也有。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicMessagesProvider } from "../src/ai/anthropic-messages.ts";
import { openaiChatCompletionsProvider } from "../src/ai/openai-chat-completions.ts";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import type { AssistantMessage, ModelConfig, Provider, ProviderConfig } from "../src/types.ts";

/** 推理那几帧之间停多久，毫秒。量出来的时长至少是它。 */
const GAP = 80;

const model: ModelConfig = {
	id: "qa/m", providerId: "qa", modelId: "m", name: "M",
	contextWindow: 128_000, maxOutputTokens: 4096, supportsThinking: true, supportsImages: false, supportsTools: true,
};

/** 一帧一帧吐的 SSE；`wait` 里的帧之前先停 `GAP`。 */
function paced(frames: string[], wait: Set<number>): Response {
	const encoder = new TextEncoder();
	let at = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (at >= frames.length) return controller.close();
			if (wait.has(at)) await new Promise((resolve) => setTimeout(resolve, GAP));
			controller.enqueue(encoder.encode(frames[at++]));
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Ran {
	final: AssistantMessage;
	/** 推理还在写的那一刻，块上的开始时刻和用时。 */
	duringThinking: { startedAt?: number; durationMs?: number } | undefined;
	duringText: number | undefined;
}

async function run(adapter: Provider, response: () => Response): Promise<Ran> {
	const provider: ProviderConfig = { id: "qa", name: "QA", api: adapter.api, apiKey: "test", baseUrl: "https://example.invalid", enabled: true, models: [model] };
	const stream = adapter.stream(provider, model, { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "在吗" }], timestamp: 1 }], tools: [] }, {
		retryAttempts: 1,
		fetch: async () => response(),
	});
	let duringThinking: Ran["duringThinking"];
	let duringText: number | undefined;
	while (true) {
		const next = await stream.next();
		if (next.done) return { final: next.value, duringThinking, duringText };
		const event = next.value;
		if (event.type === "thinking_delta" && !duringThinking) {
			const block = event.partial.content.find((c) => c.type === "thinking");
			if (block?.type === "thinking") duringThinking = { startedAt: block.startedAt, durationMs: block.durationMs };
		}
		if (event.type === "text_delta") {
			const block = event.partial.content.find((c) => c.type === "thinking");
			duringText = block?.type === "thinking" ? block.durationMs : undefined;
		}
	}
}

function assertTimed({ final, duringThinking, duringText }: Ran): void {
	assert.notEqual(final.stopReason, "error", final.errorMessage);
	assert.equal(typeof duringThinking?.startedAt, "number", "推理还在写时，块上已有开始时刻");
	assert.equal(duringThinking?.durationMs, undefined, "推理还在写时，还没有用时");
	const block = final.content.find((c) => c.type === "thinking");
	assert.ok(block?.type === "thinking" && block.durationMs !== undefined, "最终消息里的思考块带着时长");
	assert.ok(block.durationMs >= GAP - 5, `时长至少是推理那几帧之间的停顿：${block.durationMs}`);
	assert.equal(duringText, block.durationMs, "推理结束、正文还在流的时候，快照里已经有同一个时长");
}

test("Anthropic Messages：content_block_start 到 content_block_stop", async () => {
	const event = (type: string, rest: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
	const frames = [
		event("message_start", { message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } }),
		event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
		event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "先看目录" } }),
		event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }),
		event("content_block_stop", { index: 0 }),
		event("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
		event("content_block_delta", { index: 1, delta: { type: "text_delta", text: "好了" } }),
		event("content_block_stop", { index: 1 }),
		event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
		event("message_stop", {}),
	];
	assertTimed(await run(anthropicMessagesProvider, () => paced(frames, new Set([3]))));
});

test("Responses：reasoning 项的 added 到 done", async () => {
	const frame = (type: string, rest: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, output_index: 0, ...rest })}\n\n`;
	const frames = [
		frame("response.output_item.added", { item: { type: "reasoning", id: "rs_1" } }),
		frame("response.reasoning_summary_part.added", { summary_index: 0, part: { type: "summary_text", text: "" } }),
		frame("response.reasoning_summary_text.delta", { summary_index: 0, delta: "先看目录" }),
		frame("response.output_item.done", { item: { type: "reasoning", id: "rs_1", summary: [] } }),
		frame("response.output_item.added", { output_index: 1, item: { type: "message", id: "msg_1" } }),
		frame("response.output_text.delta", { output_index: 1, delta: "好了" }),
		frame("response.output_item.done", { output_index: 1, item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: "好了" }] } }),
		frame("response.completed", { response: { usage: { input_tokens: 10, output_tokens: 5 } } }),
	];
	assertTimed(await run(openaiResponsesProvider, () => paced(frames, new Set([3]))));
});

test("Chat Completions：第一段 reasoning_content 到第一个正文字", async () => {
	const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const frames = [
		chunk({ role: "assistant", reasoning_content: "先看" }),
		chunk({ reasoning_content: "目录" }),
		chunk({ content: "好了" }),
		chunk({}, "stop"),
		"data: [DONE]\n\n",
	];
	assertTimed(await run(openaiChatCompletionsProvider, () => paced(frames, new Set([2]))));
});
