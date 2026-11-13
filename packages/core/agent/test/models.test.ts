import { describe, expect, it } from "vitest";
import { checkProvider, defaultModelOf, normalizeSettings, personalizationOf, resolveModel, type StoredProvider, type StoredSettings } from "../src/models.ts";

const entry = (modelId: string) => ({
	modelId,
	name: modelId,
	contextWindow: 200_000,
	maxOutputTokens: 32_000,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
});
const provider = (id: string, models: string[], rest: Partial<StoredProvider> = {}): StoredProvider => ({
	id,
	name: id,
	api: "anthropic-messages",
	baseUrl: "https://example.com",
	enabled: true,
	models: models.map(entry),
	apiKey: "key",
	...rest,
});

describe("normalizeSettings", () => {
	it("读不到文件或认不出的内容当作没有供应商", () => {
		expect(normalizeSettings(undefined)).toEqual({ providers: [] });
		expect(normalizeSettings({ modelId: "m1", baseUrl: "https://example.com" })).toEqual({ providers: [] });
		expect(normalizeSettings({ providers: [provider("a", ["m1"])], defaultModel: "a/m1" })).toEqual({
			providers: [provider("a", ["m1"])],
			defaultModel: "a/m1",
		});
	});

	it("「以后不再问」只认带 subject 的条目：没名字的是本体的，带插件名的是那个插件的；光秃秃的字符串不认，免得落进本体名下", () => {
		const alwaysAllow = ["echo hi", { subject: "read:/a" }, { plugin: "test.a", subject: "deploy" }, { plugin: "", subject: "x" }, { plugin: "test.a" }];
		expect(normalizeSettings({ providers: [], alwaysAllow }).alwaysAllow).toEqual([{ subject: "read:/a" }, { plugin: "test.a", subject: "deploy" }]);
	});
});

describe("personalizationOf", () => {
	it("没设过是友好语气、空指令；文件里不认识的语气和不是字的指令丢掉", () => {
		expect(personalizationOf(normalizeSettings({ providers: [] }))).toEqual({ customInstructions: "", tone: "friendly" });
		expect(personalizationOf(normalizeSettings({ providers: [], personalization: { tone: "concise", customInstructions: "hi" } }))).toEqual({
			customInstructions: "hi",
			tone: "concise",
		});
		expect(personalizationOf(normalizeSettings({ providers: [], personalization: { tone: "loud", customInstructions: 3 } }))).toEqual({
			customInstructions: "",
			tone: "friendly",
		});
	});
});

describe("defaultModelOf", () => {
	it("设过且可用就用它；供应商停用或模型不在了落到第一个可用的模型；都没有时为空", () => {
		const settings: StoredSettings = { providers: [provider("a", ["m1"]), provider("b", ["m2", "m3"])], defaultModel: "b/m3" };
		expect(defaultModelOf(settings)).toBe("b/m3");
		expect(defaultModelOf({ ...settings, defaultModel: "b/gone" })).toBe("a/m1");
		expect(defaultModelOf({ providers: [provider("a", ["m1"], { enabled: false }), provider("b", ["m2"])], defaultModel: "a/m1" })).toBe("b/m2");
		expect(defaultModelOf({ providers: [provider("a", [])] })).toBeUndefined();
	});
});

describe("resolveModel", () => {
	it("会话选的模型可用时用它，否则用默认模型；模型 id 可以带斜杠", () => {
		const settings: StoredSettings = { providers: [provider("a", ["m1", "vendor/m2"])], defaultModel: "a/m1" };
		expect(resolveModel(settings, "a/vendor/m2").model.modelId).toBe("vendor/m2");
		expect(resolveModel(settings, "a/gone").model.modelId).toBe("m1");
		expect(resolveModel(settings, undefined).provider.models).toHaveLength(1);
	});

	it("没有模型、或供应商没有 key 时说清楚去哪里配", () => {
		expect(() => resolveModel({ providers: [] }, undefined)).toThrow("还没有可用的模型");
		expect(() => resolveModel({ providers: [provider("a", ["m1"], { apiKey: undefined, name: "甲" })] }, undefined)).toThrow("供应商「甲」还没有填 API key");
	});
});

describe("checkProvider", () => {
	it("整理名字和地址的空白，显示名留空时用模型 id", () => {
		const checked = checkProvider({ ...provider("a", []), name: " 甲 ", baseUrl: " https://x.dev ", models: [{ ...entry("m1"), name: " " }] });
		expect(checked).toMatchObject({ name: "甲", baseUrl: "https://x.dev", models: [{ modelId: "m1", name: "m1" }] });
	});

	it("拒绝不合法的 id、地址、重复的模型和非正整数上限", () => {
		expect(() => checkProvider(provider("A B", []))).toThrow("供应商 id");
		expect(() => checkProvider(provider("a", [], { baseUrl: "example.com" }))).toThrow("http://");
		expect(() => checkProvider(provider("a", ["m1", "m1"]))).toThrow("模型 id 重复");
		expect(() => checkProvider({ ...provider("a", []), models: [{ ...entry("m1"), contextWindow: 0 }] })).toThrow("上下文窗口要是正整数");
	});
});
