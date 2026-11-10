/**
 * `response.completed` 里带着整份 `response.output`——流里缺了的项，从那里补。
 *
 * 守规矩的端点上每一项都有 `added` / `done`，那份 output 只是重复；有损的中转上它是唯一完整的一份。
 * 原来只从 completed 里取用量和 id，于是三种形状各坏一样：
 *
 *   - 只发 `output_text.delta` 和 `completed`：deltas 找不到块被扔掉，判成「空回答」。
 *   - 工具调用发了 `function_call_arguments.done`，没发 `output_item.done`：判「没有收尾」反复重试。
 *   - 流里一个字没提的工具调用只在 output 里：静默丢掉，以 `stop` 收场，工具不跑。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import type { AssistantMessage } from "../src/types.ts";

function sse(events: Record<string, unknown>[]): string {
	return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const usage = { input_tokens: 10, output_tokens: 5 };

const provider = { id: "responses", name: "responses", baseUrl: "https://example.invalid", api: "openai-responses" as const, apiKey: "test", enabled: true, models: [] };
const model = { modelId: "test-model", contextWindow: 128000, maxOutputTokens: 4096, pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } };

async function run(body: string): Promise<AssistantMessage> {
	const stream = openaiResponsesProvider.stream(
		provider,
		model,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }], tools: [] },
		// oxlint-disable-next-line no-explicit-any -- 测试里塞一个假 fetch
		{ fetch: (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as any, retryAttempts: 1 },
	);
	while (true) {
		const next = await stream.next();
		if (next.done) return next.value;
	}
}

const message = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
const call = (id: string, args: string) => ({ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "bash", arguments: args, status: "completed" });

test("只有 output_text.delta 和 completed：正文从 completed.output 里取", async () => {
	const result = await run(
		sse([
			{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "你好" },
			{ type: "response.completed", response: { usage, output: [message("你好")] } },
		]),
	);
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.deepEqual(
		result.content.map((c) => c.type === "text" && c.text),
		["你好"],
	);
});

test("参数有 function_call_arguments.done、缺 output_item.done：参数算完整，交给循环", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash" } },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_a", delta: '{"command":' },
			{ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_a", arguments: '{"command":"ls"}' },
			{ type: "response.completed", response: { usage } },
		]),
	);
	assert.equal(result.stopReason, "toolUse", result.errorMessage);
	const [tool] = result.content;
	assert.equal(tool.type === "toolCall" && JSON.stringify(tool.arguments), '{"command":"ls"}');
});

test("缺 output_item.done 的调用，参数从 completed.output 里补齐", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash" } },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_a", delta: '{"command":' },
			{ type: "response.completed", response: { usage, output: [call("a", '{"command":"ls"}')] } },
		]),
	);
	assert.equal(result.stopReason, "toolUse", result.errorMessage);
	assert.deepEqual(
		result.content.map((c) => c.type === "toolCall" && [c.id, c.arguments]),
		[["call_a", { command: "ls" }]],
	);
});

test("流里没出现过的调用只在 completed.output 里：补出来，不静默丢掉", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
			{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "我看看" },
			{ type: "response.output_item.done", output_index: 0, item: message("我看看") },
			{ type: "response.completed", response: { usage, output: [message("我看看"), call("b", '{"command":"pwd"}')] } },
		]),
	);
	assert.equal(result.stopReason, "toolUse", "以 stop 收场的话，工具静默不跑");
	assert.deepEqual(
		result.content.map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? c.id : c.type)),
		["我看看", "call_b"],
		"流里已经出来的正文不重复",
	);
});

test("流里完整的项，completed.output 再说一遍也不重复", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
			{ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_1", delta: "想" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", encrypted_content: "E" } },
			{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash" } },
			{ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_a", delta: '{"command":"ls"}' },
			{ type: "response.output_item.done", output_index: 1, item: call("a", '{"command":"ls"}') },
			{
				type: "response.completed",
				response: { usage, output: [{ type: "reasoning", id: "rs_1", encrypted_content: "E", summary: [{ type: "summary_text", text: "想" }] }, call("a", '{"command":"ls"}')] },
			},
		]),
	);
	assert.equal(result.stopReason, "toolUse");
	assert.deepEqual(
		result.content.map((c) => c.type),
		["thinking", "toolCall"],
	);
});

test("缺了的推理项按 output 里的位置补回去，不排到调用后面", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash" } },
			{ type: "response.output_item.done", output_index: 1, item: call("a", '{"command":"ls"}') },
			{
				type: "response.completed",
				response: { usage, output: [{ type: "reasoning", id: "rs_1", encrypted_content: "E", summary: [{ type: "summary_text", text: "想" }] }, call("a", '{"command":"ls"}')] },
			},
		]),
	);
	assert.deepEqual(
		result.content.map((c) => c.type),
		["thinking", "toolCall"],
	);
	const [thinking] = result.content;
	assert.equal(thinking.type === "thinking" && thinking.encrypted, "E");
});

/*
 * 中转在流里和 completed 里各发一套 item id。只按 id 对的时候整份 output 被当成新项再追加一遍：
 * 真实会话里 deepseek-flash 的每条回复都是「推理 正文 调用… 推理 调用…」，每个工具跑两次。
 */
