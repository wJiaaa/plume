/**
 * 设置页用到的 agent 接口：测试连接、拉模型列表、导入导出、会话的思考档位、模型目录同步。
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeModelCatalog, resetModelCatalog } from "@plume/llm/model-catalog";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "@plume/llm/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Agent, createAgent } from "../src/index.ts";
import { syncModelCatalog } from "../src/model-catalog-sync.ts";
import { stripForeignHandles } from "../src/models.ts";
import { applyImport, parseBundle, uniqueProviderName } from "../src/provider-transfer.ts";
import { type FakeModel, fakeAnthropic } from "../src/testing.ts";

let dir: string;
let agent: Agent | undefined;
let model: FakeModel | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-model-settings-"));
});

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	for (const close of closers.splice(0)) await close();
	agent = undefined;
	model = undefined;
	resetModelCatalog();
	await rm(dir, { recursive: true, force: true });
});

const entry = (modelId: string, supportsThinking = false) => ({
	modelId,
	name: modelId,
	contextWindow: 200_000,
	maxOutputTokens: 32_000,
	supportsThinking,
	supportsImages: false,
	supportsTools: true,
});

async function start(file: unknown = { providers: [] }) {
	await writeFile(join(dir, "settings.json"), JSON.stringify(file));
	agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "settings.json"), plugins: [], log: () => undefined });
	return agent.service;
}

/** 只回 `/v1/models` 的服务，记下收到的请求头。 */
async function listing(body: unknown, status = 200) {
	const headers: Array<Record<string, unknown>> = [];
	const server = createServer((request, response) => {
		headers.push(request.headers);
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => new Promise((resolve) => server.close(() => resolve())));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers };
}

describe("测试连接、拉模型列表", () => {
	it("指定模型时真发一次请求，用已保存的 key", async () => {
		model = await fakeAnthropic([{ text: "hi" }]);
		const service = await start();
		const id = await service.saveProvider({
			id: "",
			name: "假",
			api: "anthropic-messages",
			baseUrl: model.url,
			enabled: true,
			models: [entry("fake")],
			apiKey: "k",
		});
		const result = await service.testProvider(id, "fake");
		expect(result).toMatchObject({ ok: true, message: "连接成功，fake 响应正常" });
		expect(model.requests).toHaveLength(1);
		expect(await service.testProvider(id, "missing")).toMatchObject({ ok: false, message: "未找到指定的模型" });
	});

	it("拉模型列表：认三种返回格式、排序；Anthropic 用 x-api-key", async () => {
		const service = await start();
		for (const [body, api] of [
			[{ data: [{ id: "b" }, { id: "a" }] }, "openai-responses"],
			[{ models: [{ name: "b" }, { id: "a" }] }, "anthropic-messages"],
			[["b", "a"], "openai-chat-completions"],
		] as const) {
			const server = await listing(body);
			const id = await service.saveProvider({ id: "", name: api, api, baseUrl: `${server.url}/v1`, enabled: true, models: [], apiKey: "secret" });
			expect(await service.fetchModels(id)).toEqual({ ok: true, models: ["a", "b"] });
			const sent = server.headers[0] ?? {};
			if (api === "anthropic-messages") expect(sent["x-api-key"]).toBe("secret");
			else expect(sent.authorization).toBe("Bearer secret");
		}
	});

	it("列不出来时带上状态码；测整个供应商且没有模型时，列出来就算通", async () => {
		const service = await start();
		const failing = await listing({ error: "nope" }, 401);
		const bad = await service.saveProvider({ id: "", name: "坏", api: "openai-responses", baseUrl: failing.url, enabled: true, models: [], apiKey: "k" });
		expect((await service.fetchModels(bad)).error).toMatch(/^HTTP 401/);
		const working = await listing({ data: [{ id: "m1" }, { id: "m2" }] });
		const good = await service.saveProvider({ id: "", name: "好", api: "openai-responses", baseUrl: working.url, enabled: true, models: [], apiKey: "k" });
		expect(await service.testProvider(good, undefined)).toMatchObject({ ok: true, message: "连接成功，发现 2 个可用模型", models: ["m1", "m2"] });
	});
});

