/**
 * 三条链上「看着像空回答、其实不是」的几种失败。
 *
 * 从前它们一律落进空回答：重试四次、原文丢掉、界面上只有一句「服务商返回了空回答」。
 *
 *   1. 200 但正文不是 SSE——中转把错误写成 JSON、地址指到了网页、端点无视 `stream: true` 回了整份 JSON；
 *   2. 流里的错误帧换了写法——`event: error`、`code` 非 0、`success: false`；
 *   3. 推理把输出上限用完——一个字的正文都没有，可那不是故障，重发一百次还是这样。
 *
 * fetch 换成假的，正文按各家真实发出来的样子写。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicMessagesProvider, resetThinkingReplay } from "../src/ai/anthropic-messages.ts";
import { openaiChatCompletionsProvider, resetChatCompletionsCompat } from "../src/ai/openai-chat-completions.ts";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { resetReasoningCompat } from "../src/ai/reasoning-compat.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig } from "../src/types.ts";

type Api = "anthropic-messages" | "openai-chat-completions" | "openai-responses";
const APIS: Api[] = ["anthropic-messages", "openai-chat-completions", "openai-responses"];
const PROVIDERS = {
	"anthropic-messages": anthropicMessagesProvider,
	"openai-chat-completions": openaiChatCompletionsProvider,
	"openai-responses": openaiResponsesProvider,
};

const model = (api: Api): ModelConfig => ({
	id: `shape-${api}/m`,
	providerId: `shape-${api}`,
	modelId: "m",
	name: "M",
	contextWindow: 128_000,
	maxOutputTokens: 4_096,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
});

const provider = (api: Api): ProviderConfig => ({
	id: `shape-${api}`,
	name: "中转",
	baseUrl: "https://relay.example.com",
	api,
	apiKey: "sk-test",
	enabled: true,
	models: [],
});

interface Ran {
	done: AssistantMessage | null;
	failed: AssistantMessage | null;
	calls: number;
}

async function run(api: Api, respond: () => Response): Promise<Ran> {
	resetReasoningCompat();
	resetChatCompletionsCompat();
	resetThinkingReplay();
	let done: AssistantMessage | null = null;
	let failed: AssistantMessage | null = null;
	let calls = 0;
	for await (const event of PROVIDERS[api].stream(
		provider(api),
		model(api),
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "在吗" }], timestamp: 1 }], tools: [] },
		{
			retryAttempts: 1,
			fetch: async () => {
				calls++;
				return respond();
			},
		},
	)) {
		if (event.type === "done") done = event.message;
		if (event.type === "error") failed = event.message;
	}
	return { done, failed, calls };
}

const sse = (frames: string[], type = "text/event-stream") => () => new Response(`${frames.join("\n\n")}\n\n`, { status: 200, headers: { "content-type": type } });
const data = (body: unknown) => `data: ${JSON.stringify(body)}`;

// ---------------------------------------------------------------------------
// 1. 200 但正文不是 SSE
// ---------------------------------------------------------------------------

for (const api of APIS) {
	test(`${api}：200 加 JSON 错误体，按错误体判，原文留着`, async () => {
		const body = JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota" } });
		const { failed } = await run(api, () => new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));
		assert.ok(failed?.failure, "应当失败");
		assert.equal(failed.failure.kind, "fatal", failed.failure.summary);
		assert.equal(failed.failure.hint, "check-billing");
		assert.match(failed.failure.detail ?? "", /exceeded your current quota/);
	});

	test(`${api}：200 加一页 HTML，说出是网页、原文留着`, async () => {
		const html = "<!DOCTYPE html><html><head><title>控制台</title></head><body>欢迎</body></html>";
		const { failed } = await run(api, () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
		assert.ok(failed?.failure);
		assert.match(failed.failure.summary, /网页/);
		assert.match(failed.failure.detail ?? "", /<title>控制台/);
	});
}

test("CC：端点无视 stream 回了整份 JSON，说清楚是没按流式返回", async () => {
	const whole = JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }] });
	const { failed } = await run("openai-chat-completions", () => new Response(whole, { status: 200, headers: { "content-type": "application/json" } }));
	assert.ok(failed?.failure);
	assert.match(failed.failure.summary, /流式/);
	assert.match(failed.failure.detail ?? "", /chat\.completion/);
});

test("CC：把 SSE 标成 text/plain 或 application/json 的中转照常能用", async () => {
	const frames = [data({ choices: [{ index: 0, delta: { content: "在" }, finish_reason: null }] }), data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), "data: [DONE]"];
	for (const type of ["text/plain", "application/json"]) {
		const { done } = await run("openai-chat-completions", sse(frames, type));
		assert.equal(done?.content[0]?.type === "text" && done.content[0].text, "在", type);
	}
});

// ---------------------------------------------------------------------------
// 2. 流里错误帧的其他写法
// ---------------------------------------------------------------------------

test("CC：`event: error` 帧是错误，说的话就是摘要", async () => {
	const { failed } = await run("openai-chat-completions", sse([`event: error\n${data({ message: "upstream overloaded, retry later" })}`]));
	assert.match(failed?.failure?.summary ?? "", /upstream overloaded/);
});

test("CC：顶层 `code` 非 0 且带一句话的帧是错误", async () => {
	const { failed } = await run("openai-chat-completions", sse([data({ code: 500, msg: "内部错误，请稍后重试" })]));
	assert.match(failed?.failure?.summary ?? "", /内部错误/);
});

test("CC：中转的成功、心跳帧（`code: \"0000\"`、`10000`）不是错误", async () => {
	for (const code of ["0000", "000000", 10000, 0]) {
		const { failed, done } = await run(
			"openai-chat-completions",
			sse([data({ code, msg: "成功" }), data({ choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }] }), "data: [DONE]"]),
		);
		assert.equal(failed, null, String(code));
		assert.ok(done, String(code));
	}
});

test("CC：`success: false` 的帧是错误", async () => {
	const { failed } = await run("openai-chat-completions", sse([data({ success: false, message: "模型服务异常" })]));
	assert.match(failed?.failure?.summary ?? "", /模型服务异常/);
});

test("CC：`code: 0` 的正常帧不算错误", async () => {
	const { done } = await run("openai-chat-completions", sse([data({ code: 0, msg: "success", choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }] }), "data: [DONE]"]));
	assert.equal(done?.content[0]?.type === "text" && done.content[0].text, "好");
});

test("Anthropic：只有 `event: error`、数据里没有 type 的错误帧也认", async () => {
	const { failed } = await run("anthropic-messages", sse([`event: error\n${data({ error: { type: "overloaded_error", message: "Overloaded" } })}`]));
	assert.match(failed?.failure?.summary ?? "", /Overloaded/);
});

// ---------------------------------------------------------------------------
// 3. 推理把输出上限用完
// ---------------------------------------------------------------------------

const exhausted: Record<Api, string[]> = {
	"anthropic-messages": [
		data({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
		data({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4096 } }),
		data({ type: "message_stop" }),
	],
	"openai-chat-completions": [
		data({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
		data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } } }),
		"data: [DONE]",
	],
	"openai-responses": [
		data({ type: "response.incomplete", response: { id: "resp_1", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 10, output_tokens: 4096 } } }),
	],
};

for (const api of APIS) {
	test(`${api}：推理把输出上限用完，不当空回答重试，直接说原因`, async () => {
		const { failed, done } = await run(api, sse(exhausted[api]));
		assert.equal(done, null, "不是一条正常结束的空回答");
		assert.equal(failed?.failure?.kind, "fatal");
		assert.match(failed?.failure?.summary ?? "", /输出上限/);
	});
}

test("CC：正常结束、推理花了 token 却一个字没有，是偶发的空回答，照旧重试", async () => {
	const { failed } = await run(
		"openai-chat-completions",
		sse([data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 900 } } }), "data: [DONE]"]),
	);
	assert.equal(failed?.failure?.kind, "upstream");
});

test("CC：只报了一个结束符的输出 token、没有推理的空回答，照旧重试", async () => {
	const { failed } = await run(
		"openai-chat-completions",
		sse([data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }), "data: [DONE]"]),
	);
	assert.equal(failed?.failure?.kind, "upstream");
});

test("CC：真正的空流照旧是可重试的空回答", async () => {
	const { failed } = await run("openai-chat-completions", sse([data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), "data: [DONE]"]));
	assert.equal(failed?.failure?.kind, "upstream");
	assert.equal(failed?.failure?.summary, "服务商返回了空回答");
});