test("completed 换了一套 item id：推理和调用都不再追加一份", async () => {
	const fc = { type: "function_call", id: "item_c", call_id: "call_00", name: "read", arguments: '{"path":"a.ts"}', status: "completed" };
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "item_a" } },
			{ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "item_a", summary: [{ type: "summary_text", text: "想" }] } },
			{ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "item_b" } },
			{ type: "response.output_text.delta", output_index: 1, item_id: "item_b", delta: "我先读一下" },
			{ type: "response.output_item.done", output_index: 1, item: { type: "message", id: "item_b", content: [{ type: "output_text", text: "我先读一下" }] } },
			{ type: "response.output_item.added", output_index: 2, item: { ...fc, arguments: "" } },
			{ type: "response.output_item.done", output_index: 2, item: fc },
			{
				type: "response.completed",
				response: { usage, output: [{ type: "reasoning", id: "item_x", summary: [{ type: "summary_text", text: "想" }] }, { ...fc, id: "item_y" }] },
			},
		]),
	);
	assert.deepEqual(
		result.content.map((c) => c.type),
		["thinking", "text", "toolCall"],
	);
});

test("同一个 call_id、不同的 item id：按 call_id 认回去，调用只有一个", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item_1", call_id: "call_a", name: "bash" } },
			{ type: "response.output_item.done", output_index: 0, item: { ...call("a", '{"command":"ls"}'), id: "item_1" } },
			{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "item_2", call_id: "call_b", name: "bash" } },
			{ type: "response.output_item.done", output_index: 1, item: { ...call("b", '{"command":"pwd"}'), id: "item_2" } },
			// completed 里的顺序也换了：只按位置对的话 call_b 会落到 call_a 的块上
			{ type: "response.completed", response: { usage, output: [call("b", '{"command":"pwd"}'), call("a", '{"command":"ls"}')] } },
		]),
	);
	assert.deepEqual(
		result.content.map((c) => c.type === "toolCall" && [c.id, c.arguments]),
		[
			["call_a", { command: "ls" }],
			["call_b", { command: "pwd" }],
		],
	);
});

/*
 * 流里只出现了 `output_index` 1 的 B，completed 里是 A、B 两项，A 在流里一个字都没提。
 *
 * 原来的对位顺序是：id → call_id → 同类型里的第几个。前两条对 A 都不成立（流里的 `stream_b` 和
 * `final_a` / `final_b` 是两套 id，A 也没有 `call_id` 可对），于是落到第三条：A 是 completed 里第一个
 * 没被认走的调用，就抢了 B 的槽；B 再按位置补一份。结果是 A 的内容写进 B 的块、执行时按 `stream_b`
 * 跑一遍 B，再按 `call_b` 跑一遍 B——A 从来没跑过，B 跑两次。
 */
test("流里缺了前一个调用：按位置补，不抢流里那一个的槽", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "stream_b", name: "bash" } },
			{ type: "response.function_call_arguments.delta", output_index: 1, item_id: "stream_b", delta: '{"command":"echo B"}' },
			{ type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "stream_b", name: "bash", arguments: '{"command":"echo B"}' } },
			{
				type: "response.completed",
				response: {
					usage,
					output: [
						{ type: "function_call", id: "final_a", call_id: "call_a", name: "bash", arguments: '{"command":"echo A"}', status: "completed" },
						{ type: "function_call", id: "final_b", call_id: "call_b", name: "bash", arguments: '{"command":"echo B"}', status: "completed" },
					],
				},
			},
		]),
	);
	assert.equal(result.stopReason, "toolUse", result.errorMessage);
	assert.deepEqual(
		result.content.map((c) => c.type === "toolCall" && c.arguments),
		[{ command: "echo A" }, { command: "echo B" }],
		"A 要在、B 只能有一份",
	);
});

/*
 * 同一条流里换成文本项也一样：流里只有 `output_index` 1 的那段正文，completed 里是先一段后一段。
 * 按同类型第几个排的话，completed 的第一段会落到第二段那个已经收尾的槽上，然后被跳过。
 */
test("流里缺了前一段正文：按位置补回它，不和流里那段抢", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "item_b" } },
			{ type: "response.output_text.delta", output_index: 1, item_id: "item_b", delta: "第二段" },
			{
				type: "response.completed",
				response: {
					usage,
					output: [
						{ type: "message", id: "final_a", content: [{ type: "output_text", text: "第一段" }] },
						{ type: "message", id: "final_b", content: [{ type: "output_text", text: "第二段" }] },
					],
				},
			},
		]),
	);
	assert.deepEqual(
		result.content.map((c) => c.type === "text" && c.text),
		["第一段", "第二段"],
	);
});
