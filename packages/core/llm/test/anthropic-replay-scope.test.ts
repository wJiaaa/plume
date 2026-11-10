/**
 * 思考回放降级的作用域：一次请求、一个会话、还是整个进程。
 *
 * 复现过的故障：一个会话自己历史里有个坏签名，端点回 `400 Invalid \`signature\` in \`thinking\` block`，
 * 降一格重发成功——而那一格被写进了进程级的表、成功后也不撤。之后同一个模型的**所有**会话都不再回放
 * 思考块，直到重启。三次请求的思考块数是 `[1, 0, 0]`，应该是 `[1, 0, 1]`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicMessagesProvider, resetThinkingReplay, thinkingReplay } from "../src/ai/anthropic-messages.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const model: ModelConfig = {
	id: "qa/claude", providerId: "qa", modelId: "claude-test", name: "Claude Test",
	contextWindow: 200_000, maxOutputTokens: 8192, supportsThinking: true, supportsImages: true, supportsTools: true,
};
// 非签名端点 + 推理模型：默认第一格「连没签名的也发」，所以历史里那个没签名的块看得出发没发。
const provider: ProviderConfig = { id: "qa", name: "Relay", api: "anthropic-messages", apiKey: "k", baseUrl: "https://relay.example.test", enabled: true, models: [model] };

const assistant: AssistantMessage = {
	role: "assistant", api: "anthropic-messages", provider: "qa", model: "claude-test", usage: emptyUsage(), stopReason: "stop", timestamp: 2,
	content: [{ type: "thinking", thinking: "先看调用点。" }, { type: "text", text: "看完了。" }],
};
const history: Message[] = [
	{ role: "user", content: [{ type: "text", text: "看下这段" }], timestamp: 1 },
	assistant,
	{ role: "user", content: [{ type: "text", text: "继续" }], timestamp: 3 },
];

const frame = (type: string, rest: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
const ok = () =>
	new Response(
		[
			frame("message_start", { message: { usage: { input_tokens: 3, output_tokens: 1 } } }),
			frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
			frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "好" } }),
			frame("content_block_stop", { index: 0 }),
			frame("message_delta", { delta: { stop_reason: "end_turn" } }),
			frame("message_stop"),
		].join(""),
		{ status: 200 },
	);
const BAD_SIGNATURE = () => new Response(JSON.stringify({ error: { message: "messages.1.content.0: Invalid `signature` in `thinking` block" } }), { status: 400 });

/**
 * 发一次请求。`refuse(n)` 决定这次请求里第 n 次 fetch 要不要回签名 400。返回每次 fetch 带了几个思考块
 * 和最后的结局。
 */
async function ask(session: string | undefined, refuse: (attempt: number, thinkingBlocks: number) => boolean) {
	const sent: number[] = [];
	const stream = anthropicMessagesProvider.stream(provider, model, { messages: history, tools: [] }, {
		retryAttempts: 1,
		cacheKey: session,
		fetch: async (_input, init) => {
			const body = JSON.parse(String(init?.body));
			const blocks = body.messages.flatMap((m: { content: { type: string }[] }) => m.content).filter((b: { type: string }) => b.type === "thinking").length;
			sent.push(blocks);
			return refuse(sent.length - 1, blocks) ? BAD_SIGNATURE() : ok();
		},
	});
	let stopReason: string | undefined;
	for await (const event of stream) if (event.type === "done" || event.type === "error") stopReason = event.message.stopReason;
	return { sent, stopReason };
}

test("一个会话靠降级才成功，别的会话照样回放思考块", async () => {
	resetThinkingReplay();
	const first = await ask("会话甲", (attempt) => attempt === 0);
	assert.deepEqual(first.sent, [1, 0], "这一次请求里降一格重发");
	assert.equal(first.stopReason, "stop");

	const other = await ask("会话乙", () => false);
	assert.deepEqual(other.sent, [1], "从前这里是 0：会话甲的坏签名把整个进程都降了");
	assert.equal(thinkingReplay(provider, model), "unsigned", "进程级的结论没动");
});

