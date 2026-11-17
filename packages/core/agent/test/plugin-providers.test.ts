/**
 * 插件经 `ctx.providers` 提供的供应商：接在人自己的后面，不写盘、不进 vault、不导出；设置页的改和删交回插件；
 * 价格不是本体认的形状时按模型目录补，花销照常记（原来 NaN 撞上 `spend.cost` 的非空约束，回复存不进去）。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ModelEntry, Plugin, PluginContext, PluginProvider } from "@plume/contract";
import { catalogModelFor, catalogPricing } from "@plume/llm/model-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Agent, createAgent } from "../src/index.ts";
import { fakeAnthropic } from "../src/testing.ts";

const model = (modelId: string, extra: Partial<ModelEntry> = {}): ModelEntry => ({
	modelId,
	name: modelId,
	contextWindow: 200_000,
	maxOutputTokens: 32_000,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
	...extra,
});

const own = { id: "p-own", name: "公司", api: "openai-responses", baseUrl: "https://example.invalid", enabled: true, apiKey: "sk-own", models: [model("m1")] };

let dir: string;
let agent: Agent | undefined;
let ctx: PluginContext;
/** 插件那边存着的供应商，`save`、`remove` 改的就是它。 */
let listed: PluginProvider[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-plugin-providers-"));
});

afterEach(async () => {
	await agent?.shutdown();
	agent = undefined;
	await rm(dir, { recursive: true, force: true });
});

async function start(providers: PluginProvider[], file: unknown = { providers: [own] }) {
	listed = providers;
	await writeFile(join(dir, "settings.json"), JSON.stringify(file));
	const plugin: Plugin = {
		name: "test.gateway",
		apply(context) {
			ctx = context;
			context.providers.provide({
				list: () => listed,
				save: async (provider) => {
					listed = listed.map((item) => (item.id === provider.id ? provider : item));
				},
				remove: async (providerId) => {
					listed = listed.filter((item) => item.id !== providerId);
				},
			});
		},
	};
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "settings.json"),
		plugins: [{ key: plugin.name, load: async () => plugin }],
		log: () => {},
	});
	return agent.service;
}

const gateway = (extra: Partial<PluginProvider> = {}): PluginProvider => ({
	id: "gw",
	name: "网关",
	api: "anthropic-messages",
	baseUrl: "http://127.0.0.1:1",
	enabled: true,
	apiKey: "gw-key",
	models: [model("g1")],
	...extra,
});

