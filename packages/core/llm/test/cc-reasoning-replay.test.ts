/**
 * Chat Completions 链把推理还回去的三件事：DeepSeek 要求缺推理的轮次也带一个空串、严格端点不许消息里有推理
 * 字段、内联 `<think>` 切出来的思考按原样包回正文。
 *
 * 错误串都是真实端点的原话形状；学习靠的就是它们。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiChatCompletionsProvider, resetChatCompletionsCompat } from "../src/ai/openai-chat-completions.ts";
import { toChatCompletionsMessages } from "../src/ai/openai-chat-completions-request.ts";
import { learnReasoningPadding, learnReasoningReplay, padsMissingReasoning, reasoningReplay, resetReasoningCompat } from "../src/ai/reasoning-compat.ts";
import { resetRequestParamsCompat } from "../src/ai/request-params-compat.ts";
import { THINK_TAG_FIELD } from "../src/ai/think-tag.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../src/types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** 一轮「没有思考文本却调了工具」——当时关着思考，或者中转把推理剥了。 */
function toolTurnWithoutThought(): Message[] {
	return [
		{ role: "user", content: [{ type: "text", text: "看看 a.ts" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
			api: "openai-chat-completions", provider: "deepseek", model: "deepseek-chat",
			usage, stopReason: "toolUse", timestamp: 2,
		},
		{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "export {}" }], isError: false, timestamp: 3 },
		{ role: "user", content: [{ type: "text", text: "继续" }], timestamp: 4 },
	] as Message[];
}

const DEEPSEEK_REQUIRES_400 = JSON.stringify({
	error: {
		message: "The `reasoning_content` in the thinking mode must be passed back to the API.",
		type: "invalid_request_error",
		param: null,
		code: "invalid_request_error",
	},
});

/** FastAPI / pydantic v2 的原样：Mistral 与自建网关都是这个形状。 */
const PYDANTIC_EXTRA_422 = JSON.stringify({
	detail: [
		{
			type: "extra_forbidden",
			loc: ["body", "messages", 1, "assistant", "reasoning_content"],
			msg: "Extra inputs are not permitted",
			input: "这是个纯算术问题。",
		},
	],
});

const OK_STREAM = [
	`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "好。" }, finish_reason: "stop" }] })}`,
	"data: [DONE]",
	"",
].join("\n\n");

const provider: ProviderConfig = {
	id: "deepseek",
	name: "DeepSeek",
	baseUrl: "https://api.deepseek.com",
	api: "openai-chat-completions",
	apiKey: "sk-test",
	enabled: true,
	models: [],
};

const model: ModelConfig = {
	id: "deepseek/deepseek-reasoner",
	providerId: "deepseek",
	modelId: "deepseek-reasoner",
	name: "DeepSeek",
	contextWindow: 128_000,
	maxOutputTokens: 4_096,
	supportsThinking: true,
	supportsImages: false,
	supportsTools: true,
};

async function runTurn(messages: Message[], responses: Array<{ status: number; body: string }>): Promise<{ bodies: Array<Record<string, any>>; done: AssistantMessage | null }> {
	resetChatCompletionsCompat();
	resetReasoningCompat();
	resetRequestParamsCompat();
	const bodies: Array<Record<string, any>> = [];
	let done: AssistantMessage | null = null;
	const fetchStub = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		bodies.push(JSON.parse(String(init?.body)));
		const next = responses[Math.min(bodies.length - 1, responses.length - 1)];
		return new Response(next.body, { status: next.status, headers: { "content-type": next.status === 200 ? "text/event-stream" : "application/json" } });
	};
	for await (const event of openaiChatCompletionsProvider.stream(provider, model, { systemPrompt: "", messages, tools: [] }, {
		retryAttempts: 1,
		thinking: "high",
		fetch: fetchStub as typeof globalThis.fetch,
	})) {
		if (event.type === "done") done = event.message;
	}
	return { bodies, done };
}

const assistantIn = (body: Record<string, any>): Record<string, unknown> => body.messages.find((m: { role: string }) => m.role === "assistant");

// ---------------------------------------------------------------------------
// DeepSeek：缺推理的轮次补空串
// ---------------------------------------------------------------------------

