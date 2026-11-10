import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	activeModelCatalog,
	catalogFill,
	catalogModelFor,
	installModelCatalog,
	modelCatalogVersion,
	resetModelCatalog,
} from "../src/model-catalog.ts";
import { compactPiCatalog, MODEL_CATALOG_URL, parseModelCatalog, type ModelCatalogDocument } from "../src/model-catalog-format.ts";
import type { ModelConfig, ProviderConfig } from "../src/types/provider.ts";

function provider(baseUrl: string, id = "provider-local"): ProviderConfig {
	return { id, name: "Configured endpoint", baseUrl, api: "openai-responses", apiKey: "", enabled: true, models: [] };
}

/** A model row whose limits are deliberately meaningless, so a test sees whether anything changes them. */
function bare(endpoint: ProviderConfig, modelId: string): ModelConfig {
	return { id: `${endpoint.id}/${modelId}`, providerId: endpoint.id, modelId, name: modelId, contextWindow: 1, maxOutputTokens: 1, supportsThinking: false, supportsImages: false, supportsTools: false };
}

/** What a match fills in. */
function filled(endpoint: ProviderConfig, modelId: string) {
	const found = catalogModelFor(endpoint, modelId);
	return found ? catalogFill(found.model) : null;
}

const cost = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

/** 一份合成的 pi 原始目录：数值是编的，只为让断言不随上游快照变化。 */
const PI_RAW = {
	openai: {
		"gpt-5.2": {
			id: "gpt-5.2", name: "GPT-5.2", baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text", "image"], cost: cost(1.75, 14, 0.175), contextWindow: 400_000, maxTokens: 128_000,
			thinkingLevelMap: { off: "none", minimal: "low", xhigh: "xhigh", max: null },
		},
	},
	zai: {
		"glm-5.3": { id: "glm-5.3", name: "GLM-5.3", baseUrl: "https://api.z.ai/api/coding/paas/v4", reasoning: true, input: ["text"], cost: cost(1, 3.2), contextWindow: 200_000, maxTokens: 128_000 },
	},
	"opencode-go": {
		"glm-5.3": { id: "glm-5.3", name: "GLM-5.3", baseUrl: "https://opencode.ai/zen/go/v1", reasoning: true, input: ["text"], cost: cost(0, 0), contextWindow: 1_000_000, maxTokens: 131_072 },
	},
	google: {
		"gemini-2.5-pro": {
			id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", baseUrl: "https://generativelanguage.googleapis.com/v1beta", reasoning: true, input: ["text", "image"],
			cost: { ...cost(1.25, 10, 0.31), tiers: [{ inputTokensAbove: 200_000, input: 2.5, output: 15 }] }, contextWindow: 1_048_576, maxTokens: 65_536,
		},
	},
	openrouter: {
		"tencent/hy3-preview": { id: "tencent/hy3-preview", name: "HY3", baseUrl: "https://openrouter.ai/api/v1", reasoning: false, input: ["text"], cost: cost(0.18, 0.7), contextWindow: 256_000, maxTokens: 300_000 },
		broken: { id: "broken", name: "No limits", baseUrl: "https://openrouter.ai/api/v1", cost: cost(1, 1) },
	},
	empty: {},
};

function fixture(revision = "rev-fixture", updatedAt = "2099-01-01T00:00:00.000Z"): ModelCatalogDocument {
	return compactPiCatalog(PI_RAW, { name: "pi.dev", url: MODEL_CATALOG_URL, revision, updatedAt });
}

describe("bundled model catalogue", () => {
	it("is a pi snapshot that passes the same validation as a remote one", () => {
		resetModelCatalog();
		const catalog = activeModelCatalog();
		assert.equal(catalog.source.url, "https://pi.dev/api/models");
		assert.doesNotThrow(() => parseModelCatalog(catalog));
		assert.ok(catalog.providers.length > 10);
		assert.match(modelCatalogVersion(), /^pi:/);
	});
});

