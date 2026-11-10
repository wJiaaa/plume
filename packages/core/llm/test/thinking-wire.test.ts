import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { openaiChatCompletionsProvider } from "../src/ai/openai-chat-completions.ts";
import { anthropicMessagesProvider } from "../src/ai/anthropic-messages.ts";
import { thinkingOptionsFor } from "../src/ai/thinking-options.ts";
import type { ModelConfig, Provider, ProviderConfig } from "../src/types/provider.ts";

const model: ModelConfig = { id: "qa/model", providerId: "qa", modelId: "gemini-relay", name: "QA", supportsThinking: true, supportsImages: false, supportsTools: true, contextWindow: 200000, maxOutputTokens: 32768 };
const context = { systemPrompt: "", messages: [], tools: [] };
async function payload(adapter: Provider, config: ModelConfig, thinking: string): Promise<Record<string, unknown>> {
	const provider: ProviderConfig = { id: "qa", name: "QA", api: adapter.api, apiKey: "test", baseUrl: "https://example.invalid", enabled: true, models: [config] };
	let captured: unknown;
	const stream = adapter.stream(provider, config, context, { thinking, onPayload: (body) => { captured = body; }, retryAttempts: 1,
		fetch: async () => new Response(JSON.stringify({ error: { message: "stop after payload capture" } }), { status: 400 }),
	});
	for await (const event of stream) { if (event.type === "error") break; }
	assert.ok(captured && typeof captured === "object");
	return Object.fromEntries(Object.entries(captured));
}

test("both OpenAI protocols honour configured levels and clamp the rest to the nearest one", async () => {
	for (const adapter of [openaiResponsesProvider, openaiChatCompletionsProvider]) {
		for (const [config, requested, expected] of [
			[{ ...model, thinkingOptions: [{ id: "adaptive", label: "自适应", detail: "Provider-defined", isDefault: true }] }, "adaptive", "adaptive"],
			[{ ...model, thinkingOptions: thinkingOptionsFor(["off", "low", "medium", "high", "xhigh", "max", "ultra"]) }, "ultra", "ultra"],
			[{ ...model, modelId: "unknown-relay" }, "ultra", "high"],
			// 没有「关闭」的模型关不掉思考：选「关闭」落到最浅的一档，而不是发一个会被拒的 none。
			[{ ...model, thinkingOptions: thinkingOptionsFor(["low", "high"]) }, "off", "low"],
		] satisfies [ModelConfig, string, string][]) {
			const body = await payload(adapter, config, requested);
			assert.deepEqual(adapter.api === "openai-responses" ? body.reasoning : body.reasoning_effort,
				adapter.api === "openai-responses" ? { effort: expected, summary: "auto" } : expected);
		}
	}
});

test("with thinking off, both OpenAI protocols leave the reasoning field out for Gemini and say none elsewhere", async () => {
	// Gemini refuses an explicit "none" (a 400 on the user's relay for gemini-3.8-flash-high and
	// gemini-2.5-flash). The Chat Completions adapter used to send it anyway, so thinking off failed there.
	for (const adapter of [openaiResponsesProvider, openaiChatCompletionsProvider]) {
		for (const modelId of ["gemini-3.8-flash-high", "Gemini-2.5-Flash", "gemma-3-27b"]) {
			const body = await payload(adapter, { ...model, id: `qa/${modelId}`, modelId }, "off");
			assert.equal(body.reasoning, undefined, `${adapter.api} ${modelId}`);
			assert.equal(body.reasoning_effort, undefined, `${adapter.api} ${modelId}`);
		}
		const other = await payload(adapter, { ...model, id: "qa/deepseek-v4-flash", modelId: "deepseek-v4-flash" }, "off");
		assert.deepEqual(adapter.api === "openai-responses" ? other.reasoning : other.reasoning_effort,
			adapter.api === "openai-responses" ? { effort: "none" } : "none");
	}
});

test("Anthropic uses the same clamp and an explicit budget for custom levels; invalid budgets never reach fetch", async () => {
	assert.deepEqual((await payload(anthropicMessagesProvider, model, "ultra")).thinking, { type: "enabled", budget_tokens: 24576 });
	const custom = { ...model, thinkingOptions: [{ id: "adaptive", label: "自适应", detail: "", budgetTokens: 2048 }] };
	assert.deepEqual((await payload(anthropicMessagesProvider, custom, "adaptive")).thinking, { type: "enabled", budget_tokens: 2048 });
	assert.deepEqual((await payload(anthropicMessagesProvider, custom, "off")).thinking, { type: "enabled", budget_tokens: 2048 }, "没有「关闭」就关不掉");
	const closable = { ...custom, thinkingOptions: [{ id: "off", label: "关闭", detail: "" }, ...custom.thinkingOptions] };
	assert.deepEqual((await payload(anthropicMessagesProvider, closable, "off")).thinking, { type: "disabled" }, "关要明说，见 vendors/");
	for (const budgetTokens of [undefined, 100, Number.NaN]) {
		const config = { ...custom, thinkingOptions: [{ ...custom.thinkingOptions[0], budgetTokens }] };
		const provider: ProviderConfig = { id: "qa", name: "QA", api: "anthropic-messages", apiKey: "test", baseUrl: "https://example.invalid", enabled: true, models: [config] };
		let fetched = false;
		let failed: string | undefined;
		const stream = anthropicMessagesProvider.stream(provider, config, context, { thinking: "adaptive", retryAttempts: 1,
			fetch: async () => { fetched = true; return new Response("{}", { status: 500 }); },
		});
		for await (const event of stream) { if (event.type === "error") failed = String(event.message.errorMessage); }
		assert.equal(fetched, false, `budgetTokens=${budgetTokens}`);
		assert.match(String(failed), /budgetTokens/);
	}
});