test("CC：默认不给缺推理的助手轮补字段——不认它的端点一个字节都不多收", () => {
	resetReasoningCompat();
	const assistant = (toChatCompletionsMessages("", toolTurnWithoutThought()) as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
	assert.ok(assistant && !("reasoning_content" in assistant));
});

test("CC：DeepSeek 说推理必须带回来、而那一轮手上没有时，学会补空串并立刻重发", async () => {
	const { bodies, done } = await runTurn(toolTurnWithoutThought(), [
		{ status: 400, body: DEEPSEEK_REQUIRES_400 },
		{ status: 200, body: OK_STREAM },
	]);
	assert.equal(bodies.length, 2);
	assert.ok(!("reasoning_content" in assistantIn(bodies[0])));
	assert.equal(assistantIn(bodies[1]).reasoning_content, "");
	assert.equal(done?.stopReason, "stop");
});

test("CC：补空串只在梯子顶格时学，只学一次；有思考文本的轮次照常发原文", () => {
	resetReasoningCompat();
	const said = "请求不被接受 The `reasoning_content` in the thinking mode must be passed back to the API.";
	assert.equal(learnReasoningPadding("p", "m", said), true);
	assert.equal(learnReasoningPadding("p", "m", said), false);
	assert.equal(padsMissingReasoning("p", "m"), true);
	assert.equal(padsMissingReasoning("p", "other"), false);

	// 梯子不在顶格：先让梯子把推理拉回来，这一步不学。
	resetReasoningCompat();
	learnReasoningReplay("p", "m", "Expected a(n) 'messages' array element to be an object");
	assert.equal(learnReasoningPadding("p", "m", said), false);

	const history = toolTurnWithoutThought();
	const withThought = history.map((m) =>
		m.role === "assistant" ? { ...m, content: [{ type: "thinking" as const, thinking: "先读文件。" }, ...m.content] } : m,
	) as Message[];
	const assistant = (toChatCompletionsMessages("", withThought, "replay", undefined, true) as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
	assert.equal(assistant?.reasoning_content, "先读文件。");
	// omit 那一档不补：端点说过不许带推理字段。
	const omitted = (toChatCompletionsMessages("", history, "omit", undefined, true) as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
	assert.ok(omitted && !("reasoning_content" in omitted));
});

// ---------------------------------------------------------------------------
// 严格端点：消息里不许有推理字段
// ---------------------------------------------------------------------------

test("CC：pydantic 的 extra_forbidden 点名 reasoning_content，一步退到 omit", () => {
	resetReasoningCompat();
	assert.equal(learnReasoningReplay("p", "m", `请求参数不合法 ${PYDANTIC_EXTRA_422}`), true);
	assert.equal(reasoningReplay("p", "m"), "omit");
	// 已经在底下，再撞也不重发。
	assert.equal(learnReasoningReplay("p", "m", `请求参数不合法 ${PYDANTIC_EXTRA_422}`), false);
});

test("CC：Groq 说 property 'reasoning_content' is unsupported，也退到 omit；裸的 reasoning 要在消息里才算", () => {
	resetReasoningCompat();
	assert.equal(learnReasoningReplay("p", "m", "'messages.1' : for 'role:assistant' the following must be satisfied[('messages.1' : property 'reasoning_content' is unsupported)]"), true);
	assert.equal(reasoningReplay("p", "m"), "omit");
	resetReasoningCompat();
	assert.equal(learnReasoningReplay("p", "m", "'messages.3' : property 'reasoning' is unsupported"), true);
	assert.equal(reasoningReplay("p", "m"), "omit");
});

test("CC：点名的是 reasoning_effort、reasoning.effort 或请求参数 reasoning 时不动推理", () => {
	resetReasoningCompat();
	for (const said of [
		"Unsupported parameter: 'reasoning_effort' is not supported with this model.",
		"Unsupported parameter: 'reasoning.effort' is not supported with this model.",
		"Unknown parameter: 'reasoning'.",
		"The `reasoning_content` in the thinking mode must be passed back to the API.",
	]) {
		learnReasoningReplay("p", "m", said);
		assert.equal(reasoningReplay("p", "m"), "replay", said);
	}
});

test("CC：撞上 422 extra_forbidden 后重发的那一份里没有推理字段", async () => {
	const history = toolTurnWithoutThought().map((m) =>
		m.role === "assistant" ? { ...m, content: [{ type: "thinking" as const, thinking: "这是个纯算术问题。" }, ...m.content] } : m,
	) as Message[];
	const { bodies, done } = await runTurn(history, [
		{ status: 422, body: PYDANTIC_EXTRA_422 },
		{ status: 200, body: OK_STREAM },
	]);
	assert.equal(bodies.length, 2);
	assert.equal(assistantIn(bodies[0]).reasoning_content, "这是个纯算术问题。");
	assert.ok(!("reasoning_content" in assistantIn(bodies[1])));
	assert.equal(done?.stopReason, "stop");
});

// ---------------------------------------------------------------------------
// 内联 <think> 的回放
// ---------------------------------------------------------------------------

test("CC：从 <think> 里切出来的思考按原样包回正文前面，不改成 reasoning_content", () => {
	const history = [
		{ role: "user", content: [{ type: "text", text: "在吗" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "thinking", thinking: "\n用户在打招呼。\n", reasoningField: THINK_TAG_FIELD }, { type: "text", text: "在的。" }],
			api: "openai-chat-completions", provider: "minimax", model: "MiniMax-M2", usage, stopReason: "stop", timestamp: 2,
		},
	] as Message[];
	const assistant = (toChatCompletionsMessages("", history) as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
	assert.equal(assistant?.content, "<think>\n用户在打招呼。\n</think>\n\n在的。");
	assert.ok(assistant && !("reasoning_content" in assistant) && !(THINK_TAG_FIELD in assistant));
	// 端点不收推理时，正文就是正文。
	const omitted = (toChatCompletionsMessages("", history, "omit") as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
	assert.equal(omitted?.content, "在的。");
});