describe("pi catalogue format", () => {
	it("keeps limits, thinking, images and prices, and skips entries without limits or models", () => {
		const catalog = fixture();
		assert.deepEqual(catalog.providers.map((entry) => entry.id), ["openai", "zai", "opencode-go", "google", "openrouter"]);
		const gemini = catalog.providers.find((entry) => entry.id === "google")!.models[0];
		assert.deepEqual(
			{ context: gemini.contextWindow, output: gemini.maxOutputTokens, thinking: gemini.supportsThinking, images: gemini.supportsImages, tiers: gemini.tiers },
			{ context: 1_048_576, output: 65_536, thinking: true, images: true, tiers: [{ aboveTokens: 200_000, input: 2.5, output: 15, cacheRead: undefined, cacheWrite: undefined }] },
		);
		assert.deepEqual(catalog.providers.find((entry) => entry.id === "openrouter")!.models.map((model) => model.id), ["tencent/hy3-preview"]);
	});

	it("reads thinking levels the way pi does: null drops a level, xhigh and max need an explicit value", () => {
		const models = new Map(fixture().providers.flatMap((entry) => entry.models.map((model) => [`${entry.id}/${model.id}`, model] as const)));
		// `minimal` 在这个条目上实际发 `low`，和「低」一模一样，不单列一档。
		assert.deepEqual(models.get("openai/gpt-5.2")!.thinkingLevels, ["off", "low", "medium", "high", "xhigh"]);
		assert.deepEqual(models.get("zai/glm-5.3")!.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
		assert.equal(models.get("openrouter/tencent/hy3-preview")!.thinkingLevels, undefined, "不支持思考就没有档位");
	});

	it("rejects a catalogue without a revision or with an invalid entry as a whole", () => {
		assert.throws(() => parseModelCatalog({ ...fixture(), source: { name: "pi.dev" } }));
		const broken = structuredClone(fixture());
		broken.providers[0].models[0].contextWindow = 0;
		assert.throws(() => parseModelCatalog(broken));
	});
});

describe("catalogue matching", () => {
	beforeEach(() => assert.equal(installModelCatalog(fixture()), true));
	afterEach(() => resetModelCatalog());

	it("prefers the entry at the same endpoint, with or without a trailing /v1", () => {
		const go = provider("https://opencode.ai/zen/go");
		assert.equal(catalogModelFor(go, "glm-5.3")?.provider.id, "opencode-go");
		assert.equal(catalogModelFor(provider("https://OPENCODE.ai/zen/go/v1/"), "glm-5.3")?.match, "exact");
		const { pricing, thinkingOptions, ...values } = filled(go, "glm-5.3")!;
		assert.deepEqual(values, { contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsThinking: true, supportsImages: false, supportsTools: true });
		// GLM-5.3 关不掉思考（`vendors/`），目录里的「关闭」不往下填。
		assert.deepEqual(thinkingOptions?.map((option) => option.id), ["minimal", "low", "medium", "high"]);
		assert.equal(thinkingOptions?.find((option) => option.isDefault)?.id, "medium");
		assert.equal(pricing, undefined, "an all-zero subscription price is unpriced, not free");
	});

	it("falls back to the family vendor, then OpenRouter, for a relay, stripping only known suffixes", () => {
		const relay = provider("https://relay.example/v1");
		assert.equal(catalogModelFor(relay, "glm-5.3")?.provider.id, "zai");
		assert.equal(catalogModelFor(relay, "gpt-5.2-high")?.model.id, "gpt-5.2");
		assert.equal(catalogModelFor(relay, "command/gpt-5.2:20260101")?.model.id, "gpt-5.2");
		assert.equal(catalogModelFor(relay, "hy3-preview-high")?.model.id, "tencent/hy3-preview");
		assert.equal(catalogModelFor(relay, "gpt-5.2-high")?.match, "reference");
		for (const id of ["gpt-5.2-unrecognised", "gpt-5.2:free", "gemini-pro-agent", "some-private-model-v9"]) assert.equal(catalogModelFor(relay, id), null, id);
	});

	it("fills limits, capabilities and a catalogue price, clamping output to the window", () => {
		const relay = provider("https://relay.example/v1");
		const gpt = filled(relay, "gpt-5.2-high")!;
		assert.deepEqual(
			{ context: gpt.contextWindow, images: gpt.supportsImages, input: gpt.pricing?.input, cacheRead: gpt.pricing?.cacheRead, source: gpt.pricing?.source },
			{ context: 400_000, images: true, input: 1.75, cacheRead: 0.175, source: "catalog" },
		);
		assert.equal(filled(relay, "hy3-preview")?.maxOutputTokens, 256_000);
		assert.deepEqual(gpt.thinkingOptions?.map((option) => option.id), ["off", "low", "medium", "high", "xhigh"]);
		assert.equal(filled(relay, "hy3-preview")?.thinkingOptions, undefined);
		assert.deepEqual(filled(provider("https://generativelanguage.googleapis.com/v1beta"), "gemini-2.5-pro")?.pricing?.tiers, [{ aboveTokens: 200_000, input: 2.5, output: 15, cacheRead: undefined, cacheWrite: undefined }]);
	});
});

describe("installing a catalogue", () => {
	afterEach(() => resetModelCatalog());

	it("only replaces the active one with a different, not older revision", () => {
		assert.equal(installModelCatalog(fixture("rev-a", "2099-01-01T00:00:00.000Z")), true);
		assert.equal(installModelCatalog(fixture("rev-a", "2099-02-01T00:00:00.000Z")), false, "same revision");
		assert.equal(installModelCatalog(fixture("rev-old", "2098-01-01T00:00:00.000Z")), false, "older");
		assert.equal(activeModelCatalog().source.revision, "rev-a");
		assert.equal(modelCatalogVersion(), "pi:rev-a");
	});
});
