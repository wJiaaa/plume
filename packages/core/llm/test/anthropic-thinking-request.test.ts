/**
 * 开思考时请求头和请求前检查的两件事：
 *
 *   - budget_tokens 写法要带 `anthropic-beta: interleaved-thinking-2025-05-14`，否则 Claude 4 系列在工具
 *     结果之后的续写不再思考；adaptive 写法自己就是交错的，不带。
 *   - budget 不合法时走统一的失败出口（error 事件 + 失败消息），而不是在 try 外面抛；已经学到 adaptive
 *     的模型不发 budget，不该被这条拦。
 *   - DeepSeek 的 Anthropic 端点忽略 budget_tokens、思考默认开着：档位走 `output_config.effort`，关思考
 *     明说 `disabled`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicMessagesProvider, resetThinkingReplay } from "../src/ai/anthropic-messages.ts";
import { thinkingOptionsFor } from "../src/ai/thinking-options.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig, RequestOptions } from "../src/types.ts";

const model: ModelConfig = {
	id: "qa/claude", providerId: "qa", modelId: "claude-test", name: "Claude Test",
	contextWindow: 200_000, maxOutputTokens: 8192, supportsThinking: true, supportsImages: true, supportsTools: true,
};
const provider: ProviderConfig = { id: "qa", name: "QA", api: "anthropic-messages", apiKey: "k", baseUrl: "https://api.anthropic.com", enabled: true, models: [model] };

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
const error400 = (message: string) => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status: 400 });

/** 跑一次，`replies` 依次回给每次 fetch。返回每次的请求头、请求体、事件类型和最后那条消息。 */
async function run(config: ModelConfig, options: Partial<RequestOptions>, replies: Array<() => Response>, endpoint: ProviderConfig = provider) {
	const headers: Record<string, string>[] = [];
	const bodies: Record<string, any>[] = [];
	const events: string[] = [];
	let last: AssistantMessage | undefined;
	const stream = anthropicMessagesProvider.stream(endpoint, config, { messages: [{ role: "user", content: [{ type: "text", text: "问" }], timestamp: 1 }], tools: [] }, {
		retryAttempts: 1,
		...options,
		fetch: async (_input, init) => {
			headers.push(init?.headers as Record<string, string>);
			bodies.push(JSON.parse(String(init?.body)));
			return replies[Math.min(headers.length - 1, replies.length - 1)]();
		},
	});
	for await (const event of stream) {
		events.push(event.type);
		if (event.type === "done" || event.type === "error") last = event.message;
	}
	return { headers, bodies, events, message: last! };
}

test("budget_tokens 写法带交错思考的 beta 头", async () => {
	resetThinkingReplay();
	const { headers, bodies } = await run(model, { thinking: "medium" }, [ok]);
	assert.equal(bodies[0].thinking.type, "enabled");
	assert.equal(headers[0]["anthropic-beta"], "interleaved-thinking-2025-05-14");
});

test("关着思考不带", async () => {
	resetThinkingReplay();
	const { headers, bodies } = await run({ ...model, supportsThinking: false }, {}, [ok]);
	assert.equal(bodies[0].thinking, undefined);
	assert.equal("anthropic-beta" in headers[0], false);
});

test("学到 adaptive 写法之后不带——adaptive 自己就是交错的", async () => {
	resetThinkingReplay();
	const { headers, bodies } = await run(model, { thinking: "high" }, [
		() => error400("`thinking.type.enabled` is not supported for this model. Use `thinking.type.adaptive` and `output_config.effort` to control thinking behavior."),
		ok,
	]);
	assert.equal(headers[0]["anthropic-beta"], "interleaved-thinking-2025-05-14", "第一次还是 budget 写法");
	assert.deepEqual(bodies[1].thinking, { type: "adaptive" });
	assert.equal("anthropic-beta" in headers[1], false);
	resetThinkingReplay();
});

test("中转拒了这个 beta：学会不带，重发；之后这个模型都不带", async () => {
	// 推断，未验证：手上没有拒绝它的中转样本。官方对未知 beta 值的说法也点名 `anthropic-beta` 头。
	resetThinkingReplay();
	const first = await run(model, { thinking: "medium" }, [() => error400("Unexpected value(s) `interleaved-thinking-2025-05-14` for the `anthropic-beta` header."), ok]);
	assert.equal(first.message.stopReason, "stop");
	assert.equal(first.headers.length, 2);
	assert.equal("anthropic-beta" in first.headers[1], false);
	assert.equal(first.bodies[1].thinking.type, "enabled", "思考照开，只是不带这个头");
	const next = await run(model, { thinking: "medium" }, [ok]);
	assert.equal("anthropic-beta" in next.headers[0], false);
	resetThinkingReplay();
});

