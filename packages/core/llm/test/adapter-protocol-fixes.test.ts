/**
 * 三条协议适配器的一批回归：学习键一致、重试间的状态清理、结束原因映射、并行工具调用、按次计价、
 * Anthropic 的思考写法与缓存断点。全部走真实的适配器链路，fetch 注入，断言的是发出去的请求体和交回
 * loop 的那条消息——这些毛病在单个函数的单测里都看不出来，只在「学到之后下一发长什么样」上看得出来。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicMessagesProvider, learnThinkingReplay, resetThinkingReplay, thinkingReplay } from "../src/ai/anthropic-messages.ts";
import { toAnthropicMessages } from "../src/ai/anthropic-messages-request.ts";
import { openaiChatCompletionsProvider } from "../src/ai/openai-chat-completions.ts";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { classifyFailure, isContextOverflow } from "../src/ai/failure.ts";
import { resetReasoningCompat } from "../src/ai/reasoning-compat.ts";
import { droppedParams, learnDroppedParam, resetRequestParamsCompat } from "../src/ai/request-params-compat.ts";
import { resetToolPairingCompat, toolPairing } from "../src/ai/tool-pairing-compat.ts";
import { emptyUsage } from "../src/types.ts";
import type { AssistantMessage, LlmContext, Message, ModelConfig, ProviderConfig, RequestOptions } from "../src/types.ts";

// ---------------------------------------------------------------------------
// 共用的小零件
// ---------------------------------------------------------------------------

function modelOf(api: ProviderConfig["api"], overrides: Partial<ModelConfig> = {}): { provider: ProviderConfig; model: ModelConfig } {
	// `id` 和 `modelId` 故意不同：学习键拼错字段的那种漂移，只有两者不同时才看得出来。
	const model: ModelConfig = {
		id: "qa/wire-model", providerId: "qa", modelId: "wire-model", name: "Wire",
		contextWindow: 1_000_000, maxOutputTokens: 8192, supportsThinking: true, supportsImages: true, supportsTools: true,
		...overrides,
	};
	const provider: ProviderConfig = { id: "qa", name: "QA", api, baseUrl: "https://relay.example.test", apiKey: "k", enabled: true, models: [model] };
	return { provider, model };
}

type Reply = { status: number; body: string; headers?: Record<string, string> };

/** 把一条流跑到底：每次 fetch 依次取一个回复，记下请求体和请求头。 */
async function drive(
	stream: (fetch: typeof globalThis.fetch) => AsyncGenerator<{ type: string; message?: AssistantMessage }, AssistantMessage>,
	replies: Reply[],
) {
	const bodies: Record<string, any>[] = [];
	const headers: Record<string, string>[] = [];
	let calls = 0;
	const fetch = (async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		headers.push({ ...(init.headers as Record<string, string>) });
		const reply = replies[Math.min(calls++, replies.length - 1)];
		return new Response(reply.body, { status: reply.status, headers: { "content-type": "text/event-stream", ...reply.headers } });
	}) as typeof globalThis.fetch;
	let message: AssistantMessage | undefined;
	for await (const event of stream(fetch)) {
		if (event.type === "done" || event.type === "error") message = event.message;
	}
	return { message: message!, bodies, headers, calls };
}

const quick: RequestOptions = { retryPolicy: { network: { retries: 3, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 }, upstream: { retries: 3, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 } } };

/** 重试之间不真睡：把策略间隔压到 0 不合法（规范化成至少 1 秒），所以直接替掉 setTimeout。 */
async function withoutSleep<T>(run: () => Promise<T>): Promise<T> {
	const original = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => original(fn, 0)) as typeof globalThis.setTimeout;
	try {
		return await run();
	} finally {
		globalThis.setTimeout = original;
	}
}

const userSays = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

const error400 = (message: string): Reply => ({ status: 400, body: JSON.stringify({ error: { message, type: "invalid_request_error" } }) });

// ---------------------------------------------------------------------------
// 1. 学习键：学到的结论下一发就用上
// ---------------------------------------------------------------------------

