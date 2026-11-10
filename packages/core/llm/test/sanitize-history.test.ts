import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicMessagesProvider } from "../src/ai/anthropic-messages.ts";
import { openaiChatCompletionsProvider } from "../src/ai/openai-chat-completions.ts";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { sanitizeToolPairing } from "../src/ai/sanitize-history.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig, type ToolResultMessage } from "../src/types.ts";

const assistant: AssistantMessage = {
	role: "assistant", api: "openai-responses", provider: "test", model: "model", usage: emptyUsage(), stopReason: "toolUse", timestamp: 0,
	content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "read", arguments: {} }],
};
const user: Message = { role: "user", content: [{ type: "text", text: "Continue" }], timestamp: 1 };
function result(id: string, text = "answer"): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 1 };
}
const broken = [result("orphan-head"), assistant, result("a", "first"), result("a", "duplicate"), result("orphan-tail"), user];

test("sanitizing pairs drops orphan/duplicate results and does not mutate the transcript", () => {
	const before = structuredClone(broken);
	const repaired = sanitizeToolPairing(broken);
	assert.deepEqual(repaired.map((message) => message.role === "toolResult" ? message.toolCallId : message.role), ["assistant", "a", "b", "user"]);
	assert.deepEqual(repaired[1], result("a", "first"));
	assert.equal(repaired[2].timestamp, assistant.timestamp);
	assert.deepEqual(sanitizeToolPairing(repaired), repaired);
	assert.deepEqual(broken, before);
});

test("reused call ids are answered within each turn without consuming a later result", () => {
	const repaired = sanitizeToolPairing([assistant, user, result("a", "late"), assistant, result("a", "second"), result("b", "second")]);
	const answers = repaired.filter((message) => message.role === "toolResult");
	assert.equal(answers.length, 4);
	assert.ok(answers[0].isError);
	assert.ok(answers[1].isError);
	assert.deepEqual(answers.slice(2), [result("a", "second"), result("b", "second")]);
});

const model: ModelConfig = { id: "test/model", providerId: "test", modelId: "model", name: "Test", contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
for (const adapter of [anthropicMessagesProvider, openaiChatCompletionsProvider, openaiResponsesProvider]) {
	test(`${adapter.api} applies pairing repair at the actual request boundary`, async () => {
		const provider: ProviderConfig = { id: "test", name: "Test", api: adapter.api, apiKey: "test", baseUrl: "https://example.invalid", enabled: true, models: [model] };
		let request = "";
		const stream = adapter.stream(provider, model, { messages: broken, tools: [] }, {
			fetch: async (_input, init) => {
				assert.equal(typeof init?.body, "string");
				request = String(init?.body);
				return new Response("stop after capturing the request", { status: 400 });
			},
		});
		for await (const _event of stream) { /* Consume the real adapter to reach fetch. */ }
		assert.ok(request);
		assert.doesNotMatch(request, /orphan-head|orphan-tail|duplicate/);
		assert.match(request, /Turn was interrupted/);
	});
}
