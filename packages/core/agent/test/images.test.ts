import { mkdtemp, rm } from "node:fs/promises";
import type { Message } from "@plume/contract";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drawImages, findImageModel } from "../src/images.ts";
import { imageNameOf, parkImages, readImage, restoreImages, saveImage } from "../src/media.ts";
import { checkProvider, defaultModelOf, normalizeSettings, type StoredProvider } from "../src/models.ts";

/** 1×1 PNG。 */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const entry = (modelId: string, extra: { imageOutput?: boolean } = {}) => ({
	modelId,
	name: modelId,
	contextWindow: 200_000,
	maxOutputTokens: 32_000,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
	...extra,
});
const provider = (id: string, models: ReturnType<typeof entry>[], rest: Partial<StoredProvider> = {}): StoredProvider => ({
	id,
	name: `${id} 供应商`,
	api: "openai-chat-completions",
	baseUrl: "https://relay.example",
	enabled: true,
	models,
	apiKey: "sk-test",
	...rest,
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("生图模型", () => {
	it("不当默认对话模型：设成默认的生图模型不算数，没设时跳过生图模型", () => {
		const settings = normalizeSettings({ providers: [provider("a", [entry("gpt-image-1"), entry("gpt-5")])], defaultModel: "a/gpt-image-1" });
		expect(defaultModelOf(settings)).toBe("a/gpt-5");
	});

	it("人在编辑器里说过的才存，按名字判断的不存", () => {
		const saved = checkProvider(provider("a", [entry("gpt-image-1"), entry("my-drawer", { imageOutput: true }), entry("flux-pro", { imageOutput: false })]));
		expect(saved.models.map((model) => model.imageOutput)).toEqual([undefined, true, false]);
	});

	it("不点名用设置里选的，选的不在了用第一个；点名按人的说法认，对不上不换成默认的", () => {
		const settings = normalizeSettings({
			providers: [provider("a", [entry("gpt-5"), entry("gpt-image-1")]), provider("b", [entry("gemini-3.1-flash-image")])],
			imageModel: "b/gemini-3.1-flash-image",
		});
		expect(findImageModel(settings, undefined)).toEqual({
			model: { id: "b/gemini-3.1-flash-image", name: "gemini-3.1-flash-image", modelId: "gemini-3.1-flash-image", provider: "b 供应商" },
		});
		expect(findImageModel({ ...settings, imageModel: "b/gone" }, undefined)).toMatchObject({ model: { id: "a/gpt-image-1" } });
		expect(findImageModel(settings, "GPT Image 1".replace(/ /g, "-"))).toMatchObject({ model: { id: "a/gpt-image-1" } });
		expect(findImageModel(settings, "dall-e-3")).toMatchObject({
			reason: "unknown",
			candidates: [{ id: "a/gpt-image-1" }, { id: "b/gemini-3.1-flash-image" }],
		});
		expect(findImageModel(normalizeSettings({ providers: [provider("a", [entry("gpt-5")])] }), undefined)).toEqual({ reason: "none", candidates: [] });
	});
});

describe("drawImages", () => {
	const settings = normalizeSettings({
		providers: [provider("a", [entry("gpt-image-1")]), provider("c", [entry("gpt-image-1")], { api: "anthropic-messages" })],
	});

	it("画出来的图按字节认类型、读出宽高，key 只进请求头", async () => {
		const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal("fetch", fetch);
		const result = await drawImages(settings, { model: "a/gpt-image-1", prompt: "a dot" });
		expect(result).toEqual({ ok: true, images: [{ data: PNG, mimeType: "image/png", width: 1, height: 1 }], route: "images" });
		expect(fetch.mock.calls[0]?.[0]).toBe("https://relay.example/v1/images/generations");
		expect(new Headers(fetch.mock.calls[0]?.[1].headers).get("authorization")).toBe("Bearer sk-test");
	});

	it("额度用完是一次交回的失败，带着人要做的事和恢复时间，不重试", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Your quota will reset after 1h2m3s" } }), { status: 429 }));
		vi.stubGlobal("fetch", fetch);
		const result = await drawImages(settings, { model: "a/gpt-image-1", prompt: "a dot" });
		expect(result).toMatchObject({ ok: false, failure: { hint: "check-billing", retryAfterMs: 3_723_000 } });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("不是生图模型、讲 Anthropic 协议的供应商直接抛错", async () => {
		const chat = normalizeSettings({ providers: [provider("a", [entry("gpt-5")])] });
		await expect(drawImages(chat, { model: "a/gpt-5", prompt: "x" })).rejects.toThrow();
		await expect(drawImages(settings, { model: "c/gpt-image-1", prompt: "x" })).rejects.toThrow();
		await expect(drawImages(settings, { model: "a/missing", prompt: "x" })).rejects.toThrow();
	});
});

describe("媒体目录", () => {
	it("存进去的名字按内容起，读得回来，路径认得出；别的类型、跳出目录的名字不认", async () => {
		const dir = await mkdtemp(join(tmpdir(), "plume-media-"));
		try {
			const name = await saveImage(dir, PNG, "image/png");
			expect(name).toMatch(/^[0-9a-f]{40}\.png$/);
			expect(await saveImage(dir, PNG, "image/png")).toBe(name);
			expect(await readImage(dir, name ?? "")).toEqual({ data: PNG, mimeType: "image/png" });
			expect(imageNameOf(dir, join(dir, name ?? ""))).toBe(name);
			expect(imageNameOf(dir, join(dir, "..", name ?? ""))).toBeNull();
			expect(await saveImage(dir, PNG, "image/svg+xml")).toBeNull();
			expect(await readImage(dir, "../secret.png")).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("BMP 存得下；发给模型时换成一句话，别的图照样读回", async () => {
		const dir = await mkdtemp(join(tmpdir(), "plume-media-"));
		try {
			const bmp = Buffer.alloc(9000, 1).toString("base64");
			const big = Buffer.alloc(9000, 2).toString("base64");
			const message: Message = {
				role: "toolResult",
				toolCallId: "c",
				toolName: "read",
				content: [
					{ type: "image", data: bmp, mimeType: "image/bmp" },
					{ type: "image", data: big, mimeType: "image/png" },
				],
				isError: false,
				timestamp: 0,
			};
			await parkImages(dir, message);
			expect(message.content.map((block) => (block.type === "image" ? block.media : ""))).toEqual([
				expect.stringMatching(/\.bmp$/),
				expect.stringMatching(/\.png$/),
			]);
			const sent = [structuredClone(message)];
			await restoreImages(dir, sent);
			expect(sent[0]?.content).toEqual([
				{ type: "text", text: "[unsupported image: image/bmp]" },
				expect.objectContaining({ type: "image", data: big, mimeType: "image/png" }),
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