const responsesOk: Reply = {
	status: 200,
	body: [
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
		{ type: "response.output_text.delta", output_index: 0, delta: "好" },
		{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
		{ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 1 } } },
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
};

test("Responses：撞上「工具调用没对上结果」学到交错，重发的那一发就是交错的形状", async () => {
	resetToolPairingCompat();
	resetReasoningCompat();
	resetRequestParamsCompat();
	const { provider, model } = modelOf("openai-responses", { supportsThinking: false });
	const assistant: AssistantMessage = {
		role: "assistant", api: "openai-responses", provider: "qa", model: "wire-model", usage: emptyUsage(), stopReason: "toolUse", timestamp: 1,
		content: [
			{ type: "toolCall", id: "a", name: "bash", arguments: {}, argumentsText: "{}" },
			{ type: "toolCall", id: "b", name: "glob", arguments: {}, argumentsText: "{}" },
		],
	};
	const history: Message[] = [
		userSays("看看项目"),
		assistant,
		{ role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },
		{ role: "toolResult", toolCallId: "b", toolName: "glob", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
	];
	const context: LlmContext = { systemPrompt: "", messages: history, tools: [] };
	const order = (body: Record<string, any>) =>
		(body.input as { type: string; call_id?: string }[]).filter((item) => item.call_id).map((item) => `${item.type}:${item.call_id}`);

	const { bodies, message } = await drive(
		(fetch) => openaiResponsesProvider.stream(provider, model, context, { fetch }),
		[error400("The following tool_call_ids did not have response messages: a"), responsesOk],
	);
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(order(bodies[0]), ["function_call:a", "function_call:b", "function_call_output:a", "function_call_output:b"], "默认成组");
	assert.deepEqual(order(bodies[1]), ["function_call:a", "function_call_output:a", "function_call:b", "function_call_output:b"], "学到之后重发的就是交错");
	assert.equal(toolPairing(provider.id, model.id), "interleaved");

	// 下一次请求一开始就是新形状，不用再撞一次。
	const next = await drive((fetch) => openaiResponsesProvider.stream(provider, model, context, { fetch }), [responsesOk]);
	assert.equal(next.calls, 1);
	assert.deepEqual(order(next.bodies[0]), ["function_call:a", "function_call_output:a", "function_call:b", "function_call_output:b"]);
});

// ---------------------------------------------------------------------------
// 2. reasoning-off 只在确实发了 none 时才学
// ---------------------------------------------------------------------------

test("开着思考、只是档位被拒时，不学 reasoning-off", () => {
	resetRequestParamsCompat();
	const said = "Invalid value: 'xhigh'. Supported values for reasoning.effort are: 'none', 'low', 'medium', and 'high'.";
	assert.equal(learnDroppedParam("qa", "m", said), false, "错误串里提到 none 不等于 none 被拒");
	assert.equal(learnDroppedParam("qa", "m", "reasoning.effort 'xhigh' is not supported with this model", { reasoningOff: false }), false);
	assert.equal(droppedParams("qa", "m").has("reasoning-off"), false);
	// 真的是 none 被拒：照学。
	assert.equal(learnDroppedParam("qa", "m", "reasoning.effort 'none' is not supported", { reasoningOff: true }), true);
	assert.equal(droppedParams("qa", "m").has("reasoning-off"), true);
});

test("Chat：xhigh 被拒只发一次、不误学，关思考那条以后照常明说", async () => {
	resetRequestParamsCompat();
	resetReasoningCompat();
	const { provider, model } = modelOf("openai-chat-completions");
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	const { calls, message } = await drive(
		(fetch) => openaiChatCompletionsProvider.stream(provider, model, context, { fetch, thinking: "xhigh" }),
		[error400("Invalid value for reasoning.effort: 'xhigh' is not supported with this model.")],
	);
	assert.equal(message.stopReason, "error");
	assert.equal(calls, 1, "学不到东西就不该原样重发");
	assert.equal(droppedParams(provider.id, model.id).has("reasoning-off"), false);
});

// ---------------------------------------------------------------------------
// 3. Chat：重试之间的 stopReason、并行工具调用、按次计价
// ---------------------------------------------------------------------------

const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, ...choice }], ...extra })}\n\n`;

test("Chat：上一次尝试的 length 不会带到重试成功的那条上", async () => {
	const { provider, model } = modelOf("openai-chat-completions", { supportsThinking: false });
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	const first = chunk({ delta: { content: "半" }, finish_reason: "length" }) + `data: ${JSON.stringify({ error: { message: "upstream hiccup" } })}\n\n`;
	// 第二次：只靠 [DONE] 收尾、不发 finish_reason 的宿主。
	const second = chunk({ delta: { content: "完整回答" } }) + "data: [DONE]\n\n";
	const { message, calls } = await withoutSleep(() =>
		drive((fetch) => openaiChatCompletionsProvider.stream(provider, model, context, { ...quick, fetch }), [{ status: 200, body: first }, { status: 200, body: second }]),
	);
	assert.equal(calls, 2);
	assert.equal(message.stopReason, "stop", `带着上一次的 ${message.stopReason} 交出去了`);
});

test("拒答在三条链上是同一个结局：内容策略、不重试，不是一条空回答", async () => {
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	const chat = modelOf("openai-chat-completions", { supportsThinking: false });
	const chatRefusal = chunk({ delta: { refusal: "I can't " } }) + chunk({ delta: { refusal: "help with that." }, finish_reason: "stop" }) + "data: [DONE]\n\n";
	const responses = modelOf("openai-responses", { supportsThinking: false });
	const events = (streamed: boolean) => [
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
		...(streamed ? [{ type: "response.refusal.delta", output_index: 0, delta: "I can't help with that." }] : []),
		{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", content: [{ type: "refusal", refusal: "I can't help with that." }] } },
		{ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 5 } } },
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	const runs = [
		() => drive((fetch) => openaiChatCompletionsProvider.stream(chat.provider, chat.model, context, { ...quick, fetch }), [{ status: 200, body: chatRefusal }]),
		() => drive((fetch) => openaiResponsesProvider.stream(responses.provider, responses.model, context, { ...quick, fetch }), [{ status: 200, body: events(true) }]),
		() => drive((fetch) => openaiResponsesProvider.stream(responses.provider, responses.model, context, { ...quick, fetch }), [{ status: 200, body: events(false) }]),
	];
	for (const run of runs) {
		const { message, calls } = await withoutSleep(run);
		assert.equal(calls, 1, "同样的输入再问还是同样的拒绝");
		assert.equal(message.stopReason, "error");
		assert.equal(message.failure?.hint, "blocked");
		assert.match(message.errorMessage ?? "", /拒绝|安全策略/);
	}
});

test("Chat：不带 index 的并行工具调用各是各的，不拼成一个", async () => {
	const { provider, model } = modelOf("openai-chat-completions", { supportsThinking: false });
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	const body = [
		chunk({ delta: { tool_calls: [{ id: "call_a", function: { name: "read", arguments: "" } }] } }),
		chunk({ delta: { tool_calls: [{ function: { arguments: '{"path":' } }] } }),
		chunk({ delta: { tool_calls: [{ function: { arguments: '"a.ts"}' } }] } }),
		chunk({ delta: { tool_calls: [{ id: "call_b", function: { name: "read", arguments: '{"path":"b.ts"}' } }] } }),
		chunk({ delta: {}, finish_reason: "tool_calls" }),
		"data: [DONE]\n\n",
	].join("");
	const { message } = await drive((fetch) => openaiChatCompletionsProvider.stream(provider, model, context, { fetch }), [{ status: 200, body }]);
	const calls = message.content.filter((c) => c.type === "toolCall");
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((c) => [c.id, c.arguments]), [["call_a", { path: "a.ts" }], ["call_b", { path: "b.ts" }]]);
	assert.equal(message.stopReason, "toolUse");
});

test("Chat：index 都给 0、id 各不相同的中转，也分得开", async () => {
	const { provider, model } = modelOf("openai-chat-completions", { supportsThinking: false });
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	const body = [
		chunk({ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: '{"path":"a.ts"}' } }] } }),
		chunk({ delta: { tool_calls: [{ index: 0, id: "call_b", function: { name: "read", arguments: '{"path":' } }] } }),
		chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: '"b.ts"}' } }] } }),
		chunk({ delta: {}, finish_reason: "tool_calls" }),
		"data: [DONE]\n\n",
	].join("");
	const { message } = await drive((fetch) => openaiChatCompletionsProvider.stream(provider, model, context, { fetch }), [{ status: 200, body }]);
	const calls = message.content.filter((c) => c.type === "toolCall");
	assert.deepEqual(calls.map((c) => [c.id, c.arguments]), [["call_a", { path: "a.ts" }], ["call_b", { path: "b.ts" }]]);
});

test("按每次尝试各自的档位计价再相加，不按加总后的上下文长度挑长上下文档", async () => {
	const pricing = { input: 1, output: 0, tiers: [{ aboveTokens: 200_000, input: 2 }] };
	const { provider, model } = modelOf("openai-chat-completions", { supportsThinking: false, pricing });
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	const usage = { prompt_tokens: 150_000, completion_tokens: 0 };
	const failed = chunk({ delta: { content: "半" } }, { usage }) + `data: ${JSON.stringify({ error: { message: "upstream hiccup" } })}\n\n`;
	const ok = chunk({ delta: { content: "好" }, finish_reason: "stop" }, { usage }) + "data: [DONE]\n\n";
	const { message } = await withoutSleep(() =>
		drive((fetch) => openaiChatCompletionsProvider.stream(provider, model, context, { ...quick, fetch }), [{ status: 200, body: failed }, { status: 200, body: ok }]),
	);
	assert.equal(message.usage.input, 300_000);
	// 两次各 150k，都在 200k 档以下：0.15 + 0.15。按加总的 300k 计会是 0.6。
	assert.ok(Math.abs(message.usage.cost.total - 0.3) < 1e-9, `cost ${message.usage.cost.total}`);
});

// ---------------------------------------------------------------------------
// 4. Anthropic：结束原因、思考写法、回放档位、请求头、缓存断点
// ---------------------------------------------------------------------------

const frame = (type: string, rest: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;

const anthropicReply = (stopReason: string, text = "内容"): Reply => ({
	status: 200,
	body: [
		frame("message_start", { message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } }),
		...(text
			? [
					frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
					frame("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
					frame("content_block_stop", { index: 0 }),
				]
			: []),
		frame("message_delta", { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } }),
		frame("message_stop"),
	].join(""),
});

test("Anthropic：refusal 是明确的拒绝，不重试、不当成说完了", async () => {
	const { provider, model } = modelOf("anthropic-messages", { supportsThinking: false });
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	for (const text of ["说到一半", ""]) {
		const { message, calls } = await withoutSleep(() =>
			drive((fetch) => anthropicMessagesProvider.stream(provider, model, context, { ...quick, fetch }), [anthropicReply("refusal", text)]),
		);
		assert.equal(calls, 1, "同样的输入再问还是同样的拒绝");
		assert.equal(message.stopReason, "error");
		assert.equal(message.failure?.hint, "blocked");
		assert.equal(message.errorRetryable, false);
	}
});

test("Anthropic：上下文窗口满和 pause_turn 都不冒充说完了", async () => {
	const { provider, model } = modelOf("anthropic-messages", { supportsThinking: false });
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	for (const [raw, expected] of [["pause_turn", "length"], ["max_tokens", "length"], ["end_turn", "stop"], ["stop_sequence", "stop"]]) {
		const { message } = await drive((fetch) => anthropicMessagesProvider.stream(provider, model, context, { fetch }), [anthropicReply(raw)]);
		assert.equal(message.stopReason, expected, raw);
	}
	// 窗口满不是输出上限：接着写还会撞，要按上下文超长交给 loop 压缩后重发。
	const { message, calls } = await withoutSleep(() => drive((fetch) => anthropicMessagesProvider.stream(provider, model, context, { fetch }), [anthropicReply("model_context_window_exceeded", "说到一半")]));
	assert.equal(message.stopReason, "error");
	assert.equal(isContextOverflow(message.failure), true);
	assert.equal(calls, 1, "同一份历史重试也还是满的");
});

test("Anthropic：内容整块放在 content_block_start 里、不再发 delta 的中转，正文和工具参数不丢", async () => {
	const { provider, model } = modelOf("anthropic-messages", { supportsThinking: false });
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	const body = [
		frame("message_start", { message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } }),
		frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "先想想", signature: "sig" } }),
		frame("content_block_stop", { index: 0 }),
		frame("content_block_start", { index: 1, content_block: { type: "text", text: "我去读文件" } }),
		frame("content_block_stop", { index: 1 }),
		frame("content_block_start", { index: 2, content_block: { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } } }),
		frame("content_block_stop", { index: 2 }),
		// 官方写法：开头是 `input: {}` 占位，参数在 delta 里。
		frame("content_block_start", { index: 3, content_block: { type: "tool_use", id: "t2", name: "read", input: {} } }),
		frame("content_block_delta", { index: 3, delta: { type: "input_json_delta", partial_json: '{"path":"b.ts"}' } }),
		frame("content_block_stop", { index: 3 }),
		frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
		frame("message_stop"),
	].join("");
	const { message } = await drive((fetch) => anthropicMessagesProvider.stream(provider, model, context, { fetch }), [{ status: 200, body }]);
	assert.equal(message.stopReason, "toolUse");
	const [thinking, text, first, second] = message.content;
	assert.deepEqual(thinking.type === "thinking" && [thinking.thinking, thinking.signature], ["先想想", "sig"]);
	assert.deepEqual(text, { type: "text", text: "我去读文件" });
	assert.deepEqual(first.type === "toolCall" && [first.arguments, JSON.parse(first.argumentsText!)], [{ path: "a.ts" }, { path: "a.ts" }]);
	assert.deepEqual(second.type === "toolCall" && second.arguments, { path: "b.ts" });
});

test("Anthropic：不再带过时的 prompt-caching beta 头", async () => {
	const { provider, model } = modelOf("anthropic-messages", { supportsThinking: false });
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	const { headers } = await drive((fetch) => anthropicMessagesProvider.stream(provider, model, context, { fetch }), [anthropicReply("end_turn")]);
	assert.equal("anthropic-beta" in headers[0], false);
});

test("Anthropic：默认发 budget_tokens；端点要 adaptive 时学会改写法重发，effort 按档位映射", async () => {
	resetThinkingReplay();
	resetReasoningCompat();
	const { provider, model } = modelOf("anthropic-messages");
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi")], tools: [] };
	const { bodies, message } = await drive(
		(fetch) => anthropicMessagesProvider.stream(provider, model, context, { fetch, thinking: "high" }),
		[error400("`thinking.type.enabled` is not supported for this model. Use `thinking.type.adaptive` and `output_config.effort` to control thinking behavior."), anthropicReply("end_turn")],
	);
	assert.equal(message.stopReason, "stop");
	assert.equal(bodies[0].thinking.type, "enabled", "默认行为不变");
	assert.equal(typeof bodies[0].thinking.budget_tokens, "number");
	assert.deepEqual(bodies[1].thinking, { type: "adaptive" });
	assert.deepEqual(bodies[1].output_config, { effort: "high" });

	// 学到之后下一次直接是 adaptive；协议外的档位就近映射，自定义档位名不发 effort。
	const custom = { ...model, thinkingOptions: [{ id: "ultra", label: "极致" }, { id: "deep", label: "深", budgetTokens: 4096 }] };
	const ultra = await drive((fetch) => anthropicMessagesProvider.stream(provider, custom, context, { fetch, thinking: "ultra" }), [anthropicReply("end_turn")]);
	assert.deepEqual(ultra.bodies[0].output_config, { effort: "max" });
	const odd = await drive((fetch) => anthropicMessagesProvider.stream(provider, custom, context, { fetch, thinking: "deep" }), [anthropicReply("end_turn")]);
	assert.deepEqual(odd.bodies[0].thinking, { type: "adaptive" });
	assert.equal("output_config" in odd.bodies[0], false, "不认识的档位不乱发");
	resetThinkingReplay();
});

test("Anthropic：思考回放降了一格还是失败，这一格不留给别的会话；端点要推理带回来时回到默认", async () => {
	resetThinkingReplay();
	resetReasoningCompat();
	const { provider, model } = modelOf("anthropic-messages");
	const assistant: AssistantMessage = {
		role: "assistant", api: "anthropic-messages", provider: "qa", model: "wire-model", usage: emptyUsage(), stopReason: "stop", timestamp: 1,
		content: [{ type: "thinking", thinking: "想一想" }, { type: "text", text: "答" }],
	};
	const context: LlmContext = { systemPrompt: "", messages: [userSays("hi"), assistant, userSays("再来")], tools: [] };
	assert.equal(thinkingReplay(provider, model), "unsigned", "非签名端点上的推理模型默认回放");

	const { calls, message } = await drive(
		(fetch) => anthropicMessagesProvider.stream(provider, model, context, { fetch }),
		[error400("messages.1.content.0: Invalid `signature` in `thinking` block"), error400("The reasoning_content in the thinking mode must be passed back to the API.")],
	);
	assert.equal(message.stopReason, "error");
	assert.ok(calls <= 3, `在两格之间来回拉扯了 ${calls} 次`);
	assert.equal(thinkingReplay(provider, model), "unsigned", "降级没换来成功，不固化");

	// 降过的模型，端点说推理要带回来时回到默认那一格。
	assert.equal(learnThinkingReplay("qa", "qa/wire-model", "Invalid `signature` in `thinking` block", "unsigned"), true);
	assert.equal(thinkingReplay(provider, model), "signed-only");
	assert.equal(learnThinkingReplay("qa", "qa/wire-model", "The reasoning_content in the thinking mode must be passed back to the API.", "unsigned"), true);
	assert.equal(thinkingReplay(provider, model), "unsigned");
	assert.equal(learnThinkingReplay("qa", "qa/wire-model", "The reasoning_content in the thinking mode must be passed back to the API.", "unsigned"), false, "已在默认格，不认领");
	resetThinkingReplay();
});

test("Anthropic：<env> 日期块留在原位，滚动缓存断点照常可以落在它上面", () => {
	// 它跟在所属的用户消息后面、每次渲染都一样（见 `prompt/environment.ts`），以它结尾的前缀下一次照样复用。
	const env: Message = { role: "user", content: [{ type: "text", text: "<env>\n今天是 2026-09-27。这是环境信息，不是用户的请求。\n</env>" }], timestamp: 9, synthetic: true };
	const assistant: AssistantMessage = {
		role: "assistant", api: "anthropic-messages", provider: "qa", model: "m", usage: emptyUsage(), stopReason: "stop", timestamp: 1,
		content: [{ type: "text", text: "答" }],
	};
	const wire = toAnthropicMessages([userSays("问"), env, assistant, userSays("再问")], { cacheBreakpoints: 2 });
	const marked = wire.map((message) => message.content.some((block) => block.cache_control != null));
	assert.deepEqual(marked, [false, false, true, true]);
});

// ---------------------------------------------------------------------------
// 5. 429 优先按限流处理
// ---------------------------------------------------------------------------

test("「Too many tokens, please wait」是限流，不是上下文超长", () => {
	const throttled = JSON.stringify({ message: "Too many tokens, please wait before trying again." });
	assert.equal(classifyFailure({ from: "status", status: 429, body: throttled }).kind, "upstream");
	assert.equal(classifyFailure({ from: "stream", message: "Too many tokens, please wait before trying again." }).kind, "upstream");
	assert.equal(classifyFailure({ from: "stream", message: "Rate limit: too many tokens per minute" }).kind, "upstream");
	// 真正的上下文超长照旧是终局。
	assert.equal(classifyFailure({ from: "stream", message: "prompt has too many tokens" }).kind, "fatal");
	assert.equal(classifyFailure({ from: "status", status: 503, body: JSON.stringify({ message: "This model's maximum context length is 128000 tokens" }) }).kind, "fatal");
	// 429 上的欠费仍然是欠费。
	assert.equal(classifyFailure({ from: "status", status: 429, body: JSON.stringify({ message: "You exceeded your current quota" }) }).hint, "check-billing");
});