test("没带这个头时，点名 beta 的错误不被它认领", async () => {
	resetThinkingReplay();
	const { headers, message } = await run({ ...model, supportsThinking: false }, {}, [() => error400("invalid beta flag"), ok]);
	assert.equal(headers.length, 1, "不带头的请求被拒，不该换来一次一模一样的重发");
	assert.equal(message.stopReason, "error");
});

test("budget 不合法时给 error 事件和失败消息，不发请求", async () => {
	// 从前在 try 外面直接 throw：调用方的 for-await 炸掉，拿不到 error 事件，也没有一条失败的消息可记。
	resetThinkingReplay();
	for (const config of [{ ...model, maxOutputTokens: 1024 }, { ...model, thinkingOptions: [{ id: "deep", label: "深", budgetTokens: 100 }] }]) {
		const { headers, events, message } = await run(config, { thinking: config.thinkingOptions ? "deep" : "medium" }, [ok]);
		assert.equal(headers.length, 0, "不合法的 budget 不该发出去");
		assert.equal(events.at(-1), "error");
		assert.equal(message.stopReason, "error");
		assert.match(String(message.errorMessage), /budgetTokens/);
		assert.equal(message.errorRetryable, false, "配置问题重试多少次都一样");
	}
});

test("已经学到 adaptive 的模型不发 budget，也就不被 budget 的检查拦下", async () => {
	resetThinkingReplay();
	const config = { ...model, maxOutputTokens: 1024 };
	await run(model, { thinking: "high" }, [
		() => error400("`thinking.type.enabled` is not supported for this model. Use `thinking.type.adaptive` and `output_config.effort` to control thinking behavior."),
		ok,
	]);
	const { bodies, message } = await run(config, { thinking: "high" }, [ok]);
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(bodies[0].thinking, { type: "adaptive" });
	resetThinkingReplay();
});

const deepseekModel: ModelConfig = { ...model, id: "ds/deepseek-v4-pro", providerId: "ds", modelId: "deepseek-v4-pro", thinkingOptions: thinkingOptionsFor(["off", "low", "high", "max"]) };
const deepseek: ProviderConfig = { ...provider, id: "ds", baseUrl: "https://api.deepseek.com/anthropic", models: [deepseekModel] };

test("DeepSeek 的档位走 output_config.effort，不发它会忽略的 budget_tokens", async () => {
	// 从前三个档位发的都是 budget_tokens：DeepSeek 不报错、只是忽略，于是 low 和 max 都按默认的 high 跑。
	for (const level of ["low", "high", "max"]) {
		const { headers, bodies } = await run(deepseekModel, { thinking: level }, [ok], deepseek);
		assert.deepEqual(bodies[0].thinking, { type: "enabled" }, level);
		assert.deepEqual(bodies[0].output_config, { effort: level }, level);
		assert.equal(headers[0]["anthropic-beta"], undefined, "交错思考的头只属于 budget 写法");
	}
});

test("DeepSeek 关思考要明说 disabled：它默认开着", async () => {
	const { bodies } = await run(deepseekModel, { thinking: "off" }, [ok], deepseek);
	assert.deepEqual(bodies[0].thinking, { type: "disabled" });
	assert.equal("output_config" in bodies[0], false);
	// 别的端点也一样明说：协议里有这个值，而很多兼容端点默认开着思考，不发就关不掉。
	const other = await run({ ...model, thinkingOptions: thinkingOptionsFor(["off", "high"]) }, { thinking: "off" }, [ok]);
	assert.deepEqual(other.bodies[0].thinking, { type: "disabled" });
});

test("转发 DeepSeek 的中转按模型名认；不发 budget 也就不被 budget 的检查拦下", async () => {
	const relay: ProviderConfig = { ...provider, id: "relay", baseUrl: "https://relay.example.com" };
	const config = { ...deepseekModel, providerId: "relay", modelId: "deepseek/deepseek-v4-pro", maxOutputTokens: 1024 };
	const { bodies, message } = await run(config, { thinking: "max" }, [ok], relay);
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(bodies[0].thinking, { type: "enabled" });
	assert.deepEqual(bodies[0].output_config, { effort: "max" });
});
