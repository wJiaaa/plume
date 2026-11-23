/**
 * ChatGPT 套餐通道（`ProviderRoute` 的 `chatgpt-plan`）：地址和 API key 一样，规矩不同，按供应商的声明组请求。
 * 规矩出自官方「Preview limitations」「Errors and recovery」两页（见 `types/provider.ts`、`failure.ts` 的注释）；
 * 这里守的是：带声明时按那张表发，不带时和从前一字不差。
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyFailure } from "../src/ai/failure.ts";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { resetReasoningCompat } from "../src/ai/reasoning-compat.ts";
import { resetRequestParamsCompat } from "../src/ai/request-params-compat.ts";
import type { Message, ModelConfig, ProviderConfig } from "../src/types.ts";

const OK =
	[
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, delta: "好" },
		{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", content: [{ type: "output_text", text: "好" }] } },
		{ type: "response.completed", response: { id: "r1", usage: { input_tokens: 10, output_tokens: 1 } } },
	]
		.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}`)
		.join("\n\n") + "\n\n";

/** 一轮调过工具的历史：回放时 `function_call` 要不要带 namespace 就看它。 */
const history: Message[] = [
	{ role: "user", content: [{ type: "text", text: "读一下" }], timestamp: 1 },
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
		api: "openai-responses",
		provider: "p",
		model: "m",
		usage: { input: 0, output: 0 },
		stopReason: "toolUse",
		timestamp: 2,
	},
	{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "内容" }], isError: false, timestamp: 3 },
] as Message[];

async function send(route: ProviderConfig["route"]): Promise<Record<string, unknown>> {
	resetRequestParamsCompat();
	resetReasoningCompat();
	const provider: ProviderConfig = {
		id: route ? "chatgpt" : "openai",
		name: "P",
		baseUrl: "https://api.openai.com/v1",
		api: "openai-responses",
		apiKey: "k",
		enabled: true,
		models: [],
		...(route ? { route } : {}),
	};
	const model: ModelConfig = {
		id: `${provider.id}/m`,
		providerId: provider.id,
		modelId: "m",
		name: "m",
		contextWindow: 100_000,
		maxOutputTokens: 1000,
		supportsThinking: false,
		supportsImages: false,
		supportsTools: true,
		samplingParams: { top_p: 0.9 },
	};
	let body: Record<string, unknown> | undefined;
	const fetchStub = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		body = JSON.parse(String(init?.body));
		return new Response(OK, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	for await (const _event of openaiResponsesProvider.stream(
		provider,
		model,
		{
			systemPrompt: "你是助手",
			messages: history,
			tools: [{ name: "read", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } }],
		},
		{ retryAttempts: 1, fetch: fetchStub as typeof globalThis.fetch, temperature: 0.3, maxTokens: 500 },
	)) {
		// 只看发出去的请求体。
	}
	assert.ok(body, "应该发出了请求");
	return body;
}

const replayedCall = (body: Record<string, unknown>) =>
	(body.input as Array<Record<string, unknown>>).find((item) => item.type === "function_call") as Record<string, unknown>;

test("套餐通道：不带 max_output_tokens、temperature 和模型的采样参数；系统提示词照旧放 instructions", async () => {
	const body = await send("chatgpt-plan");
	for (const field of ["max_output_tokens", "temperature", "top_p"]) assert.equal(field in body, false, `${field} 这条通道不收`);
	assert.equal(body.instructions, "你是助手");
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
});

test("套餐通道：工具包成一个 namespace，回放的 function_call 带上同一个 namespace", async () => {
	const body = await send("chatgpt-plan");
	const tools = body.tools as Array<Record<string, unknown>>;
	assert.equal(tools.length, 1);
	assert.equal(tools[0].type, "namespace");
	assert.equal((tools[0].tools as Array<Record<string, unknown>>)[0].name, "read");
	assert.equal(replayedCall(body).namespace, tools[0].name);
});

test("不带通道：请求体和从前一样，平铺的函数、没有 namespace", async () => {
	const body = await send(undefined);
	assert.equal(body.max_output_tokens, 500);
	assert.equal(body.top_p, 0.9);
	const tools = body.tools as Array<Record<string, unknown>>;
	assert.equal(tools[0].type, "function");
	assert.equal("namespace" in replayedCall(body), false);
});

const LIMIT = JSON.stringify({
	error: { type: "usage_limit", code: "subscription_sharing_usage_limit_exceeded", message: "You've reached the usage limit for this app." },
});

test("套餐用量到顶（429，码只在 error.code 里）：判终局、提示去看用量，不当限流重试", () => {
	const failure = classifyFailure({ from: "status", status: 429, body: LIMIT });
	assert.equal(failure.kind, "fatal");
	assert.equal(failure.hint, "check-billing");
	assert.equal(failure.code, "provider-usage-limit");
});

test("套餐用量到顶出现在流里（response.failed）也一样", () => {
	const raw = JSON.stringify({ type: "response.failed", response: { error: JSON.parse(LIMIT).error } });
	const failure = classifyFailure({ from: "stream", message: "You've reached the usage limit for this app.", raw });
	assert.equal(failure.kind, "fatal");
	assert.equal(failure.hint, "check-billing");
	assert.equal(failure.code, "provider-usage-limit");
});

test("账号或工作区没有套餐资格：结构化码优先于 403 的通用 key 错误，并要求停用供应商", () => {
	const body = JSON.stringify({
		error: { code: "subscription_sharing_user_not_eligible", message: "This user is not eligible." },
	});
	const failure = classifyFailure({ from: "status", status: 403, body });
	assert.equal(failure.kind, "fatal");
	assert.equal(failure.summary, "所选账号或工作区不能使用 ChatGPT 套餐额度");
	assert.equal(failure.code, "provider-not-eligible");
});

test("不支持的能力和错误路由按请求配置错误分类，不被 400 的通用 fatal 吞掉", () => {
	for (const [code, summary] of [
		["subscription_sharing_unsupported_capability", "ChatGPT 套餐通道不支持这项请求能力"],
		["subscription_sharing_route_not_supported", "ChatGPT 套餐通道的请求地址或方法不受支持"],
	] as const) {
		const body = JSON.stringify({ error: { code, message: code } });
		const failure = classifyFailure({ from: "status", status: 400, body });
		assert.equal(failure.kind, "fatal");
		assert.equal(failure.summary, summary);
		assert.equal(failure.hint, "check-request");
	}
});

test("用量暂时查不到（503 subscription_sharing_usage_unavailable）照常重试", () => {
	const body = JSON.stringify({ error: { code: "subscription_sharing_usage_unavailable", message: "Usage availability could not be checked." } });
	assert.notEqual(classifyFailure({ from: "status", status: 503, body }).kind, "fatal");
});
