/**
 * Magpie 写进设置文件的 `magpie` 块：读入时变成一个供应商，在 Plume 里的编辑写回同一块。
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
import { fakeAnthropic } from "../src/testing.ts";

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

	it("供应商和完整模型配置可以编辑，重启后仍保留，网关 key 不复制进 providers 或 vault", async () => {
		const service = await start({ providers: [own], magpie: gateway });
		const magpie = (await service.getSettings()).providers.find((provider) => provider.id === "magpie")!;
		const edited = {
			...magpie,
			name: "我的 Magpie",
			api: "anthropic-messages" as const,
			baseUrl: "https://gateway.example.invalid/v1",
			models: [
				{
					...magpie.models[0]!,
					modelId: "custom/model",
					name: "自定义模型",
					contextWindow: 500_000,
					maxOutputTokens: 64_000,
					supportsThinking: false,
					supportsImages: false,
					supportsTools: false,
					imageOutput: true,
					pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 3, source: "manual" as const },
					thinkingOptions: [{ id: "high" as const, label: "高", detail: "高强度思考", isDefault: true }],
				},
			],
		};
		expect(await service.saveProvider(edited)).toBe("magpie");
		expect((await service.getSettings()).providers.at(-1)).toEqual(edited);
		const file = JSON.parse(await readFile(settingsFile(), "utf8"));
		expect(file.providers.map((provider: { id: string }) => provider.id)).toEqual(["p-own"]);
		expect(file.magpie.apiKey).toBe(gateway.apiKey);
		expect(file.magpie.models[0]).toMatchObject({ id: "custom/model", context: 500_000, output: 64_000, images: false });
		expect(await readFile(join(dir, "data", "credentials.json"), "utf8")).not.toContain("provider:magpie");
		await agent!.shutdown();
		agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: settingsFile(), plugins: [], log: () => undefined });
		expect((await agent.service.getSettings()).providers.at(-1)).toEqual(edited);
	});

	it("停用、启用和增删模型均能保存，清除可选配置不会恢复旧值", async () => {
		const service = await start({ providers: [own], defaultModel: "magpie/cliproxyapi/gpt-6-luna", magpie: gateway });
		const magpie = (await service.getSettings()).providers.at(-1)!;
		await service.saveProvider({ ...magpie, enabled: false });
		expect((await service.getSettings()).defaultModel).toBe("p-own/m1");
		expect((await service.getSettings()).providers.at(-1)?.enabled).toBe(false);
		const { thinkingOptions: _options, ...model } = magpie.models[0]!;
		await service.saveProvider({ ...magpie, models: [{ ...model, modelId: "added" }] });
		const settings = await service.getSettings();
		expect(settings.providers.at(-1)).toMatchObject({ enabled: true, models: [{ modelId: "added" }] });
		expect(settings.providers.at(-1)?.models[0]?.thinkingOptions).toBeUndefined();
		await service.saveProvider({ ...magpie, models: [] });
		expect((await service.getSettings()).providers.at(-1)?.models).toEqual([]);
	});

	it("删除供应商移除 magpie 块，不留副本，默认模型落到自己的供应商", async () => {
		const service = await start({ providers: [own], defaultModel: "magpie/cliproxyapi/gpt-6-luna", magpie: gateway });
		await service.deleteProvider("magpie");
		const settings = await service.getSettings();
		expect(settings.providers.map((provider) => provider.id)).toEqual(["p-own"]);
		expect(settings.defaultModel).toBe("p-own/m1");
		expect(JSON.parse(await readFile(settingsFile(), "utf8")).magpie).toBeUndefined();
	});

	it("Magpie 再次同步替换模型列表，断开后不会残留编辑过的供应商", async () => {
		const service = await start({ providers: [own], magpie: gateway });
		const magpie = (await service.getSettings()).providers.at(-1)!;
		await service.saveProvider({ ...magpie, models: [{ ...magpie.models[0]!, contextWindow: 500_000 }] });
		const file = JSON.parse(await readFile(settingsFile(), "utf8"));
		file.magpie.models = gateway.models;
		await writeFile(settingsFile(), JSON.stringify(file));
		expect((await service.getSettings()).providers.at(-1)?.models[0]?.contextWindow).toBe(1_000_000);
		delete file.magpie.baseUrl;
		delete file.magpie.apiKey;
		delete file.magpie.models;
		await writeFile(settingsFile(), JSON.stringify(file));
		expect((await service.getSettings()).providers.map((provider) => provider.id)).toEqual(["p-own"]);
	});

	it("修改地址、协议和 key 后，测试模型确实使用新配置发出请求", async () => {
		const model = await fakeAnthropic([{ text: "hi" }]);
		try {
			const service = await start({ magpie: gateway });
			const magpie = (await service.getSettings()).providers[0]!;
			await service.saveProvider({ ...magpie, api: "anthropic-messages", baseUrl: model.url, apiKey: "changed-key" });
			expect(await service.testProvider("magpie", magpie.models[0]!.modelId)).toMatchObject({ ok: true });
			expect(model.requests).toHaveLength(1);
			expect(model.requests[0]?.model).toBe(magpie.models[0]!.modelId);
			const file = JSON.parse(await readFile(settingsFile(), "utf8"));
			expect(file.magpie.apiKey).toBe("changed-key");
		} finally {
			await model.close();
		}
	});

	it("编辑使用普通供应商的校验，失败不会写坏 Magpie 配置", async () => {
		const service = await start({ magpie: gateway });
		const magpie = (await service.getSettings()).providers[0]!;
		await expect(service.saveProvider({ ...magpie, baseUrl: "invalid" })).rejects.toThrow();
		await expect(service.saveProvider({ ...magpie, models: [{ ...magpie.models[0]!, contextWindow: 0 }] })).rejects.toThrow();
		expect(JSON.parse(await readFile(settingsFile(), "utf8")).magpie).toEqual(gateway);
	});
});
