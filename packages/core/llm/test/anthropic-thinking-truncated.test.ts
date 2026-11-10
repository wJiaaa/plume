/**
 * Anthropic 链上思考块的两种「历史坏了」：签名被拼成两份，和只想了一半就被截断的那条助手消息。
 *
 * 两种都是会话级的：坏掉的那条进了历史，之后每一轮都带着它。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicMessagesProvider, learnThinkingReplay, resetThinkingReplay } from "../src/ai/anthropic-messages.ts";
import { toAnthropicMessages } from "../src/ai/anthropic-messages-request.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig, type StopReason } from "../src/types.ts";

const model: ModelConfig = {
	id: "qa/claude", providerId: "qa", modelId: "claude-test", name: "Claude Test",
	contextWindow: 200_000, maxOutputTokens: 8192, supportsThinking: true, supportsImages: true, supportsTools: true,
};

// ---------------------------------------------------------------------------
// 签名：start 里带了、delta 里又给一遍
// ---------------------------------------------------------------------------

async function streamedSignature(start: Record<string, unknown>, deltas: string[]): Promise<string | undefined> {
	const event = (type: string, rest: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
	const frames = [
		event("message_start", { message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } }),
		event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", ...start } }),
		event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "先看目录" } }),
		...deltas.map((signature) => event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature } })),
		event("content_block_stop", { index: 0 }),
		event("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
		event("content_block_delta", { index: 1, delta: { type: "text_delta", text: "好了" } }),
		event("content_block_stop", { index: 1 }),
		event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
		event("message_stop", {}),
	];
	const provider: ProviderConfig = { id: "qa", name: "QA", api: "anthropic-messages", apiKey: "test", baseUrl: "https://example.invalid", enabled: true, models: [model] };
	const stream = anthropicMessagesProvider.stream(provider, model, { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "在吗" }], timestamp: 1 }], tools: [] }, {
		retryAttempts: 1,
		fetch: async () => new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } }),
	});
	for (;;) {
		const next = await stream.next();
		if (!next.done) continue;
		const block = next.value.content.find((c) => c.type === "thinking");
		return block?.type === "thinking" ? block.signature : undefined;
	}
}

test("content_block_start 里带了签名、signature_delta 又给一遍：留一份，不是两份拼在一起", async () => {
	// 部分兼容端点把最终签名放在 start 里，有的还会再发
	// 一次 delta。拼成两份的签名验不过，下一轮 `Invalid signature in thinking block`。
	assert.equal(await streamedSignature({ signature: "SIG_FINAL" }, ["SIG_FINAL"]), "SIG_FINAL");
});

test("只在 start 里给签名：用它", async () => {
	assert.equal(await streamedSignature({ signature: "SIG_START" }, []), "SIG_START");
});

test("签名分几段 delta 来：照旧拼起来", async () => {
	assert.equal(await streamedSignature({}, ["SIG_", "PART2"]), "SIG_PART2");
	assert.equal(await streamedSignature({ signature: "SIG_STALE" }, ["SIG_", "PART2"]), "SIG_PART2", "start 里那份被第一段 delta 换掉，后面的接着拼");
});

// ---------------------------------------------------------------------------
// 只想了一半的助手消息
// ---------------------------------------------------------------------------

function assistant(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
	return { role: "assistant", content, api: "anthropic-messages", provider: "qa", model: "claude-test", usage: emptyUsage(), stopReason, timestamp: 2 };
}

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

const signaturesOnWire = (messages: Message[]) =>
	toAnthropicMessages(messages)
		.flatMap((m) => m.content)
		.filter((b) => b.type === "thinking")
		.map((b) => b.signature);

test("想到一半被截断（length / error / aborted）、只剩思考块的助手消息不回放", () => {
	// 复现原文：messages.3.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message
	// cannot be modified. These blocks must remain as they were in the original response.
	for (const stopReason of ["length", "error", "aborted"] as const) {
		const messages = [
			user("看看项目"),
			assistant([{ type: "thinking", thinking: "先看", signature: "SIG_CUT" }], stopReason),
			user("继续"),
			assistant([{ type: "thinking", thinking: "看完了", signature: "SIG_FRESH" }, { type: "text", text: "好了" }], "stop"),
		];
		assert.deepEqual(signaturesOnWire(messages), ["SIG_FRESH"], stopReason);
		const roles = toAnthropicMessages(messages).map((m) => m.role);
		for (let i = 1; i < roles.length; i++) assert.ok(!(roles[i] === "assistant" && roles[i - 1] === "assistant"), `${stopReason}：不能有两条相邻的助手消息`);
	}
});

test("正常结束的纯思考消息、带正文或工具调用的截断消息都照旧回放", () => {
	const kept = toAnthropicMessages([user("想想"), assistant([{ type: "thinking", thinking: "想过了", signature: "SIG_STOP" }], "stop"), user("然后呢")]);
	assert.ok(kept.some((m) => m.role === "assistant"), "stop 结束的纯思考轮是推理回放，不是截断");

	const withText = toAnthropicMessages([user("想想"), assistant([{ type: "thinking", thinking: "想过了", signature: "SIG_A" }, { type: "text", text: "一半" }], "length"), user("继续")]);
	assert.deepEqual(withText.find((m) => m.role === "assistant")?.content.map((b) => b.type), ["thinking", "text"]);

	const withCall: Message[] = [
		user("读一下"),
		assistant([{ type: "thinking", thinking: "读 a", signature: "SIG_B" }, { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } }], "aborted"),
		{ role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "aborted" }], isError: true, timestamp: 3 },
	];
	const wire = toAnthropicMessages(withCall);
	assert.ok(wire.flatMap((m) => m.content).some((b) => b.type === "tool_use"), "工具调用和它的结果配对不受影响");
	assert.ok(wire.flatMap((m) => m.content).some((b) => b.type === "tool_result"));
});

test("被丢掉的截断消息不算「最新那条」：前一条弃用工具的助手消息仍享有原样回放的例外", () => {
	// `untrustedSignatures` 给最新一条助手消息的例外，要落在真的会发出去的最新一条上。
	const messages: Message[] = [
		user("读一下"),
		assistant([{ type: "thinking", thinking: "读 a", signature: "SIG_LATEST" }, { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } }], "stop"),
		{ role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "skipped" }], isError: true, timestamp: 3 },
		assistant([{ type: "thinking", thinking: "再想想", signature: "SIG_CUT" }], "length"),
	];
	assert.deepEqual(signaturesOnWire(messages), ["SIG_LATEST"]);
});

test("「thinking 块不能被修改」被认作签名问题，按回放梯子往下走一格", () => {
	resetThinkingReplay();
	for (const said of [
		"messages.3.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
		"messages.1.content.0: `thinking` blocks in the latest assistant message cannot be modified",
	]) {
		resetThinkingReplay();
		assert.equal(learnThinkingReplay("qa", "m", said, "unsigned"), true, said);
	}
	resetThinkingReplay();
	assert.equal(learnThinkingReplay("qa", "m", "tool_use blocks cannot be modified", "unsigned"), false, "不是思考块的不认");
	resetThinkingReplay();
});