describe("会话的思考档位", () => {
	it("选了档位，下一轮带上思考参数；选回默认，跟模型的默认档", async () => {
		model = await fakeAnthropic([{ text: "好" }]);
		const service = await start();
		const id = await service.saveProvider({
			id: "",
			name: "假",
			api: "anthropic-messages",
			baseUrl: model.url,
			enabled: true,
			models: [
				{
					...entry("claude-opus-5-5", true),
					thinkingOptions: [
						{ id: "off", label: "关", detail: "" },
						{ id: "high", label: "高", detail: "", isDefault: true },
					],
				},
			],
			apiKey: "k",
		});
		const session = await service.createSession({ cwd: dir });
		await service.setSessionModel(session.id, `${id}/claude-opus-5-5`);
		await service.setSessionThinking(session.id, "off");
		expect((await service.getSession(session.id)).summary.thinking).toBe("off");
		await expect(service.setSessionThinking(session.id, "loud" as never)).rejects.toThrow("不认识的思考档位");

		const turn = async () => {
			const before = model?.requests.length ?? 0;
			service.send(session.id, { content: [{ type: "text", text: "你好" }] });
			while ((model?.requests.length ?? 0) === before || service.listSessions()[0]?.running) await new Promise((resolve) => setTimeout(resolve, 10));
			return model?.requests.at(-1) ?? {};
		};
		const off = await turn();
		await service.setSessionThinking(session.id, undefined);
		const byDefault = await turn();
		expect(off.thinking).toEqual({ type: "disabled" });
		expect(JSON.stringify([byDefault.thinking, byDefault.output_config])).not.toBe(JSON.stringify([off.thinking, off.output_config]));
	});
});

describe("导入导出", () => {
	const own = {
		id: "p-own",
		name: "公司",
		api: "openai-responses" as const,
		baseUrl: "https://example.invalid",
		enabled: true,
		apiKey: "sk-own",
		models: [entry("m1")],
	};

	it("导出带 key、不带 Magpie，文件只有本人可读；导回来按 id 替换、没 key 的保留本机的", async () => {
		const service = await start({ providers: [own], magpie: { baseUrl: "http://127.0.0.1:1", apiKey: "mg", models: [] } });
		const file = join(dir, "out", "providers.json");
		expect(await service.exportProviders(file)).toEqual({ providers: 1, containsSecrets: true });
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const bundle = JSON.parse(await readFile(file, "utf8"));
		expect(bundle).toMatchObject({ kind: "plume.providers", version: 1, containsSecrets: true });
		expect(bundle.providers.map((provider: { id: string; apiKey: string }) => [provider.id, provider.apiKey])).toEqual([["p-own", "sk-own"]]);

		// 去掉 key、改个地址，再加一个同名的新供应商
		bundle.providers[0].apiKey = "";
		bundle.providers[0].baseUrl = "https://changed.invalid";
		bundle.providers.push({ ...own, id: "p-new", apiKey: "sk-new" }, { id: "Bad Id", baseUrl: "https://x.invalid" });
		await writeFile(file, JSON.stringify(bundle));
		const preview = await service.previewProviderImport(file);
		expect(preview).toMatchObject({ ok: true, dropped: 1 });
		if (!preview.ok) throw new Error("应该读得懂");
		expect(preview.entries.map(({ id, kind, hasKey, keepsLocalKey }) => ({ id, kind, hasKey, keepsLocalKey }))).toEqual([
			{ id: "p-own", kind: "replace", hasKey: false, keepsLocalKey: true },
			{ id: "p-new", kind: "new", hasKey: true, keepsLocalKey: false },
		]);

		expect(await service.importProviders(file, ["p-own", "p-new"])).toBe(2);
		// key 不写进 settings.json（见 vault.ts），再导出一次才看得到。
		const saved = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
		expect(saved.providers.map((provider: { id: string; name: string; baseUrl: string }) => [provider.id, provider.name, provider.baseUrl])).toEqual([
			["p-own", "公司", "https://changed.invalid"],
			["p-new", "公司 2", "https://example.invalid"],
		]);
		expect(saved.providers.some((provider: { apiKey?: string }) => "apiKey" in provider)).toBe(false);
		await service.exportProviders(file);
		expect(JSON.parse(await readFile(file, "utf8")).providers.map((provider: { id: string; apiKey: string }) => [provider.id, provider.apiKey])).toEqual([
			["p-own", "sk-own"],
			["p-new", "sk-new"],
		]);
		expect((await service.getSettings()).providers.map((provider) => provider.id)).toEqual(["p-own", "p-new", "magpie"]);
	});

	it("读不懂的文件说明是哪一种；不认的字段丢掉", async () => {
		expect(parseBundle("{")).toEqual({ ok: false, problem: "not-json" });
		expect(parseBundle(JSON.stringify({ kind: "other", providers: [] }))).toEqual({ ok: false, problem: "not-a-bundle" });
		expect(parseBundle(JSON.stringify({ kind: "plume.providers", version: 2, providers: [] }))).toEqual({ ok: false, problem: "too-new" });
		expect(parseBundle(JSON.stringify({ kind: "plume.providers", providers: [{ id: "magpie", baseUrl: "http://x" }] }))).toEqual({
			ok: false,
			problem: "no-providers",
		});
		const bundle = parseBundle(
			JSON.stringify({
				kind: "plume.providers",
				version: 1,
				providers: [
					{
						id: "relay",
						baseUrl: "https://r.invalid",
						headers: { a: "b" },
						models: [{ id: "relay/gpt", providerId: "relay", modelId: "gpt", pricing: { input: Number.NaN, output: 1 } }],
					},
				],
			}),
		);
		expect(bundle.ok && bundle.providers[0]).toEqual({
			id: "relay",
			name: "relay",
			api: "openai-responses",
			baseUrl: "https://r.invalid",
			enabled: true,
			models: [{ ...entry("gpt", true), maxOutputTokens: 16_384, supportsImages: true }],
		});
	});

	it("新加的名字避开重名，替换的保留原名", () => {
		expect(uniqueProviderName(["A", "A 2"], "A")).toBe("A 3");
		const existing = [{ ...own, name: "A" }];
		expect(
			applyImport(existing, [
				{ ...own, name: "A" },
				{ ...own, id: "p-2", name: "A" },
			]).map((provider) => provider.name),
		).toEqual(["A", "A 2"]);
	});
});

