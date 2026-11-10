/**
 * 用量字段声明表：每个服务商变体一组样例 usage → 期望的四个桶。
 *
 * 样例形状取自各家文档或参考实现（出处与 `src/ai/usage-fields.ts` 里那一行的 `source` 相同）。
 * 每一组都顺带验两条不变式：四个桶不重叠（和等于服务商报的总输入 + 输出），没有负数。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUsage, readUsage } from "../src/ai/usage-fields.ts";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { anthropicMessagesProvider } from "../src/ai/anthropic-messages.ts";
import { emptyUsage, type ApiFormat, type AssistantMessage, type ModelConfig, type ProviderConfig } from "../src/types.ts";

interface Case {
	name: string;
	api: ApiFormat;
	raw: Record<string, unknown>;
	expect: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number };
}

const CASES: Case[] = [
	{
		name: "OpenAI Chat：prompt_tokens_details.cached_tokens，prompt_tokens 含命中",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 750 }, completion_tokens_details: { reasoning_tokens: 40 } },
		expect: { input: 250, output: 100, cacheRead: 750, cacheWrite: 0, reasoning: 40 },
	},
	{
		name: "DeepSeek：prompt_cache_hit_tokens / prompt_cache_miss_tokens",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 1200, completion_tokens: 30, prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: 176 },
		expect: { input: 176, output: 30, cacheRead: 1024, cacheWrite: 0 },
	},
	{
		name: "DeepSeek 全部命中：miss 为 0 就是 0，不回退去做减法",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 512, completion_tokens: 8, prompt_cache_hit_tokens: 512, prompt_cache_miss_tokens: 0 },
		expect: { input: 0, output: 8, cacheRead: 512, cacheWrite: 0 },
	},
	{
		name: "Kimi：顶层 cached_tokens",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 900, completion_tokens: 50, cached_tokens: 600 },
		expect: { input: 300, output: 50, cacheRead: 600, cacheWrite: 0 },
	},
	{
		name: "Kimi：prompt_tokens_details 里的命中与写入，三者互斥、合计等于 prompt_tokens",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 2000, completion_tokens: 10, cached_tokens: 1000, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 800 } },
		expect: { input: 200, output: 10, cacheRead: 1000, cacheWrite: 800 },
	},
	{
		name: "OpenRouter：cache_write_tokens 单独计，不从 cached_tokens 里扣",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 3000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2500 } },
		expect: { input: 500, output: 20, cacheRead: 0, cacheWrite: 2500 },
	},
	{
		name: "中转在标准位置填占位 0、真数在服务商字段里：取大于 0 的那个",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 640 },
		expect: { input: 360, output: 5, cacheRead: 640, cacheWrite: 0 },
	},
	{
		name: "Mistral 变体：num_cached_tokens",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 400, completion_tokens: 4, num_cached_tokens: 128 },
		expect: { input: 272, output: 4, cacheRead: 128, cacheWrite: 0 },
	},
	{
		name: "Mistral 变体：prompt_token_details（少一个 s）",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 400, completion_tokens: 4, prompt_token_details: { cached_tokens: 64 } },
		expect: { input: 336, output: 4, cacheRead: 64, cacheWrite: 0 },
	},
	{
		name: "LiteLLM 转发 Anthropic：顶层 cache_read_input_tokens / cache_creation_input_tokens",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 5000, completion_tokens: 60, cache_read_input_tokens: 3000, cache_creation_input_tokens: 1500 },
		expect: { input: 500, output: 60, cacheRead: 3000, cacheWrite: 1500 },
	},
	{
		name: "阿里云百炼显式缓存：prompt_tokens_details.cache_creation_input_tokens",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 1600, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 1500 } },
		expect: { input: 100, output: 7, cacheRead: 0, cacheWrite: 1500 },
	},
	{
		name: "顶层 cache_write_tokens",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 1000, completion_tokens: 1, cached_tokens: 200, cache_write_tokens: 300 },
		expect: { input: 500, output: 1, cacheRead: 200, cacheWrite: 300 },
	},
	{
		name: "缓存数比总输入还大（上游报错数）：input 不为负",
		api: "openai-chat-completions",
		raw: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 150 } },
		expect: { input: 0, output: 1, cacheRead: 150, cacheWrite: 0 },
	},
	{
		name: "Responses：input_tokens_details.cached_tokens",
		api: "openai-responses",
		raw: { input_tokens: 2000, output_tokens: 300, input_tokens_details: { cached_tokens: 1536 }, output_tokens_details: { reasoning_tokens: 200 } },
		expect: { input: 464, output: 300, cacheRead: 1536, cacheWrite: 0, reasoning: 200 },
	},
	{
		name: "Responses（OpenRouter）：input_tokens_details.cache_write_tokens 也在 input_tokens 里",
		api: "openai-responses",
		raw: { input_tokens: 2000, output_tokens: 10, input_tokens_details: { cached_tokens: 500, cache_write_tokens: 1000 } },
		expect: { input: 500, output: 10, cacheRead: 500, cacheWrite: 1000 },
	},
	{
		name: "Anthropic：input_tokens 不含缓存，原样放",
		api: "anthropic-messages",
		raw: { input_tokens: 12, output_tokens: 90, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000 },
		expect: { input: 12, output: 90, cacheRead: 40000, cacheWrite: 2000 },
	},
];

for (const c of CASES) {
	test(`用量表：${c.name}`, () => {
		const usage = emptyUsage();
		applyUsage(c.api, usage, c.raw);
		assert.equal(usage.input, c.expect.input);
		assert.equal(usage.output, c.expect.output);
		assert.equal(usage.cacheRead, c.expect.cacheRead);
		assert.equal(usage.cacheWrite, c.expect.cacheWrite);
		if (c.expect.reasoning !== undefined) assert.equal(usage.reasoning, c.expect.reasoning);
		assert.equal(usage.total, usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
	});
}

test("用量表：Anthropic 的 message_delta 只带 output 时，前一帧的输入和缓存不被清掉", () => {
	const usage = emptyUsage();
	applyUsage("anthropic-messages", usage, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 });
	applyUsage("anthropic-messages", usage, { output_tokens: 77 });
	assert.deepEqual([usage.input, usage.output, usage.cacheRead, usage.cacheWrite], [10, 77, 500, 20]);
});

test("用量表：含缓存的协议里，后一帧给了总输入却没给缓存字段，缓存桶归零而不是沿用上一帧", () => {
	const usage = emptyUsage();
	applyUsage("openai-chat-completions", usage, { prompt_tokens: 1000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 900 } });
	applyUsage("openai-chat-completions", usage, { prompt_tokens: 1000, completion_tokens: 2 });
	assert.deepEqual([usage.input, usage.cacheRead], [1000, 0]);
});

test("用量表：不是数字的字段一律当没有（null、字符串、负数）", () => {
	assert.deepEqual(readUsage("openai-chat-completions", { prompt_tokens: null, completion_tokens: "5", cached_tokens: -1 }), {});
});

// ---------------------------------------------------------------------------
// 两条非 Chat 链确实走这张表（Chat 链由 openai-chat-usage.test.ts 覆盖）
// ---------------------------------------------------------------------------

function providerOf(api: ApiFormat): ProviderConfig {
	return { id: "p", name: "P", baseUrl: "https://relay.example.com", api, apiKey: "k", enabled: true, models: [] };
}

const MODEL: ModelConfig = {
	id: "p/m",
	providerId: "p",
	modelId: "m",
	name: "m",
	contextWindow: 100_000,
	maxOutputTokens: 1000,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};

async function finalMessage(api: ApiFormat, sse: string): Promise<AssistantMessage | null> {
	const adapter = api === "openai-responses" ? openaiResponsesProvider : anthropicMessagesProvider;
	let done: AssistantMessage | null = null;
	for await (const event of adapter.stream(providerOf(api), MODEL, { systemPrompt: "", messages: [], tools: [] }, {
		retryAttempts: 1,
		fetch: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
	})) {
		if (event.type === "done") done = event.message;
	}
	return done;
}

test("Responses 链的收尾事件按表读缓存写入", async () => {
	const frames = [
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, delta: "ok" },
		{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", content: [{ type: "output_text", text: "ok" }] } },
		{
			type: "response.completed",
			response: { id: "r1", usage: { input_tokens: 2000, output_tokens: 10, input_tokens_details: { cached_tokens: 500, cache_write_tokens: 1000 } } },
		},
	];
	const done = await finalMessage("openai-responses", frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}`).join("\n\n") + "\n\n");
	assert.ok(done);
	assert.deepEqual([done.usage.input, done.usage.cacheRead, done.usage.cacheWrite, done.usage.output], [500, 500, 1000, 10]);
});

test("Anthropic 链两帧用量合并：message_start 的输入与缓存 + message_delta 的输出", async () => {
	const frames = [
		{ type: "message_start", message: { id: "msg", usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
		{ type: "message_stop" },
	];
	const done = await finalMessage("anthropic-messages", frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}`).join("\n\n") + "\n\n");
	assert.ok(done);
	assert.deepEqual([done.usage.input, done.usage.cacheRead, done.usage.cacheWrite, done.usage.output], [12, 4000, 300, 42]);
});
