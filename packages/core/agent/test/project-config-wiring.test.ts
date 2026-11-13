import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentEvent, ModelContext, Plugin, PluginContext, ToolApproval } from "@plume/contract";
import prompt from "../../../builtin/prompt/src/index.ts";
import { createAgent, type Agent } from "../src/index.ts";
import { projectConfigPath } from "../src/project-config.ts";
import { fakeAnthropic, type FakeModel, type FakeReply } from "../src/testing.ts";

let dir: string;
let agent: Agent | undefined;
let model: FakeModel | undefined;
let ctx: PluginContext;
let watching: AbortController;
const contexts: ModelContext[] = [];
const permissions: ToolApproval[] = [];
const events: AgentEvent[] = [];
const resets: string[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-project-wiring-"));
	watching = new AbortController();
	contexts.length = permissions.length = events.length = 0;
	resets.length = 0;
});
afterEach(async () => {
	watching.abort();
	await agent?.shutdown();
	await model?.close();
	agent = undefined;
	model = undefined;
	await rm(dir, { recursive: true, force: true });
});

async function project(name: string, config: unknown): Promise<string> {
	const cwd = join(dir, name);
	await mkdir(join(cwd, ".plume"), { recursive: true });
	await writeFile(projectConfigPath(cwd), JSON.stringify(config));
	return cwd;
}

async function start(replies: Parameters<typeof fakeAnthropic>[0] = [{ text: "done" }]) {
	model = await fakeAnthropic(replies);
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			providers: [
				{
					id: "p",
					name: "test",
					api: "anthropic-messages",
					baseUrl: model.url,
					apiKey: "private-global-key",
					enabled: true,
					models: ["global", "cheap", "strong"].map((modelId) => ({
						modelId,
						name: modelId,
						contextWindow: 200000,
						maxOutputTokens: 32000,
						supportsThinking: false,
						supportsImages: false,
						supportsTools: true,
					})),
				},
			],
			defaultModel: "p/global",
			permissionMode: "auto",
			alwaysAllow: [{ plugin: "test.project-config", subject: "global" }],
			thinking: "medium",
			personalization: { customInstructions: "global instruction", tone: "friendly" },
			retryPolicy: { upstream: { retries: 1, intervalMs: 1000 } },
		}),
	);
	const probe: Plugin = {
		name: "test.project-config",
		apply(context) {
			ctx = context;
			ctx.sessions.onContextReset((sessionId) => resets.push(sessionId));
			ctx.hook("model.context", (input, next) => {
				contexts.push(structuredClone(input));
				return next(input);
			});
			ctx.hook("tool.approve", async (input) => {
				permissions.push(input);
				return "once";
			});
			ctx.tools.register({
				name: "probe",
				description: "read permission",
				parameters: { type: "object", properties: {} },
				mutating: true,
				asks: true,
				async execute(_args, run) {
					await run.ask({ kind: "probe", title: "probe", detail: "", subject: "probe" });
					return { output: await run.permissionMode() };
				},
			});
		},
	};
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "settings.json"),
		plugins: [prompt, probe].map((plugin) => ({ key: plugin.name, load: async () => plugin })),
		log: () => {},
	});
	void (async () => {
		for await (const event of agent!.service.watch({ signal: watching.signal })) events.push(event);
	})();
	return agent.service;
}

