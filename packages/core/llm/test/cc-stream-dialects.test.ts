/**
 * Chat Completions 链上各家的流式方言：Mistral 的内容数组、OpenRouter 的流内错误、各家的 finish_reason、
 * Kimi 放在 choice 里的 usage、MiniMax 的推理快照、工具参数的两种重发、不收尾的宿主、内联 `<think>`。
 *
 * 每一条都是「某一家的形状和我们假设的不一样」——fixture 按那一家真实发出来的样子写。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiChatCompletionsProvider, resetChatCompletionsCompat } from "../src/ai/openai-chat-completions.ts";
import { mapFinishReason } from "../src/ai/chat-delta.ts";
import { resetReasoningCompat } from "../src/ai/reasoning-compat.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig, StreamEvent, ThinkingContent, ToolCallContent } from "../src/types.ts";

const provider: ProviderConfig = {
	id: "relay",
	name: "中转",
	baseUrl: "https://relay.example.com",
	api: "openai-chat-completions",
	apiKey: "sk-test",
	enabled: true,
	models: [],
};

const model: ModelConfig = {
	id: "relay/m",
	providerId: "relay",
	modelId: "m",
	name: "M",
	contextWindow: 128_000,
	maxOutputTokens: 4_096,
	supportsThinking: true,
	supportsImages: false,
	supportsTools: true,
	pricing: { input: 1, output: 4, source: "manual" },
};

function frame(body: Record<string, unknown>): string {
	return `data: ${JSON.stringify({ id: "chatcmpl-Dx81", object: "chat.completion.chunk", created: 1_757_600_123, model: "m", ...body })}`;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
	return frame({ choices: [{ index: 0, delta, finish_reason: finish }] });
}

function sse(...frames: string[]): string {
	return `${frames.join("\n\n")}\n\n`;
}

interface Ran {
	done: AssistantMessage | null;
	failed: AssistantMessage | null;
	events: StreamEvent[];
}

async function runWith(respond: () => Response): Promise<Ran> {
	resetChatCompletionsCompat();
	resetReasoningCompat();
	const events: StreamEvent[] = [];
	let done: AssistantMessage | null = null;
	let failed: AssistantMessage | null = null;
	for await (const event of openaiChatCompletionsProvider.stream(
		{ ...provider },
		{ ...model },
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "在吗" }], timestamp: 1 }], tools: [] },
		{ retryAttempts: 1, fetch: async () => respond() },
	)) {
		events.push(event);
		if (event.type === "done") done = event.message;
		if (event.type === "error") failed = event.message;
	}
	return { done, failed, events };
}

const run = (payload: string): Promise<Ran> =>
	runWith(() => new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } }));

const thinkingOf = (message: AssistantMessage): ThinkingContent[] =>
	message.content.filter((c): c is ThinkingContent => c.type === "thinking");

const textOf = (message: AssistantMessage): string =>
	message.content.filter((c) => c.type === "text").map((c) => (c.type === "text" ? c.text : "")).join("");

const callsOf = (message: AssistantMessage): ToolCallContent[] =>
	message.content.filter((c): c is ToolCallContent => c.type === "toolCall");

/** 事件序列里块的开合是否成对、不交叠：任何时刻最多一个块开着。 */
function assertBlocksNest(events: StreamEvent[]): void {
	let open: number | undefined;
	for (const event of events) {
		if (event.type === "text_start" || event.type === "thinking_start") {
			assert.equal(open, undefined, `块 ${event.index} 开的时候块 ${open} 还没关`);
			open = event.index;
		}
		if (event.type === "text_end" || event.type === "thinking_end") {
			assert.equal(open, event.index);
			open = undefined;
		}
	}
}

// ---------------------------------------------------------------------------
// Mistral 的 content 是数组
// ---------------------------------------------------------------------------

test("CC：Mistral 把 content 发成数组，正文不能变成 [object Object]", async () => {
	const { done } = await run(sse(
		chunk({ role: "assistant", content: "" }),
		chunk({ content: [{ type: "text", text: "你好，" }] }),
		chunk({ content: [{ type: "text", text: "我在。" }] }),
		chunk({}, "stop"),
		"data: [DONE]",
	));
	assert.equal(textOf(done!), "你好，我在。");
});

test("CC：Magistral 的 thinking 部分归到推理，不进正文", async () => {
	const { done, events } = await run(sse(
		chunk({ content: [{ type: "thinking", thinking: [{ type: "text", text: "先想一下" }] }] }),
		chunk({ content: [{ type: "thinking", thinking: [{ type: "text", text: "，再回答。" }] }] }),
		chunk({ content: [{ type: "text", text: "答案是 4。" }] }),
		chunk({}, "stop"),
		"data: [DONE]",
	));
	assert.equal(thinkingOf(done!).map((t) => t.thinking).join(""), "先想一下，再回答。");
	assert.equal(textOf(done!), "答案是 4。");
	assertBlocksNest(events);
});

