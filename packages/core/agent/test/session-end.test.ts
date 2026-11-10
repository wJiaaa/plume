import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Plugin, PluginContext, SessionEndReason, SessionObservation } from "@plume/contract";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, type FakeReply, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string;
let workspace: string;
let model: FakeModel | undefined;
let agent: Agent | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-session-end-"));
	workspace = join(dir, "workspace");
	await mkdir(workspace);
});

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	agent = undefined;
	model = undefined;
	await rm(dir, { recursive: true, force: true });
});

/** 起一个 agent 和一个记下会话结束、一轮收场的插件。 */
async function start(replies: FakeReply[]) {
	const ended: Array<[string, SessionEndReason]> = [];
	const turns: Array<Extract<SessionObservation["event"], { type: "turnEnd" }>["stop"]> = [];
	let ctx!: PluginContext;
	const watcher: Plugin = {
		name: "test.session-end",
		apply(context) {
			ctx = context;
			ctx.sessions.onEnded((sessionId, reason) => void ended.push([sessionId, reason]));
			ctx.sessions.observe((observation) => {
				if (observation.event.type === "turnEnd") turns.push(observation.event.stop);
			});
		},
	};
	model = await fakeAnthropic(replies);
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [...BUILTINS, { key: watcher.name, load: async () => watcher }],
		log: () => undefined,
	});
	const service = agent.service;
	const providerId = await service.saveProvider({
		id: "",
		name: "假模型",
		api: "anthropic-messages",
		baseUrl: model.url,
		enabled: true,
		models: [
			{ modelId: "fake", name: "fake", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages: false, supportsTools: true },
		],
		apiKey: "test-key",
	});
	await service.setDefaultModel(`${providerId}/fake`);
	return { service, ctx: () => ctx, ended, turns };
}

it("一轮收场时观察者收到 turnEnd 和原因", async () => {
	const { ctx, turns } = await start([{ text: "好" }, { status: 400 }]);
	const first = await ctx().sessions.launch({ cwd: workspace, message: "第一轮" });
	expect(await first.done).toEqual({ reason: "done" });
	const second = await ctx().sessions.launch({ cwd: workspace, message: "第二轮" });
	expect((await second.done).reason).toBe("error");
	await expect.poll(() => turns.map((stop) => stop.reason)).toEqual(["done", "error"]);
});

it("onEnded：删除、归档、换项目各说一次原因，退出时每个会话都说 quit", async () => {
	const { service, ctx, ended } = await start([]);
	const archived = await service.createSession({ cwd: workspace });
	const child = await ctx().sessions.create({ parentId: archived.id });
	await service.setSessionArchived(archived.id, true);
	// 已经归档的再归档一次不算结束。
	await service.setSessionArchived(archived.id, true);
	expect(ended).toEqual([
		[archived.id, "archived"],
		[child.id, "archived"],
	]);

	const moved = await service.createSession({ cwd: workspace });
	const destination = join(dir, "elsewhere");
	await mkdir(destination);
	const project = await service.createProject("别处", destination);
	await service.moveSessionProject(moved.id, project.id);
	// 目录没变的那次移动不算。
	await service.moveSessionProject(moved.id, project.id);
	expect(ended.slice(2)).toEqual([[moved.id, "moved"]]);

	const deleted = await service.createSession({ cwd: workspace });
	await service.deleteSession(deleted.id);
	expect(ended.slice(3)).toEqual([[deleted.id, "deleted"]]);

	const live = service.listSessions().map((summary) => summary.id);
	await agent!.shutdown();
	agent = undefined;
	expect(
		ended
			.slice(4)
			.map(([id, reason]) => `${id}:${reason}`)
			.sort(),
	).toEqual(live.map((id) => `${id}:quit`).sort());
});

it("退出时最多等 2 秒：一直不收尾的监听拖不住退出", async () => {
	const stuck: Plugin = {
		name: "test.stuck",
		apply: (ctx) => ctx.sessions.onEnded(() => new Promise(() => {})),
	};
	model = await fakeAnthropic([]);
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [...BUILTINS, { key: stuck.name, load: async () => stuck }],
		log: () => undefined,
	});
	await agent.service.createSession({ cwd: workspace });
	const began = Date.now();
	await agent.shutdown();
	agent = undefined;
	expect(Date.now() - began).toBeLessThan(4_000);
});