describe("插件提供的供应商", () => {
	it("接在人自己的后面、标上插件名；重名的保留人自己的，不合格的跳过；不写盘、不进 vault、不导出", async () => {
		const service = await start([gateway(), gateway({ id: "p-own", name: "撞名" }), gateway({ id: "Bad Id" })]);
		const settings = await service.getSettings();
		expect(settings.providers.map(({ id, name, hasKey, managedBy }) => [id, name, hasKey, managedBy])).toEqual([
			["p-own", "公司", true, undefined],
			["gw", "网关", true, "test.gateway"],
		]);
		expect(JSON.stringify(settings)).not.toContain("gw-key");
		await service.setFavoriteModels(["gw/g1"]);
		const file = await readFile(join(dir, "settings.json"), "utf8");
		expect(JSON.parse(file).providers.map((provider: { id: string }) => provider.id)).toEqual(["p-own"]);
		expect(file).not.toContain("gw-key");
		expect(await readFile(join(dir, "data", "credentials.json"), "utf8").catch(() => "")).not.toContain("provider:gw");
		const out = join(dir, "providers.json");
		expect(await service.exportProviders(out)).toMatchObject({ providers: 1 });
		expect(await readFile(out, "utf8")).not.toContain("gw-key");
	});

	it("设置页的改和删交回插件：key 没填时留着原来的；校验和自己的供应商一样", async () => {
		const service = await start([gateway()]);
		const view = (await service.getSettings()).providers.find((provider) => provider.id === "gw")!;
		await expect(service.saveProvider({ ...view, baseUrl: "invalid" })).rejects.toThrow();
		expect(await service.saveProvider({ ...view, name: "改过的", apiKey: "" })).toBe("gw");
		expect(listed[0]).toMatchObject({ id: "gw", name: "改过的", apiKey: "gw-key" });
		expect((await service.getSettings()).providers.at(-1)?.name).toBe("改过的");
		await service.deleteProvider("gw");
		expect(listed).toEqual([]);
		expect((await service.getSettings()).providers.map((provider) => provider.id)).toEqual(["p-own"]);
	});

	it("价格不是本体认的形状、没带价格时按模型目录补；认得的照用；目录里没有的不带", async () => {
		const manual = { input: 2, output: 8, source: "manual" as const };
		await start([
			gateway({
				baseUrl: "https://gateway.invalid",
				models: [
					model("group/claude-sonnet-4-5", { pricing: { prompt: "0.000003", completion: "0.000015" } as never }),
					model("company/claude-sonnet-4-5", { pricing: manual }),
					model("company/no-such-model"),
				],
			}),
		]);
		const [fromCatalog, fromManual, unknown] = (await agent!.service.getSettings()).providers.at(-1)!.models;
		expect(fromCatalog?.pricing).toEqual(catalogPricing(catalogModelFor({ baseUrl: "https://gateway.invalid" }, "claude-sonnet-4-5")!.model));
		expect(fromCatalog?.pricing?.source).toBe("catalog");
		expect(fromManual?.pricing).toEqual(manual);
		expect(unknown?.pricing).toBeUndefined();
	});

	it("用插件的模型调一次：价格形状不对也照常记花销", async () => {
		const fake = await fakeAnthropic([{ text: "好" }]);
		try {
			await start([gateway({ baseUrl: fake.url, models: [model("g1", { pricing: { prompt: "0.000003" } as never })] })], { providers: [] });
			expect(await ctx.model.complete({ systemPrompt: "", prompt: "嗨" })).toBe("好");
			const usage = await ctx.model.usage();
			expect(usage.requests.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(1);
		} finally {
			await fake.close();
		}
	});

	it("插件说供应商变了、设了默认模型、停用时，告诉界面重取模型设置；一个插件加载时的几次只说一次", async () => {
		const service = await start([gateway()], { providers: [own], defaultModel: "p-own/m1" });
		const events: AgentEvent[] = [];
		const watching = new AbortController();
		void (async () => {
			for await (const event of service.watch({ signal: watching.signal }) as AsyncIterable<AgentEvent>) events.push(event);
		})().catch(() => {});
		const models = () => events.filter((event) => event.type === "models").length;
		try {
			// 等 watch 接上：先触发一次，收到了再开始数。
			ctx.providers.changed();
			await vi.waitFor(() => expect(models()).toBe(1));
			listed = [gateway({ name: "改名" })];
			ctx.providers.changed();
			ctx.providers.changed();
			await vi.waitFor(() => expect(models()).toBe(2));
			expect((await service.getSettings()).providers.at(-1)?.name).toBe("改名");
			await ctx.providers.setDefaultModel("gw/g1");
			await vi.waitFor(() => expect(models()).toBe(3));
			await service.setPluginEnabled("test.gateway", false);
			await vi.waitFor(() => expect(models()).toBe(4));
		} finally {
			watching.abort();
		}
	});

	it("插件读、设默认模型，校验和设置页一样；插件停用后它的供应商消失，默认回到自己的", async () => {
		const service = await start([gateway()], { providers: [own], defaultModel: "p-own/m1" });
		expect(await ctx.providers.defaultModel()).toBe("p-own/m1");
		await ctx.providers.setDefaultModel("gw/g1");
		expect((await service.getSettings()).defaultModel).toBe("gw/g1");
		await expect(ctx.providers.setDefaultModel("gw/none")).rejects.toThrow();
		await service.setPluginEnabled("test.gateway", false);
		const settings = await service.getSettings();
		expect(settings.providers.map((provider) => provider.id)).toEqual(["p-own"]);
		expect(settings.defaultModel).toBe("p-own/m1");
	});
});