test("降级记在会话上：同一个会话下一轮不必再撞一次", async () => {
	resetThinkingReplay();
	await ask("会话甲", (attempt) => attempt === 0);
	const again = await ask("会话甲", (_attempt, blocks) => blocks > 0);
	assert.deepEqual(again.sent, [0], "直接从降过的那一格开始");
	assert.equal(thinkingReplay(provider, model, "会话甲"), "signed-only");
	assert.equal(thinkingReplay(provider, model, "会话乙"), "unsigned");
});

test("两个不同的会话各自靠降级才成功，才算端点的结论", async () => {
	resetThinkingReplay();
	const endpointRefuses = (_attempt: number, blocks: number) => blocks > 0;
	await ask("会话甲", endpointRefuses);
	assert.equal(thinkingReplay(provider, model), "unsigned", "一个会话不够");
	await ask("会话乙", endpointRefuses);
	assert.equal(thinkingReplay(provider, model), "signed-only", "两个会话印证过，记成这个模型的结论");
	const third = await ask("会话丙", endpointRefuses);
	assert.deepEqual(third.sent, [0], "第三个会话不再先撞一次");
});

test("同一个会话撞两次不算两个会话", async () => {
	resetThinkingReplay();
	await ask("会话甲", (attempt) => attempt === 0);
	// 会话甲已经记在 signed-only，这次在那一格上又被拒、降到底才成功。
	await ask("会话甲", (attempt) => attempt === 0);
	assert.equal(thinkingReplay(provider, model), "unsigned");
	assert.equal(thinkingReplay(provider, model, "会话甲"), "none");
});

test("两个会话降到的深浅不同，进程级取浅的那一格", async () => {
	resetThinkingReplay();
	await ask("会话甲", (attempt) => attempt < 2);
	assert.equal(thinkingReplay(provider, model, "会话甲"), "none");
	await ask("会话乙", (attempt) => attempt === 0);
	assert.equal(thinkingReplay(provider, model), "signed-only", "两个都证明过的只有「第一格不行」");
});

test("降了还是失败，什么都不留", async () => {
	resetThinkingReplay();
	const failed = await ask("会话甲", () => true);
	assert.equal(failed.stopReason, "error");
	assert.deepEqual(failed.sent, [1, 0, 0], "梯子走到底");
	assert.equal(thinkingReplay(provider, model, "会话甲"), "unsigned");
	assert.equal(thinkingReplay(provider, model), "unsigned");
});

test("没有 cacheKey 的调用分不出会话，降级只作用于这一次", async () => {
	resetThinkingReplay();
	await ask(undefined, (attempt) => attempt === 0);
	await ask(undefined, (attempt) => attempt === 0);
	assert.equal(thinkingReplay(provider, model), "unsigned", "两次匿名请求可能是同一个会话，不能拿来印证");
	const next = await ask(undefined, () => false);
	assert.deepEqual(next.sent, [1]);
});

test("端点要推理带回来、带回来成功了，会话和进程两层的降级都撤掉", async () => {
	resetThinkingReplay();
	const endpointRefuses = (_attempt: number, blocks: number) => blocks > 0;
	await ask("会话甲", endpointRefuses);
	await ask("会话乙", endpointRefuses);
	assert.equal(thinkingReplay(provider, model), "signed-only");

	const sent: number[] = [];
	const stream = anthropicMessagesProvider.stream(provider, model, { messages: history, tools: [] }, {
		retryAttempts: 1,
		cacheKey: "会话甲",
		fetch: async (_input, init) => {
			const body = JSON.parse(String(init?.body));
			sent.push(body.messages.flatMap((m: { content: { type: string }[] }) => m.content).filter((b: { type: string }) => b.type === "thinking").length);
			return sent.length === 1
				? new Response(JSON.stringify({ error: { message: "The reasoning_content in the thinking mode must be passed back to the API." } }), { status: 400 })
				: ok();
		},
	});
	for await (const _event of stream) { /* 跑完。 */ }
	assert.deepEqual(sent, [0, 1]);
	assert.equal(thinkingReplay(provider, model), "unsigned");
	assert.equal(thinkingReplay(provider, model, "会话甲"), "unsigned");
	resetThinkingReplay();
});
