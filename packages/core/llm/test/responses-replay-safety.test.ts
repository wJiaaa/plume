/**
 * Responses 历史里那些「回放出去必被拒」的推理项，以及请求体里会被官方 OpenAI 顶回来的几个参数。
 *
 * 每一条都是会话级的故障：历史就是请求，被拒的那一项每一轮都会被重新编码一次，于是那个对话再也说不了
 * 话。几种入口：
 *
 *   - 推理到一半按停止：`output_item.added` 已经记下了 `rs_` id，`encrypted_content` 要到 `done` 才来。
 *     `store: false` 下回放这个 id，OpenAI 回 404 `Item with id 'rs_…' not found`。
 *   - 模型推理了但没请求密文（`supportsThinking: false`、学到 `reasoning-off`）：同样只剩一个 id。
 *   - 每个助手轮都补一个带 `content` 的合成推理项：官方 OpenAI 回 `maximum length 0`。
 *   - 未做组织验证的账号开思考：`reasoning.summary` 被拒。
 *   - o3 / o4-mini 不收 `effort: "none"`，而原来的正则认不出它们的说法。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { toResponsesInput } from "../src/ai/openai-responses-request.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const user: Message = { role: "user", content: [{ type: "text", text: "看看项目" }], timestamp: 0 };

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content, api: "openai-responses", provider: "openai", model: "gpt-5.1", usage: emptyUsage(), stopReason, timestamp: 1 };
}

/** 发往官方 OpenAI 的样子：不需要补位。 */
const openai = { provider: "openai", model: "gpt-5.1", leadingReasoning: false };

type Item = { type?: string; id?: string; content?: unknown; summary?: unknown; encrypted_content?: string };
const reasoningItems = (input: unknown[]): Item[] => (input as Item[]).filter((item) => item.type === "reasoning");

test("推理到一半被停下：那个没等到 done 的推理项不回放，id 和文本都不", () => {
	for (const stopReason of ["aborted", "error"] as const) {
		const input = toResponsesInput([user, assistant([{ type: "thinking", thinking: "先看目录", signature: "rs_cut" }], stopReason), user], openai);
		assert.deepEqual(reasoningItems(input), [], `${stopReason}：回放 rs_cut 会 404，而且之后每一轮都 404`);
		assert.ok(!JSON.stringify(input).includes("先看目录"), `${stopReason}：带文本也不行——官方端点上 content 只能是空的`);
	}
});

test("停在正文里时，前面已经写完的推理照常回放", () => {
	const input = toResponsesInput(
		[user, assistant([{ type: "thinking", thinking: "先看目录", signature: "rs_ok", encrypted: "gAAAAA" }, { type: "text", text: "我先" }], "aborted"), user],
		openai,
	);
	assert.deepEqual(reasoningItems(input), [{ type: "reasoning", id: "rs_ok", summary: [{ type: "summary_text", text: "先看目录" }], encrypted_content: "gAAAAA" }]);
});

test("有 id、没密文、没文本的推理项不发——store:false 下这个 id 什么也指不到", () => {
	// 模型自己推理了，但请求里没有 include（`supportsThinking: false`，或学到了 `reasoning-off`）。
	const input = toResponsesInput([user, assistant([{ type: "thinking", thinking: "", signature: "rs_bare" }, { type: "text", text: "好" }]), user], openai);
	assert.deepEqual(reasoningItems(input), []);
});

test("有 id、有文本、没密文的照旧发 content——只给签名不给密文的中转要它", () => {
	const input = toResponsesInput([user, assistant([{ type: "thinking", thinking: "想想", signature: "rs_relay" }]), user], openai);
	assert.deepEqual(reasoningItems(input), [
		{ type: "reasoning", id: "rs_relay", summary: [{ type: "summary_text", text: "想想" }], content: [{ type: "reasoning_text", text: "想想" }] },
	]);
});

test("不需要补位的端点上，没有推理的助手轮不补合成推理项", () => {
	const input = toResponsesInput([user, assistant([{ type: "text", text: "好" }]), user], openai);
	assert.deepEqual(reasoningItems(input), [], "官方 OpenAI 对带 content 的推理项回 `maximum length 0`");
	// 说了要补的端点上照旧补（DeepSeek 的场景见 `reasoning-replay.test.ts`）。
	const deepseek = toResponsesInput([user, assistant([{ type: "text", text: "好" }]), user], { provider: "openai", model: "gpt-5.1", leadingReasoning: true });
	assert.equal(reasoningItems(deepseek).length, 1);
});

test("停下的那一轮只剩没写完的推理：这一轮整个不出现，要补位的端点上也不凭空补一个", () => {
	const input = toResponsesInput([user, assistant([{ type: "thinking", thinking: "想到一半", signature: "rs_cut" }], "aborted"), user], {
		provider: "openai",
		model: "gpt-5.1",
		leadingReasoning: true,
	});
	// 没有助手轮，就没有「助手轮要以推理项开头」这回事。
	assert.deepEqual(
		(input as Item[]).map((item) => item.type),
		["message", "message"],
	);
});

// ---------------------------------------------------------------------------
// 走一遍适配器：请求体长什么样
// ---------------------------------------------------------------------------

