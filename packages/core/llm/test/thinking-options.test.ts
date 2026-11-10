/**
 * Which thinking levels a model is offered, and what gets sent when one is picked.
 *
 * Levels are no longer guessed from the model name. The hard-coded tables disagreed with what the
 * vendors actually accept (`minimal` on models that reject it, 「关闭」 on models that cannot stop
 * thinking), and a wrong guess never errors. A model's levels come from the catalogue (pi's
 * `thinkingLevelMap`) or from the model editor; anything else gets the four levels every reasoning
 * API accepts.
 *
 * A level the model does not have lands on the nearest one — deeper first, then shallower, the
 * same rule as pi's `clampThinkingLevel`. It used to fall back to the default, so a conversation
 * left on 最高 dropped to 中 after switching models, and 极简 was raised to 中.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_THINKING_OPTIONS,
	resolveModelThinkingOptions,
	resolveReasoningEffort,
	resolveThinkingOption,
	thinkingOptionsFor,
} from "../src/ai/thinking-options.ts";
import type { ModelConfig, ThinkingLevel } from "../src/types/provider.ts";

const model = (modelId: string, levels?: ThinkingLevel[]): ModelConfig => ({
	id: modelId,
	providerId: "p",
	modelId,
	name: modelId,
	contextWindow: 200_000,
	maxOutputTokens: 8192,
	supportsThinking: true,
	...(levels ? { thinkingOptions: thinkingOptionsFor(levels) } : {}),
});

const ids = (config: ModelConfig) => resolveModelThinkingOptions(config).map((option) => option.id);

test("a model without configured levels gets the conservative four, whatever its name", () => {
	for (const id of ["gpt-5.6-sol", "gpt-6-astra", "gemini-ultra", "claude-opus-5-5", "some-relay-alias"]) {
		assert.deepEqual(ids(model(id)), ["off", "low", "medium", "high"], id);
	}
	assert.equal(DEFAULT_THINKING_OPTIONS.find((option) => option.isDefault)?.id, "medium");
});

test("configured levels are taken at their word, in canonical order, with one default", () => {
	const sol = model("gpt-5.6-sol", ["max", "off", "low", "medium", "high", "xhigh"]);
	assert.deepEqual(ids(sol), ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.equal(resolveModelThinkingOptions(sol).filter((option) => option.isDefault).length, 1);
	assert.deepEqual(ids({ ...model("x"), thinkingOptions: [{ id: "adaptive", label: "自适应", detail: "" }] }), ["adaptive"]);
	assert.deepEqual(resolveModelThinkingOptions({ ...model("x"), thinkingOptions: [] }), []);
});

test("the default is medium, or the level nearest to it", () => {
	const fallback = (levels: ThinkingLevel[]) => thinkingOptionsFor(levels).find((option) => option.isDefault)?.id;
	assert.equal(fallback(["low", "medium", "high"]), "medium");
	assert.equal(fallback(["off", "low", "high", "max"]), "high", "先往深找");
	assert.equal(fallback(["off", "max"]), "max");
	assert.equal(fallback(["off", "minimal", "low"]), "low", "深处没有再往浅找");
	assert.equal(thinkingOptionsFor(["low", "medium", "high"], "low").find((option) => option.isDefault)?.id, "low", "编辑器保留原来的默认档");
});

test("every configured level reaches the wire unchanged", () => {
	for (const config of [model("a", ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]), {
		...model("b"), thinkingOptions: [{ id: "adaptive", label: "自适应", detail: "", isDefault: true }],
	}]) {
		for (const option of resolveModelThinkingOptions(config)) {
			assert.equal(resolveReasoningEffort(option.id, config), option.id === "off" ? undefined : option.id);
		}
	}
});

test("a level the model lacks lands on the nearest one, not on the default", () => {
	const four = model("gemini-3-pro");
	assert.equal(resolveReasoningEffort("xhigh", four), "high");
	assert.equal(resolveReasoningEffort("max", four), "high");
	assert.equal(resolveReasoningEffort("ultra", four), "high");
	assert.equal(resolveReasoningEffort("minimal", four), "low");
	const five = model("gpt-5.5", ["off", "low", "medium", "high", "xhigh"]);
	assert.equal(resolveReasoningEffort("max", five), "xhigh");
	assert.equal(resolveReasoningEffort("minimal", five), "low");
	assert.equal(resolveReasoningEffort("medium", model("deepseek", ["off", "low", "high", "max"])), "high");
	// 不在标准序列里的名字没有「就近」可言，落回模型的默认档。
	assert.equal(resolveReasoningEffort("deep-custom", five), "medium");
	// 要的是思考，就近不能落到「关闭」：只有关闭和自定义档位时用默认档。
	const custom = { ...model("relay"), thinkingOptions: [{ id: "off", label: "关闭", detail: "" }, { id: "adaptive", label: "自适应", detail: "", isDefault: true }] };
	assert.equal(resolveReasoningEffort("medium", custom), "adaptive");
	assert.equal(resolveReasoningEffort("off", custom), undefined);
});

test("off without an off level means the model cannot stop thinking: it gets the shallowest level", () => {
	const astra = model("gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(resolveThinkingOption("off", astra)?.id, "low");
	assert.equal(resolveReasoningEffort("off", astra), "low");
	assert.equal(resolveReasoningEffort("off", model("kimi-k3", ["max"])), "max");
	assert.equal(resolveReasoningEffort("off", model("gpt-5.6")), undefined);
	assert.equal(resolveReasoningEffort(undefined, model("gpt-5.6")), undefined);
});

test("a model whose thinking cannot be switched off is never offered off, even from the default set or an old config", () => {
	// GLM-5.3 is `alwaysOn` in `vendors/`: the adapters send nothing for off, so offering it would lie.
	assert.deepEqual(ids(model("glm-5.3")), ["low", "medium", "high"]);
	assert.deepEqual(ids(model("glm-5.3", ["off", "low", "high"])), ["low", "high"]);
	assert.equal(resolveReasoningEffort("off", model("glm-5.3")), "low");
	assert.deepEqual(ids(model("glm-5.2")), ["off", "low", "medium", "high"]);
});

test("a model that cannot think is offered nothing and sends nothing", () => {
	assert.deepEqual(resolveModelThinkingOptions({ ...model("x"), supportsThinking: false }), []);
	assert.deepEqual(resolveModelThinkingOptions(null), []);
	assert.equal(resolveReasoningEffort("high", { ...model("x"), supportsThinking: false }), undefined);
	assert.equal(resolveThinkingOption("high", { ...model("x", ["low"]), supportsThinking: false }), undefined);
});

test("Gemini models never receive effort none when thinking is off in openai-responses adapter", async () => {
	const { openaiResponsesProvider } = await import("../src/ai/openai-responses.ts");
	let capturedPayload: any = null;

	const mockFetch = async () => {
		// Return 400 immediately to terminate stream early
		return new Response(JSON.stringify({ error: { message: "mock" } }), { status: 400 });
	};

	const providerConfig = {
		id: "test",
		name: "test",
		baseUrl: "https://example.invalid",
		api: "openai-responses" as const,
		apiKey: "test",
		enabled: true,
		models: [],
	};

	// 1. Gemini model with thinking: "off"
	const geminiModel = {
		...model("gemini-3.7-flash-high"),
		supportsThinking: true,
	};

	const genGemini = openaiResponsesProvider.stream(
		providerConfig,
		geminiModel,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }], tools: [] },
		{
			thinking: "off",
			fetch: mockFetch as any,
			onPayload: (p) => {
				capturedPayload = p;
			},
		},
	);
	try {
		await genGemini.next();
	} catch {
		// Expected error from mockFetch
	}

	assert.ok(capturedPayload, "Payload should be sent");
	assert.equal(capturedPayload.reasoning, undefined, "Gemini with thinking: 'off' must not have reasoning property");

	// 2. OpenAI model with thinking: "off" should still have { reasoning: { effort: "none" } }
	const gptModel = {
		...model("gpt-5.6"),
		supportsThinking: true,
	};
	let capturedGptPayload: any = null;
	const genGpt = openaiResponsesProvider.stream(
		providerConfig,
		gptModel,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }], tools: [] },
		{
			thinking: "off",
			fetch: mockFetch as any,
			onPayload: (p) => {
				capturedGptPayload = p;
			},
		},
	);
	try {
		await genGpt.next();
	} catch {
		// Expected error from mockFetch
	}
	assert.ok(capturedGptPayload, "Payload should be sent for GPT");
	assert.deepEqual(capturedGptPayload.reasoning, { effort: "none" }, "GPT with thinking: 'off' retains effort: 'none'");
});