it("几个项目同时执行各自模型、收紧的权限、个性化和新会话思考默认，放宽权限的批准名单和完全访问不认，全局文件不变", async () => {
	const a = await project("a", { defaultModel: "p/cheap", permissionMode: "ask", thinking: "high", personalization: { tone: "concise" } });
	const b = await project("b", {
		defaultModel: "p/strong",
		alwaysAllow: [{ plugin: "test.project-config", subject: "probe" }],
		personalization: { customInstructions: "b instruction" },
	});
	const c = await project("c", { defaultModel: "p/cheap", permissionMode: "full" });
	const service = await start((request): FakeReply =>
		JSON.stringify(request.messages).includes('"tool_result"') ? { text: "done" } : { toolCalls: [{ id: `probe-${request.model}`, name: "probe", args: {} }] },
	);
	const before = await readFile(join(dir, "settings.json"), "utf8");
	const [left, right, full] = await Promise.all([
		ctx.sessions.launch({ cwd: a, message: "a" }),
		ctx.sessions.launch({ cwd: b, message: "b" }),
		ctx.sessions.launch({ cwd: c, message: "c" }),
	]);
	expect(await Promise.all([left.done, right.done, full.done])).toEqual([{ reason: "done" }, { reason: "done" }, { reason: "done" }]);
	expect(left.session.thinking).toBe("high");
	expect(right.session.thinking).toBe("medium");
	expect(
		contexts
			.filter((item) => item.cwd === a)
			.every(
				(item) => item.model.id === "p/cheap" && item.personalization.customInstructions === "global instruction" && item.personalization.tone === "concise",
			),
	).toBe(true);
	expect(
		contexts.filter((item) => item.cwd === b).every((item) => item.model.id === "p/strong" && item.personalization.customInstructions === "b instruction"),
	).toBe(true);
	// a 按项目收紧成请求批准，经钩子问；b 项目里写的批准名单、c 项目里的完全访问都会放宽权限，不认：照本机的帮我批准经钩子问。
	expect(permissions.map((item) => [item.cwd, item.permissionMode]).sort()).toEqual(
		[
			[a, "ask"],
			[b, "auto"],
			[c, "auto"],
		].sort(),
	);
	const outputs = await Promise.all(
		[left, right, full].map(async ({ session }) =>
			(await ctx.sessions.messages(session.id)).flatMap((message) =>
				message.role === "toolResult" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
			),
		),
	);
	expect(outputs).toEqual([["ask"], ["auto"], ["auto"]]);
	// 不认的放宽项每个会话说一次，写明是哪几个键；a 只收紧，不提醒。
	const loosening = (sessionId: string) =>
		events
			.filter((event) => event.type === "notice" && event.sessionId === sessionId && event.text.includes("只能收紧权限"))
			.map((event) => (event as { text: string }).text);
	expect(loosening(left.session.id)).toEqual([]);
	expect(loosening(right.session.id)).toEqual([expect.stringContaining("alwaysAllow")]);
	expect(loosening(full.session.id)).toEqual([expect.stringContaining("permissionMode")]);
	expect(new Set(model!.requests.map((request) => request.model))).toEqual(new Set(["cheap", "strong"]));
	expect((await service.getSettings()).permissionMode).toBe("auto");
	expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(before);
});

it("会话摘要给出项目配置收紧后实际生效的权限模式：放宽的不认时没有，本机换档、项目文件改了以后跟着变", async () => {
	const strict = await project("strict", { permissionMode: "ask" });
	const loose = await project("loose", { permissionMode: "full" });
	const same = await project("same", { permissionMode: "auto" });
	const service = await start();
	const summary = (id: string) => service.listSessions().find((session) => session.id === id);
	const [tightened, ignored, equal, plain] = await Promise.all([
		service.createSession({ cwd: strict }),
		service.createSession({ cwd: loose }),
		service.createSession({ cwd: same }),
		service.createSession({ cwd: dir }),
	]);
	// 本机帮我批准：项目要求请求批准照办，要求完全访问不认，照本机的走；没有项目配置的也没有这一项。
	expect(summary(tightened.id)?.projectPermission).toBe("ask");
	expect(summary(ignored.id)?.projectPermission).toBeUndefined();
	expect(summary(equal.id)?.projectPermission).toBe("auto");
	expect(summary(plain.id)?.projectPermission).toBeUndefined();
	expect((await service.getSession(tightened.id)).summary.projectPermission).toBe("ask");

	// 本机换成请求批准：项目的帮我批准比它宽了，不再生效；换成完全访问：项目的完全访问也只是不比本机宽，照它来。
	await service.setPermissionMode("ask");
	await expect.poll(() => summary(equal.id)?.projectPermission ?? null).toBeNull();
	expect(summary(tightened.id)?.projectPermission).toBe("ask");
	await service.setPermissionMode("full");
	await expect.poll(() => summary(equal.id)?.projectPermission).toBe("auto");
	await expect.poll(() => summary(ignored.id)?.projectPermission).toBe("full");
	await service.setPermissionMode("auto");
	await expect.poll(() => summary(ignored.id)?.projectPermission ?? null).toBeNull();

	// 项目文件改了：设置页读这个目录的项目配置、打开会话时都重读，变了推一次会话列表。
	await writeFile(projectConfigPath(loose), JSON.stringify({ permissionMode: "ask" }));
	events.length = 0;
	await service.projectLayer(loose);
	await expect.poll(() => summary(ignored.id)?.projectPermission).toBe("ask");
	expect(events.some((event) => event.type === "sessions" && event.sessions.find((session) => session.id === ignored.id)?.projectPermission === "ask")).toBe(
		true,
	);
	await writeFile(projectConfigPath(strict), "{}");
	expect((await service.getSession(tightened.id)).summary.projectPermission).toBeUndefined();
	// 只在内存里：重开以后从项目配置重新算，不从库里读回旧值。
	await agent!.shutdown();
	await writeFile(projectConfigPath(strict), JSON.stringify({ permissionMode: "full" }));
	agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "settings.json"), plugins: [], log: () => {} });
	expect(agent.service.listSessions().find((session) => session.id === ignored.id)?.projectPermission).toBeUndefined();
	expect((await agent.service.getSession(ignored.id)).summary.projectPermission).toBe("ask");
	expect((await agent.service.getSession(tightened.id)).summary.projectPermission).toBeUndefined();
});