describe("模型目录同步", () => {
	const pi = {
		openai: {
			"gpt-test": { id: "gpt-test", name: "GPT Test", contextWindow: 100, maxTokens: 10, reasoning: false, input: ["text"], cost: { input: 1, output: 2 } },
		},
	};

	it("新目录换上并缓存，带 ETag 的 304 算没变，失败时现有目录不动", async () => {
		const cacheFile = join(dir, "cache", "model-catalog.json");
		const seen: Array<string | null> = [];
		const fetch = (async (_url: string, init?: RequestInit) => {
			const etag = new Headers(init?.headers).get("if-none-match");
			seen.push(etag);
			if (etag === '"v1"') return new Response(null, { status: 304 });
			return new Response(JSON.stringify(pi), {
				headers: { etag: '"v1"', "x-pi-model-catalog-revision": `test-${Date.now()}`, "last-modified": new Date(Date.now() + 86_400_000).toUTCString() },
			});
		}) as typeof globalThis.fetch;

		expect(await syncModelCatalog(cacheFile, { fetch })).toMatchObject({ status: "updated", source: { name: "pi.dev" } });
		expect(JSON.parse(await readFile(cacheFile, "utf8")).etag).toBe('"v1"');
		expect((await syncModelCatalog(cacheFile, { fetch })).status).toBe("unchanged");
		expect(seen).toEqual([null, '"v1"']);
		const revision = activeModelCatalog().source.revision;
		const failed = await syncModelCatalog(cacheFile, { fetch: (async () => new Response("", { status: 500 })) as typeof globalThis.fetch });
		expect(failed).toMatchObject({ status: "failed", error: "HTTP 500" });
		expect(activeModelCatalog().source.revision).toBe(revision);
	});

	it("modelCatalog 版本相同时不传整份", async () => {
		await mkdir(join(dir, "data"), { recursive: true });
		const service = await start();
		const document = await service.modelCatalog(undefined);
		expect(document?.source.revision).toBeTruthy();
		expect(await service.modelCatalog(document?.source.revision)).toBeNull();
	});
});

describe("换模型后的历史", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const reply = (provider: string, modelId: string): Message => ({
		role: "assistant",
		api: "anthropic-messages",
		provider,
		model: modelId,
		usage,
		stopReason: "toolUse",
		timestamp: 0,
		content: [
			{ type: "thinking", thinking: "想", signature: "sig", encrypted: "enc", redacted: true },
			{ type: "text", text: "答", signature: "msg-1" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: {}, signature: "fc-1" },
		],
	});
	const current = { provider: { id: "a" } as ProviderConfig, model: { modelId: "m1" } as ModelConfig };

	it("别的模型写的回复去掉句柄、留下文字和工具调用 id；当前模型写的原样", () => {
		const own = reply("a", "m1");
		const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "问" }], timestamp: 0 }, reply("b", "m1"), reply("a", "m2"), own];
		const out = stripForeignHandles(messages, current.provider, current.model);
		for (const message of out.slice(1, 3)) {
			expect((message as AssistantMessage).content).toEqual([
				{ type: "thinking", thinking: "想" },
				{ type: "text", text: "答" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
			]);
		}
		expect(out[3]).toBe(own);
		expect(out[0]).toBe(messages[0]);
		// 原来的不动。
		expect((messages[1] as AssistantMessage).content[0]).toHaveProperty("signature", "sig");
	});

	it("没换过模型时原样返回同一个数组", () => {
		const messages: Message[] = [reply("a", "m1")];
		expect(stripForeignHandles(messages, current.provider, current.model)).toBe(messages);
	});
});

it("开头带 BOM 的 settings.json 照常读出来", async () => {
	// 记事本存的「UTF-8 带 BOM」、PowerShell 5.1 的 `Set-Content -Encoding UTF8` 都在文件头写 U+FEFF。
	await writeFile(join(dir, "settings.json"), `\uFEFF${JSON.stringify({ providers: [], personalization: { customInstructions: "BOM", tone: "concise" } })}`);
	agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "settings.json"), plugins: [], log: () => undefined });
	expect((await agent.service.getSettings()).personalization).toEqual({ customInstructions: "BOM", tone: "concise" });
});