// ---------------------------------------------------------------------------
// OpenRouter 的流内错误
// ---------------------------------------------------------------------------

test("CC：OpenRouter 的流内错误带着 choices 也认，原话交给分类——上下文超长能被认出来", async () => {
	const { done, failed } = await run(sse(
		chunk({ content: "我先" }),
		frame({
			error: { code: 400, message: "This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens." },
			choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
		}),
		"data: [DONE]",
	));
	assert.equal(done, null);
	assert.equal(failed?.failure?.code, "context-overflow");
	assert.doesNotMatch(failed?.errorMessage ?? "", /上游报告这次生成失败/);
});

test("CC：{error, choices: []} 是错误，不是空回答", async () => {
	const { failed } = await run(sse(
		frame({ error: { code: 502, message: "Provider returned error: upstream connect timeout" }, choices: [] }),
		"data: [DONE]",
	));
	assert.match(failed?.errorMessage ?? "", /Provider returned error/);
	assert.doesNotMatch(failed?.errorMessage ?? "", /空回答/);
});

// ---------------------------------------------------------------------------
// finish_reason
// ---------------------------------------------------------------------------

test("CC：TGI、Mistral、智谱的结束原因各归其位", () => {
	assert.deepEqual(mapFinishReason("eos_token"), { stopReason: "stop" });
	assert.deepEqual(mapFinishReason("stop_sequence"), { stopReason: "stop" });
	assert.deepEqual(mapFinishReason("model_length"), { stopReason: "length" });
	assert.ok(mapFinishReason("sensitive").error);
});

test("CC：智谱的 sensitive 是终局失败，和 content_filter 同类", async () => {
	const { failed } = await run(sse(chunk({ content: "这" }), chunk({}, "sensitive"), "data: [DONE]"));
	assert.equal(failed?.failure?.kind, "fatal");
	assert.equal(failed?.errorRetryable, false);
});

test("CC：Mistral 的 model_length 是截断，不是失败——话交出去，标 length", async () => {
	const { done, failed } = await run(sse(chunk({ content: "半句" }), chunk({}, "model_length"), "data: [DONE]"));
	assert.equal(failed, null);
	assert.equal(done?.stopReason, "length");
	assert.equal(textOf(done!), "半句");
});

test("CC：没见过的结束原因，名字里没有出错的意思，就按说完了交付", async () => {
	const { done, failed } = await run(sse(chunk({ content: "说完了。" }), chunk({}, "end_of_generation"), "data: [DONE]"));
	assert.equal(failed, null);
	assert.equal(done?.stopReason, "stop");
	assert.equal(textOf(done!), "说完了。");
});

test("CC：没见过的结束原因，名字里写着出错，仍然是可重试的失败", async () => {
	for (const reason of ["upstream_error", "aborted", "timeout"]) {
		const { done, failed } = await run(sse(chunk({ content: "半句" }), chunk({}, reason), "data: [DONE]"));
		assert.equal(done, null, reason);
		assert.equal(failed?.errorRetryable, true, reason);
		assert.match(failed?.errorMessage ?? "", new RegExp(reason), reason);
	}
});

// ---------------------------------------------------------------------------
// Kimi 的 usage 在 choice 里
// ---------------------------------------------------------------------------

test("CC：Kimi 把 usage 放在 choices[0].usage 上，也要记账", async () => {
	const { done } = await run(sse(
		chunk({ content: "好。" }),
		frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop", usage: { prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050 } }] }),
		"data: [DONE]",
	));
	assert.equal(done?.usage.input, 1_000);
	assert.equal(done?.usage.output, 50);
	assert.ok((done?.usage.cost.total ?? 0) > 0);
});

// ---------------------------------------------------------------------------
// MiniMax：正文开始后还带着同一份推理快照
// ---------------------------------------------------------------------------

test("CC：MiniMax 正文开始后重复发来的推理快照不再开出新的思考块，块的开合不交叠", async () => {
	const snapshot = "用户要我读文件，先看它在不在。";
	const { done, events } = await run(sse(
		chunk({ reasoning_content: "用户要我" }),
		chunk({ reasoning_content: "用户要我读文件，" }),
		chunk({ reasoning_content: snapshot }),
		chunk({ reasoning_content: snapshot, content: "在的，" }),
		chunk({ reasoning_content: snapshot, content: "我来读。" }),
		chunk({ reasoning_content: snapshot }, "stop"),
		"data: [DONE]",
	));
	assert.equal(thinkingOf(done!).length, 1);
	assert.equal(thinkingOf(done!)[0].thinking, snapshot);
	assert.equal(textOf(done!), "在的，我来读。");
	assertBlocksNest(events);
});