it("已有会话在全局改动后仍保持项目覆盖，项目文件改动在下一次实际请求生效", async () => {
	const cwd = await project("sticky", { defaultModel: "p/cheap", personalization: { tone: "concise" } });
	const service = await start();
	const launched = await ctx.sessions.launch({ cwd, message: "first" });
	await launched.idle;
	await service.setDefaultModel("p/strong");
	await service.setPersonalization({ customInstructions: "new global" });
	await ctx.model.complete({ sessionId: launched.session.id, systemPrompt: "", prompt: "summary" });
	expect(model!.requests.at(-1)?.model).toBe("cheap");
	await writeFile(projectConfigPath(cwd), JSON.stringify({ defaultModel: "p/strong" }));
	await ctx.model.complete({ sessionId: launched.session.id, systemPrompt: "", prompt: "next" });
	expect(model!.requests.at(-1)?.model).toBe("strong");
	const child = await ctx.sessions.create({ parentId: launched.session.id, title: "child" });
	expect(await ctx.sessions.send(child.id, "child request")).toEqual({ reason: "done" });
	expect(contexts.at(-1)?.personalization.customInstructions).toBe("new global");
	expect(model!.requests.at(-1)?.model).toBe("strong");
	await service.setSessionModel(launched.session.id, "p/global");
	await ctx.model.complete({ sessionId: child.id, systemPrompt: "", prompt: "explicit parent model" });
	expect(model!.requests.at(-1)?.model).toBe("global");
});

it("默认生图模型按会话所在项目取，不给会话时用全局", async () => {
	const cwd = await project("image", { imageModel: "p/gpt-image-2" });
	const service = await start();
	const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
	const [base] = settings.providers[0].models;
	settings.providers[0].models.push(...["gpt-image-1", "gpt-image-2"].map((modelId) => ({ ...base, modelId, name: modelId })));
	settings.imageModel = "p/gpt-image-1";
	await writeFile(join(dir, "settings.json"), JSON.stringify(settings));
	const inProject = await service.createSession({ cwd });
	const elsewhere = await service.createSession({ cwd: dir });
	expect((await ctx.model.findImageModel()).model?.id).toBe("p/gpt-image-1");
	expect((await ctx.model.findImageModel(undefined, inProject.id)).model?.id).toBe("p/gpt-image-2");
	expect((await ctx.model.findImageModel(undefined, elsewhere.id)).model?.id).toBe("p/gpt-image-1");
	expect((await ctx.model.findImageModel("gpt-image-1", inProject.id)).model?.id).toBe("p/gpt-image-1");
	await expect(ctx.model.findImageModel(undefined, "missing")).rejects.toThrow();
});

it("拒绝配置里的凭据且只提醒一次，坏 JSON 回落全局，修好后新的问题仍提醒", async () => {
	const cwd = await project("notice", { defaultModel: "p/cheap", providers: [{ apiKey: "private-project-key" }], magpie: { apiKey: "private-gateway-key" } });
	const service = await start();
	const launched = await ctx.sessions.launch({ cwd, message: "first" });
	await launched.idle;
	await ctx.model.complete({ sessionId: launched.session.id, systemPrompt: "", prompt: "second" });
	const notices = () =>
		events.filter((event): event is Extract<AgentEvent, { type: "notice" }> => event.type === "notice" && event.sessionId === launched.session.id);
	expect(notices()).toHaveLength(1);
	expect(notices()[0]?.text).toContain("providers, magpie");
	expect(JSON.stringify(await service.projectLayer(cwd))).not.toMatch(/private-project-key|private-gateway-key|private-global-key/);
	await writeFile(projectConfigPath(cwd), "private-malformed-key");
	await ctx.model.complete({ sessionId: launched.session.id, systemPrompt: "", prompt: "broken" });
	expect(model!.requests.at(-1)?.model).toBe("global");
	expect(notices()).toHaveLength(2);
	expect(JSON.stringify(notices())).not.toMatch(/private-project-key|private-gateway-key|private-malformed-key/);
	await writeFile(projectConfigPath(cwd), "{}");
	await ctx.model.complete({ sessionId: launched.session.id, systemPrompt: "", prompt: "repaired" });
	await writeFile(projectConfigPath(cwd), "private-malformed-key");
	await ctx.model.complete({ sessionId: launched.session.id, systemPrompt: "", prompt: "broken again" });
	expect(notices()).toHaveLength(3);
});