const model: ModelConfig = {
	id: "qa/gpt-5.1",
	providerId: "qa",
	modelId: "gpt-5.1",
	name: "QA",
	supportsThinking: true,
	supportsImages: false,
	supportsTools: true,
	contextWindow: 200000,
	maxOutputTokens: 32768,
};

const OK_STREAM = [
	{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
	{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "好" },
	{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
	{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
]
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

/**
 * 依次回放 `replies`（`string` 是 400 的错误信息，`null` 是一条正常的流），返回每次发出去的请求体。
 * 每个用例用自己的 provider id，学到的结论不串。
 */
async function bodies(
	providerId: string,
	config: ModelConfig,
	thinking: string | undefined,
	messages: Message[],
	replies: (string | null)[],
	baseUrl = "https://example.invalid",
): Promise<Record<string, any>[]> {
	const provider: ProviderConfig = { id: providerId, name: "QA", api: "openai-responses", apiKey: "test", baseUrl, enabled: true, models: [config] };
	const sent: Record<string, any>[] = [];
	let call = 0;
	const stream = openaiResponsesProvider.stream(provider, { ...config, providerId }, { systemPrompt: "", messages, tools: [] }, {
		thinking,
		retryAttempts: 1,
		fetch: (async (_url: string, init: { body: string }) => {
			sent.push(JSON.parse(init.body));
			const reply = replies[Math.min(call++, replies.length - 1)];
			return reply === null
				? new Response(OK_STREAM, { status: 200, headers: { "content-type": "text/event-stream" } })
				: new Response(JSON.stringify({ error: { message: reply } }), { status: 400 });
		}) as any,
	});
	for await (const _ of stream);
	return sent;
}

test("组织没验证、不让要推理摘要：撤掉 summary 重发，effort 和 include 不动", async () => {
	const said =
		"Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization.";
	const [first, second, third] = await bodies("unverified", model, "high", [user], [said, null]);
	assert.deepEqual(first.reasoning, { effort: "high", summary: "auto" });
	assert.deepEqual(second.reasoning, { effort: "high" });
	assert.deepEqual(second.include, ["reasoning.encrypted_content"]);
	assert.equal(third, undefined, "只重发一次");
});

test("o3 这类不收 none 的模型，关思考时整个 reasoning 不发", async () => {
	for (const modelId of ["o3", "o4-mini", "openai/o3-mini", "o1", "gpt-5", "gpt-5-mini", "gpt-5-2025-08-07"]) {
		const [body] = await bodies("o-series", { ...model, id: `qa/${modelId}`, modelId }, "off", [user], [null]);
		assert.equal(body.reasoning, undefined, modelId);
	}
	for (const modelId of ["gpt-5.1", "gpt-4o", "gpt-5.2-codex"]) {
		const [body] = await bodies("o-series", { ...model, id: `qa/${modelId}`, modelId }, "off", [user], [null]);
		assert.deepEqual(body.reasoning, { effort: "none" }, modelId);
	}
});

test("没登记的模型用 o3 的说法拒 none：学到之后不再发 reasoning", async () => {
	for (const said of [
		"Unsupported value: 'reasoning.effort' does not support 'none' with this model. Supported values are: 'low', 'medium', and 'high'.",
		"Unsupported value: 'none' is not supported with the 'o3' model. Supported values are: 'low', 'medium', and 'high'.",
	]) {
		const [first, second] = await bodies(`none-${said.length}`, { ...model, id: "qa/relay-reasoner", modelId: "relay-reasoner" }, "off", [user], [said, null]);
		assert.deepEqual(first.reasoning, { effort: "none" });
		assert.ok(second, `学不到就不会重发：${said}`);
		assert.equal(second.reasoning, undefined, said);
	}
});

test("补位只在 DeepSeek 上默认开：官方 OpenAI 上没有推理的助手轮原样发", async () => {
	const history: Message[] = [user, assistant([{ type: "text", text: "好" }]), user];
	const [plain] = await bodies("lead-openai", model, "high", history, [null]);
	assert.deepEqual(reasoningItems(plain.input), []);

	const byModel = { ...model, id: "qa/deepseek-v4-flash", modelId: "deepseek-v4-flash" };
	const [ds] = await bodies("lead-ds", byModel, "high", [user, { ...assistant([{ type: "text", text: "好" }]), model: "deepseek-v4-flash" }, user], [null]);
	assert.equal(reasoningItems(ds.input).length, 1, "模型名里有 deepseek");

	const [byHost] = await bodies("lead-host", model, "high", history, [null], "https://api.deepseek.com");
	assert.equal(reasoningItems(byHost.input).length, 1, "直连 api.deepseek.com");
});

test("名字里看不出是 DeepSeek 的中转：撞上那句 400 之后补位，重发", async () => {
	const said = "The `reasoning_text` in the thinking mode must be passed back to the API.";
	const history: Message[] = [user, assistant([{ type: "text", text: "好" }]), user];
	const [first, second] = await bodies("lead-learn", model, "high", history, [said, null]);
	assert.deepEqual(reasoningItems(first.input), []);
	assert.equal(reasoningItems(second.input).length, 1);
});