test("CC：正文之后又来了新的推理，先关文本块再开思考块", async () => {
	const { done, events } = await run(sse(
		chunk({ reasoning_content: "第一段" }),
		chunk({ content: "先说一句。" }),
		chunk({ reasoning_content: "第二段" }),
		chunk({ content: "再说一句。" }),
		chunk({}, "stop"),
		"data: [DONE]",
	));
	assert.deepEqual(done!.content.map((c) => c.type), ["thinking", "text", "thinking", "text"]);
	assertBlocksNest(events);
});

// ---------------------------------------------------------------------------
// 工具参数
// ---------------------------------------------------------------------------

const toolCall = (args: unknown, extra: Record<string, unknown> = {}) => ({
	tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: args }, ...extra }],
});

test("CC：先给完整参数串、收尾分片又重发一遍完整串的，不拼成两份", async () => {
	const { done } = await run(sse(
		chunk(toolCall('{"path":"a.ts"}')),
		chunk(toolCall('{"path":"a.ts"}'), "tool_calls"),
		"data: [DONE]",
	));
	assert.deepEqual(callsOf(done!)[0].arguments, { path: "a.ts" });
});

test("CC：增量参数串照旧拼接", async () => {
	const { done } = await run(sse(
		chunk(toolCall('{"pa')),
		chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }, "tool_calls"),
		"data: [DONE]",
	));
	assert.deepEqual(callsOf(done!)[0].arguments, { path: "a.ts" });
});

test("CC：对象形式的参数分片合并，不覆盖丢键", async () => {
	const { done } = await run(sse(
		chunk(toolCall({ path: "a.ts" })),
		chunk({ tool_calls: [{ index: 0, function: { arguments: { offset: 10 } } }] }, "tool_calls"),
		"data: [DONE]",
	));
	assert.deepEqual(callsOf(done!)[0].arguments, { path: "a.ts", offset: 10 });
});

test("CC：每个 delta 重发同一整份对象的宿主，结果仍是那一份", async () => {
	const { done } = await run(sse(
		chunk(toolCall({ path: "a.ts", offset: 10 })),
		chunk(toolCall({ path: "a.ts", offset: 10 })),
		chunk(toolCall({ path: "a.ts", offset: 10 }), "tool_calls"),
		"data: [DONE]",
	));
	assert.deepEqual(callsOf(done!)[0].arguments, { path: "a.ts", offset: 10 });
});

// ---------------------------------------------------------------------------
// 收到 finish_reason 之后不关连接
// ---------------------------------------------------------------------------

/** 发完这些帧之后连接一直挂着，既不发 `[DONE]` 也不关。 */
function hangingResponse(frames: string[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sse(...frames)));
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("CC：finish_reason 之后跟着 usage 帧、然后连接挂着——立刻交付，不等空闲闸", { timeout: 5_000 }, async () => {
	const started = Date.now();
	const { done, failed } = await runWith(() => hangingResponse([
		chunk({ content: "说完了。" }),
		chunk({}, "stop"),
		frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }),
	]));
	assert.equal(failed, null);
	assert.equal(textOf(done!), "说完了。");
	assert.equal(done?.usage.output, 3);
	assert.ok(Date.now() - started < 1_000);
});

test("CC：finish_reason 之后什么都不再来、连接挂着——宽限期过后交付，不当成断线", { timeout: 10_000 }, async () => {
	const { done, failed } = await runWith(() => hangingResponse([chunk({ content: "说完了。" }), chunk({}, "stop")]));
	assert.equal(failed, null);
	assert.equal(done?.stopReason, "stop");
	assert.equal(textOf(done!), "说完了。");
});

// ---------------------------------------------------------------------------
// 内联在 content 里的 <think>
// ---------------------------------------------------------------------------

test("CC：content 开头的 <think>…</think> 切成思考块，标签跨 chunk 也认", async () => {
	const { done, events } = await run(sse(
		chunk({ content: "<thi" }),
		chunk({ content: "nk>\n用户在打招呼" }),
		chunk({ content: "。\n</th" }),
		chunk({ content: "ink>\n\n在的。" }),
		chunk({}, "stop"),
		"data: [DONE]",
	));
	assert.equal(thinkingOf(done!).length, 1);
	assert.equal(thinkingOf(done!)[0].thinking, "\n用户在打招呼。\n");
	assert.equal(textOf(done!), "在的。");
	assertBlocksNest(events);
});

test("CC：正文中间讨论 <think> 标签的不切", async () => {
	const { done } = await run(sse(chunk({ content: "用 <think> 标签包住推理。" }), chunk({}, "stop"), "data: [DONE]"));
	assert.equal(thinkingOf(done!).length, 0);
	assert.equal(textOf(done!), "用 <think> 标签包住推理。");
});

test("CC：只想不答的一轮——<think> 没有闭合，内容全是思考，不当正文显示", async () => {
	const { done } = await run(sse(chunk({ content: "<think>还在想" }), chunk({}, "length"), "data: [DONE]"));
	assert.equal(textOf(done!), "");
	assert.equal(thinkingOf(done!)[0].thinking, "还在想");
	assert.equal(done?.stopReason, "length");
});