it("并发项目的重试次数各自生效，不被全局读设置或另一项目串掉", async () => {
	const a = await project("no-retry", { defaultModel: "p/cheap", retryPolicy: { upstream: { retries: 0 } } });
	const b = await project("one-retry", { defaultModel: "p/strong", retryPolicy: { upstream: { retries: 1, intervalMs: 1000 } } });
	const calls = new Map<unknown, number>();
	await start((request) => {
		const count = (calls.get(request.model) ?? 0) + 1;
		calls.set(request.model, count);
		return count === 1 ? { status: 503 } : { text: "done" };
	});
	const [left, right] = await Promise.all([ctx.sessions.launch({ cwd: a, message: "a" }), ctx.sessions.launch({ cwd: b, message: "b" })]);
	expect((await left.done).reason).toBe("error");
	expect((await right.done).reason).toBe("done");
	expect(calls.get("cheap")).toBe(1);
	expect(calls.get("strong")).toBe(2);
});

it("成功撤回、编辑重发、换模型和从库重载刷新快照，普通读取和失败操作不刷新", async () => {
	const cwd = await project("resets", {});
	const service = await start();
	const launched = await ctx.sessions.launch({ cwd, message: "first" });
	await launched.idle;
	const id = launched.session.id;
	await service.getSession(id);
	expect(resets).toEqual([]);
	await expect(service.revertMessage(id, 1)).rejects.toThrow();
	expect(resets).toEqual([]);
	await service.setSessionModel(id, "p/cheap");
	expect(resets).toEqual([id]);
	await service.setSessionModel(id, "p/cheap");
	expect(resets).toEqual([id]);
	await service.editMessage(id, 0, { content: [{ type: "text", text: "edited" }] });
	await expect.poll(() => model!.requests.length).toBe(2);
	await expect.poll(() => service.listSessions().find((session) => session.id === id)?.running).toBe(false);
	expect(resets).toEqual([id, id]);
	await service.revertMessage(id, 0);
	expect(resets).toEqual([id, id, id]);
	await agent!.shutdown();
	const reopened: Plugin = {
		name: "test.project-config",
		apply(context) {
			context.sessions.onContextReset((sessionId) => resets.push(sessionId));
		},
	};
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "settings.json"),
		plugins: [{ key: reopened.name, load: async () => reopened }],
		log: () => {},
	});
	await agent.service.getSession(id);
	expect(resets).toEqual([id, id, id, id]);
	await agent.service.getSession(id);
	expect(resets).toEqual([id, id, id, id]);
});

it.skipIf(process.platform === "win32")("较慢的旧项目配置读取不能覆盖已完成的新读取", async () => {
	const cwd = await project("read-race", { defaultModel: "p/cheap" });
	const service = await start();
	const session = await service.createSession({ cwd });
	const path = projectConfigPath(cwd);
	await rm(path);
	execFileSync("mkfifo", [path]);
	const old = ctx.model.complete({ sessionId: session.id, systemPrompt: "", prompt: "old read" });
	// 写端打开成功就说明读端已打开 FIFO；直到这里关掉写端，旧配置的读取都不会返回。
	const held = await open(path, "w");
	try {
		const fresh = join(cwd, ".plume", "fresh.json");
		await writeFile(fresh, JSON.stringify({ defaultModel: "p/strong" }));
		await rename(fresh, path);
		await ctx.model.complete({ sessionId: session.id, systemPrompt: "", prompt: "new read" });
		await held.writeFile(JSON.stringify({ defaultModel: "p/cheap" }));
	} finally {
		await held.close();
	}
	await old;
	expect(model!.requests.map((request) => request.model)).toEqual(["strong", "strong"]);
});
