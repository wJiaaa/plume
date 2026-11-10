/**
 * Responses 流里没有收尾的工具调用，和不带 `output_index` 的流。
 *
 * 两种输入都复现过（pi 提交 1b2aa0ca0 修的是同一个问题）：
 *
 *   - llama.cpp 的事件一律不带 `output_index`。原来按 `?? 0` 落到同一个槽上，两个并行调用挤在一起，
 *     第一个的 `done` 写进了第二个的块——第一个带着 `{}` 被执行。
 *   - 参数只流了一半、`output_item.done` 没来，`response.completed` 却来了。原来照样以 `toolUse` 交给循环，
 *     参数是 `{}`，循环会执行它。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import type { AssistantMessage } from "../src/types.ts";

function sse(events: Record<string, unknown>[]): string {
	return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const completed = { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } };

const provider = {
	id: "responses",
	name: "responses",
	baseUrl: "https://example.invalid",
	api: "openai-responses" as const,
	apiKey: "test",
	enabled: true,
	models: [],
};

const model = {
	modelId: "test-model",
	contextWindow: 128000,
	maxOutputTokens: 4096,
	pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};

async function run(body: string): Promise<AssistantMessage> {
	const stream = openaiResponsesProvider.stream(
		provider,
		model,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }], tools: [] },
		{
			// oxlint-disable-next-line no-explicit-any -- 测试里塞一个假 fetch
			fetch: (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as any,
			// 假 fetch 每次返回同一段流，重试只会一路退避到超时。
			retryAttempts: 1,
		},
	);
	while (true) {
		const next = await stream.next();
		if (next.done) return next.value;
	}
}

function calls(message: AssistantMessage): [string, unknown][] {
	return message.content.flatMap((c) => (c.type === "toolCall" ? [[c.id, c.arguments] as [string, unknown]] : []));
}

test("不带 output_index 的两个并行调用，各自拿到自己的参数", async () => {
	const message = await run(
		sse([
			{ type: "response.output_item.added", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" } },
			{ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"command":"echo a"}' },
			{ type: "response.output_item.added", item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: "" } },
			{ type: "response.function_call_arguments.delta", item_id: "fc_b", delta: '{"command":"echo b"}' },
			{ type: "response.output_item.done", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: '{"command":"echo a"}' } },
			{ type: "response.output_item.done", item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: '{"command":"echo b"}' } },
			completed,
		]),
	);

	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(calls(message), [
		["call_a", { command: "echo a" }],
		["call_b", { command: "echo b" }],
	]);
});

test("不带 output_index 时，文本和推理的 delta 按 item_id 找到自己的块", async () => {
	const message = await run(
		sse([
			{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
			{ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "想一想" },
			{ type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
			{ type: "response.output_text.delta", item_id: "msg_1", delta: "你" },
			// 迟到的推理 delta：按「最后开的那一项」会写进文本里。
			{ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "再想想" },
			{ type: "response.output_text.delta", item_id: "msg_1", delta: "好" },
			{ type: "response.output_item.done", item: { type: "reasoning", id: "rs_1" } },
			{ type: "response.output_item.done", item: { type: "message", id: "msg_1" } },
			completed,
		]),
	);

	assert.equal(message.stopReason, "stop");
	const thinking = message.content.find((c) => c.type === "thinking");
	const text = message.content.find((c) => c.type === "text");
	assert.equal(thinking?.type === "thinking" && thinking.thinking, "想一想再想想");
	assert.equal(text?.type === "text" && text.text, "你好");
});

test("带 output_index 的正常流不受影响", async () => {
	const message = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
			{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "看一下" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
			{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash" } },
			{ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: '{"command":"ls"}' },
			{ type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' } },
			completed,
		]),
	);

	assert.equal(message.stopReason, "toolUse");
	assert.equal(message.content[0].type === "text" && message.content[0].text, "看一下");
	assert.deepEqual(calls(message), [["call_1", { command: "ls" }]]);
});

test("参数流了一半、没收到 output_item.done 的调用不交给循环——整条流判失败", async () => {
	const message = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash" } },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: '{"command":"rm -rf /tmp/build' },
			completed,
		]),
	);

	assert.equal(message.stopReason, "error", "toolUse 会让循环执行这条半截命令");
	assert.match(message.errorMessage ?? "", /./);
	assert.equal(message.errorRetryable, true, "什么都还没执行，重新问一遍是安全的");
	assert.ok(message.usage.output > 0, "这次尝试的 token 服务商已经收过钱了");
});
