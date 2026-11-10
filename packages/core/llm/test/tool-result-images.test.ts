/**
 * Where a tool result's image goes on the Responses API, and what happens when an endpoint refuses
 * the protocol's own shape. The refusal text is real: a relay serving `glm-5.3-flash`, 2026-09-27.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { toResponsesInput } from "../src/ai/openai-responses-request.ts";
import { resetReasoningCompat } from "../src/ai/reasoning-compat.ts";
import { learnToolResultImages, resetToolResultImagesCompat, toolResultImages } from "../src/ai/tool-result-images-compat.ts";
import { emptyUsage } from "../src/types.ts";
import type { Message, ModelConfig, ProviderConfig } from "../src/types.ts";

const REFUSAL = 'Upstream request failed: [invalid_value] messages[5]: tool content: part type "image_url" is not supported; only text is';

const history = (): Message[] => [
	{ role: "user", content: [{ type: "text", text: "look" }], timestamp: 0 },
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "peek", arguments: {} }],
		api: "openai-responses",
		provider: "relay",
		model: "m",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp: 1,
	},
	{ role: "toolResult", toolCallId: "call_1", toolName: "peek", content: [{ type: "text", text: "panel" }, { type: "image", mimeType: "image/png", data: "AAAA" }], isError: false, timestamp: 2 },
];

type Item = Record<string, unknown>;

test("lifted: the output keeps a marker and the image follows in a user message", () => {
	const input = toResponsesInput(history(), { provider: "relay", model: "m", toolImages: "lifted" }) as Item[];
	const at = input.findIndex((item) => item.type === "function_call_output");
	assert.equal(input[at].output, "panel\n[image image/png: attached in the next message]");
	const next = input[at + 1] as { role: string; content: Item[] };
	assert.equal(next.role, "user");
	assert.deepEqual(next.content[1], { type: "input_image", image_url: "data:image/png;base64,AAAA" });
});

test("inline stays the default, and a blind model gets neither shape", () => {
	const inline = toResponsesInput(history(), { provider: "relay", model: "m" }) as Item[];
	assert.ok(Array.isArray(inline.find((item) => item.type === "function_call_output")?.output));
	const blind = toResponsesInput(history(), { provider: "relay", model: "m", supportsImages: false, toolImages: "lifted" }) as Item[];
	assert.equal(JSON.stringify(blind).includes("input_image"), false);
});

test("only the refusal that names an image in a tool message is learned, and only once", () => {
	resetToolResultImagesCompat();
	assert.equal(learnToolResultImages("relay", "m", "Invalid 'input[3].id'"), false);
	assert.equal(toolResultImages("relay", "m"), "inline");
	assert.equal(learnToolResultImages("relay", "m", REFUSAL), true);
	assert.equal(toolResultImages("relay", "m"), "lifted");
	assert.equal(learnToolResultImages("relay", "m", REFUSAL), false, "already lifted: nothing new, no second resend");
	assert.equal(toolResultImages("relay", "other"), "inline", "kept per model");
});

test("refused once, the same turn is resent with the image lifted and succeeds", async () => {
	resetToolResultImagesCompat();
	resetReasoningCompat();
	const bodies: Item[] = [];
	const ok =
		[
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, delta: "红" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", content: [{ type: "output_text", text: "红" }] } },
			{ type: "response.completed", response: { id: "r1", usage: { input_tokens: 10, output_tokens: 1 } } },
		]
			.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}`)
			.join("\n\n") + "\n\n";
	const fetch = async (_url: unknown, init?: { body?: unknown }) => {
		bodies.push(JSON.parse(String(init?.body)));
		return bodies.length === 1
			? new Response(JSON.stringify({ error: { message: REFUSAL, type: "invalid_request_error" } }), { status: 400 })
			: new Response(ok, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const provider: ProviderConfig = { id: "relay", name: "relay", baseUrl: "https://relay.invalid/v1", api: "openai-responses", apiKey: "k", enabled: true, models: [] };
	const model = { id: "relay/m", providerId: "relay", modelId: "m", name: "m", contextWindow: 100_000, maxOutputTokens: 1000, supportsThinking: false, supportsImages: true, supportsTools: true } as ModelConfig;

	let text = "";
	for await (const event of openaiResponsesProvider.stream(provider, model, { systemPrompt: "", messages: history(), tools: [] }, { fetch: fetch as typeof globalThis.fetch })) {
		if (event.type === "done") text = event.message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	}
	assert.equal(bodies.length, 2);
	const outputOf = (body: Item) => (body.input as Item[]).find((item) => item.type === "function_call_output")?.output;
	assert.ok(Array.isArray(outputOf(bodies[0])), "first try: the protocol's own shape");
	assert.equal(typeof outputOf(bodies[1]), "string", "resend: the image moved out of the result");
	assert.ok(JSON.stringify(bodies[1]).includes("input_image"), "and it was not dropped");
	assert.equal(text, "红");
});
