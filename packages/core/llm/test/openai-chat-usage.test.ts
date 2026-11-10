import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiChatCompletionsProvider } from "../src/ai/openai-chat-completions.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig } from "../src/types.ts";

test("Chat Completions keeps cached prompt tokens out of ordinary input and prices each bucket once", async () => {
	const provider: ProviderConfig = {
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		api: "openai-chat-completions",
		apiKey: "test",
		enabled: true,
		models: [],
	};
	const model: ModelConfig = {
		id: "openai/test",
		providerId: "openai",
		modelId: "test",
		name: "Test",
		contextWindow: 32_000,
		maxOutputTokens: 2_000,
		supportsThinking: false,
		supportsImages: false,
		supportsTools: true,
		pricing: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, source: "manual" },
	};
	provider.models.push(model);
	const payload = [
		`data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}`,
		`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 750 } } })}`,
		"data: [DONE]",
		"",
	].join("\n\n");
	let done: AssistantMessage | null = null;
	for await (const event of openaiChatCompletionsProvider.stream(
		provider,
		model,
		{ systemPrompt: "", messages: [], tools: [] },
		{
			retryAttempts: 1,
			fetch: async () => new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } }),
		},
	)) {
		if (event.type === "done") done = event.message;
	}

	assert.ok(done);
	assert.equal(done.usage.input, 250);
	assert.equal(done.usage.cacheRead, 750);
	assert.equal(done.usage.output, 100);
	assert.equal(done.usage.total, 1_100);
	assert.ok(Math.abs(done.usage.cost.input - 0.00025) < 1e-12);
	assert.ok(Math.abs(done.usage.cost.cacheRead - 0.000075) < 1e-12);
	assert.ok(Math.abs(done.usage.cost.output - 0.0004) < 1e-12);
	assert.ok(Math.abs(done.usage.cost.total - 0.000725) < 1e-12);
});
