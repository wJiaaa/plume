import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Plugin, PluginContext, SessionObservation } from "@plume/contract";
import { createAgent, type Agent } from "../src/agent.ts";
import { fakeAnthropic, type FakeModel } from "../src/testing.ts";

/**
 * `ctx.sessions.observe` 的范围：不声明时只收和自己有关的会话（自己建的、代管的和它下面的子会话、自己 launch 开出还没闲下来的），
 * 声明了 `observe: "all"` 的收全部会话的。
 */

let dir: string;
let agent: Agent | undefined;
let model: FakeModel | undefined;

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	agent = undefined;
	model = undefined;
	if (dir) await rm(dir, { recursive: true, force: true });
});

async function open() {
	dir = await mkdtemp(join(tmpdir(), "plume-observe-"));
	model = await fakeAnthropic(() => ({ text: "好" }));
	const contexts = new Map<string, PluginContext>();
	/** 插件名 → 它收到的观察来自哪些会话。 */
	const seen = new Map<string, SessionObservation[]>();
	const watcher = (name: string, all = false): Plugin => ({
		name,
		...(all ? { observe: "all" as const } : {}),
		apply(ctx) {
			contexts.set(name, ctx);
			seen.set(name, []);
			ctx.sessions.observe((observation) => void seen.get(name)!.push(observation));
		},
	});
	agent = await createAgent({
		dataDir: dir,
		settingsFile: join(dir, "settings.json"),
		plugins: [watcher("test.plain"), watcher("test.all", true), watcher("test.steward"), watcher("test.other")].map((plugin) => ({
			key: plugin.name,
			load: async () => plugin,
		})),
		log: () => undefined,
	});
	const service = agent.service;
	await service.saveProvider({
		id: "",
		name: "测试",
		api: "anthropic-messages",
		baseUrl: model.url,
		enabled: true,
		apiKey: "private-test-key",
		models: [
			{ modelId: "fake", name: "fake", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages: false, supportsTools: true },
		],
	});
	const settled = (id: string) =>
		vi.waitFor(
			async () => {
				const view = await service.getSession(id);
				if (view.summary.running || view.queue.length > 0) throw new Error("还在跑");
			},
			{ timeout: 5_000, interval: 10 },
		);
	/** 这个插件收到过哪些会话的观察。 */
	const sessionsSeen = (plugin: string) => new Set(seen.get(plugin)!.map((observation) => observation.sessionId));
	const turnEnds = (plugin: string, sessionId: string) =>
		seen.get(plugin)!.filter((observation) => observation.sessionId === sessionId && observation.event.type === "turnEnd").length;
	const ctx = (name: string) => contexts.get(name)!.sessions;
	return { service, settled, sessionsSeen, turnEnds, ctx };
}

it("人的会话：没声明的插件看不到，声明了 all 的看得到；自己建的子会话看得到，别人建的看不到", async () => {
	const { service, settled, sessionsSeen, turnEnds, ctx } = await open();
	const mine = await service.createSession({ cwd: dir });
	service.send(mine.id, { content: [{ type: "text", text: "人自己问" }] });
	await settled(mine.id);
	await vi.waitFor(() => expect(turnEnds("test.all", mine.id)).toBe(1));
	for (const plugin of ["test.plain", "test.steward", "test.other"]) expect(sessionsSeen(plugin).has(mine.id)).toBe(false);

	const child = await ctx("test.plain").create({ parentId: mine.id });
	await ctx("test.plain").send(child.id, "子会话里问");
	await vi.waitFor(() => expect(turnEnds("test.plain", child.id)).toBe(1));
	expect(turnEnds("test.all", child.id)).toBe(1);
	expect(sessionsSeen("test.other").has(child.id)).toBe(false);
	// 自己的子会话看得到，不等于看得到它的父会话。
	expect(sessionsSeen("test.plain").has(mine.id)).toBe(false);
});

it("代管插件不声明也看得到自己代管的会话和挂在它下面的子会话（子会话是别的插件建的也算），看不到别的", async () => {
	const { settled, sessionsSeen, turnEnds, ctx } = await open();
	const launched = await ctx("test.steward").launch({ cwd: dir, message: "开一个", steward: true });
	await launched.idle;
	const id = launched.session.id;
	await ctx("test.steward").post(id, "转一句");
	await settled(id);
	expect(turnEnds("test.steward", id)).toBe(2);

	const child = await ctx("test.other").create({ parentId: id });
	await ctx("test.other").send(child.id, "子会话里问");
	await vi.waitFor(() => expect(turnEnds("test.steward", child.id)).toBe(1));
	expect(turnEnds("test.other", child.id)).toBe(1);
	// 别的插件不代管这个会话：子会话是它建的，它看得到子会话，看不到代管会话本身。
	expect(sessionsSeen("test.other").has(id)).toBe(false);
	expect(sessionsSeen("test.plain").has(id) || sessionsSeen("test.plain").has(child.id)).toBe(false);
});

it("经 launch 开出的会话，开它的插件在它闲下来之前看得到；之后人接着聊的就看不到了；停止代管以后代管插件也看不到", async () => {
	const { service, settled, turnEnds, ctx } = await open();
	const launched = await ctx("test.plain").launch({ cwd: dir, message: "开一个" });
	await launched.idle;
	const id = launched.session.id;
	expect(turnEnds("test.plain", id)).toBe(1);
	service.send(id, { content: [{ type: "text", text: "人接着问" }] });
	await settled(id);
	await vi.waitFor(() => expect(turnEnds("test.all", id)).toBe(2));
	expect(turnEnds("test.plain", id)).toBe(1);

	const stewarded = await ctx("test.steward").launch({ cwd: dir, message: "开一个", steward: true });
	await stewarded.idle;
	await service.revokeSteward(stewarded.session.id);
	service.send(stewarded.session.id, { content: [{ type: "text", text: "人接着问" }] });
	await settled(stewarded.session.id);
	await vi.waitFor(() => expect(turnEnds("test.all", stewarded.session.id)).toBe(2));
	expect(turnEnds("test.steward", stewarded.session.id)).toBe(1);
});
