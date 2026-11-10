/**
 * Magpie 写进设置文件的 `magpie` 块：读入时变成一个供应商，写盘时不留痕。
 *
 * 写盘那半边是要紧的：合成的供应商一旦落进 `providers` 就成了用户自己的——Magpie 断开时只恢复 `magpie` 块，
 * 这一项会永远留下。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Agent, createAgent } from "../src/index.ts";
import { magpieProvider } from "../src/magpie.ts";

const gateway = {
	baseUrl: "http://127.0.0.1:3425",
	apiKey: "magpie-plume",
	models: [
		{ id: "cliproxyapi/gpt-6-luna", name: "GPT-6 Luna", context: 1_000_000, output: 128_000, images: true, efforts: ["none", "low", "high"] },
		// Magpie 不知道档位时给的是 null，不知道的上下文、输出不给
		{ id: "group/auto-glm", name: "", images: false, efforts: null },
	],
};

const own = {
	id: "p-own",
	name: "公司",
	api: "openai-responses",
	baseUrl: "https://example.invalid",
	enabled: true,
	apiKey: "sk-own",
	models: [{ modelId: "m1", name: "m1", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages: false, supportsTools: true }],
};

describe("magpieProvider", () => {
	it("Magpie 断开后留下的空对象、缺 key 的块都算没接", () => {
		expect(magpieProvider(undefined)).toBeUndefined();
		expect(magpieProvider({})).toBeUndefined();
		expect(magpieProvider({ baseUrl: gateway.baseUrl, models: gateway.models })).toBeUndefined();
	});

	it("Magpie 的档位名换成 Plume 的；不知道的上下文、输出用新建模型的默认值，档位留给默认几档", () => {
		const [luna, glm] = magpieProvider(gateway)?.models ?? [];
		expect(luna?.thinkingOptions?.map((option) => option.id)).toEqual(["off", "low", "high"]);
		expect(luna).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true });
		expect(glm).toMatchObject({ name: "group/auto-glm", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: true, supportsImages: false });
		expect(glm?.thinkingOptions).toBeUndefined();
	});
});

describe("设置文件里的 magpie 块", () => {
	let dir: string;
	let agent: Agent | undefined;
	const settingsFile = () => join(dir, "settings.json");

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "plume-magpie-"));
	});

	afterEach(async () => {
		await agent?.shutdown();
		agent = undefined;
		await rm(dir, { recursive: true, force: true });
	});

	async function start(file: unknown) {
		await writeFile(settingsFile(), JSON.stringify(file));
		agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: settingsFile(), plugins: [], log: () => undefined });
		return agent.service;
	}

	it("读入时 Magpie 排在用户自己的供应商后面，Magpie 选的默认模型生效", async () => {
		const service = await start({ providers: [own], defaultModel: "magpie/cliproxyapi/gpt-6-luna", magpie: gateway });
		const settings = await service.getSettings();
		expect(settings.providers.map((provider) => [provider.id, provider.hasKey])).toEqual([
			["p-own", true],
			["magpie", true],
		]);
		expect(settings.defaultModel).toBe("magpie/cliproxyapi/gpt-6-luna");
	});

	it("只有 Magpie 写过的文件也读得出它的供应商", async () => {
		const service = await start({ defaultModel: "magpie/group/auto-glm", magpie: gateway });
		expect((await service.getSettings()).defaultModel).toBe("magpie/group/auto-glm");
	});

	it("存盘时 Magpie 供应商不进 providers，magpie 块和它的 key 原样留在文件里", async () => {
		const service = await start({ providers: [own], magpie: gateway });
		await service.setDefaultModel("p-own/m1");
		const file = JSON.parse(await readFile(settingsFile(), "utf8"));
		expect(file.providers.map((provider: { id: string }) => provider.id)).toEqual(["p-own"]);
		// Magpie 靠这一键还是它给的 key 来判断接着没有
		expect(file.magpie).toEqual(gateway);
		expect(file.defaultModel).toBe("p-own/m1");
	});

	it("Magpie 的供应商在 Plume 里改不了、删不了", async () => {
		const service = await start({ providers: [own], magpie: gateway });
		const magpie = (await service.getSettings()).providers.find((provider) => provider.id === "magpie");
		if (!magpie) throw new Error("应该读出 Magpie 供应商");
		await expect(service.saveProvider({ ...magpie, enabled: false })).rejects.toThrow("由 Magpie 管理");
		await expect(service.deleteProvider("magpie")).rejects.toThrow("由 Magpie 管理");
		expect(JSON.parse(await readFile(settingsFile(), "utf8")).magpie).toEqual(gateway);
	});
});
