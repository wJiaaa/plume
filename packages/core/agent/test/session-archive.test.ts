/**
 * `ToolRun.archiveAfterTurn`：工具要求归档，本体等这一轮以完成收场后才归档；别的收场方式下请求作废，子会话拿不到这道口子。
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Plugin, PluginContext, SessionEndReason } from "@plume/contract";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, type FakeReply, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string;
let workspace: string;
let model: FakeModel | undefined;
let agent: Agent | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-session-archive-"));
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

/** 起一个 agent 和一个注册 `archive_me` 的插件：要求归档，`end` 为真时同时让这一轮停在这里。 */
async function start(replies: FakeReply[]) {
	let ctx!: PluginContext;
	const offered: boolean[] = [];
	const ended: Array<[string, SessionEndReason]> = [];
	const turns: string[] = [];
	const archiver: Plugin = {
		name: "test.archiver",
		apply(context) {
			ctx = context;
			ctx.sessions.onEnded((sessionId, reason) => void ended.push([sessionId, reason]));
			ctx.sessions.observe((observation) => {
				if (observation.event.type === "turnEnd") turns.push(observation.event.stop.reason);
			});
			ctx.tools.register({
				name: "archive_me",
				description: "archive",
				parameters: { type: "object", properties: { end: { type: "boolean" } } },
				async execute(args, run) {
					offered.push(run.archiveAfterTurn !== undefined);
					run.archiveAfterTurn?.();
					return { output: "archived after this turn", ...(args.end === true ? { terminate: "done" as const } : {}) };
				},
			});
		},
	};
	model = await fakeAnthropic(replies);
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [...BUILTINS, { key: archiver.name, load: async () => archiver }],
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
	const archived = (sessionId: string) => service.listSessions().find((summary) => summary.id === sessionId)?.archived === true;
	return { ctx: () => ctx, offered, ended, turns, archived, requests: () => model!.requests.length };
}

it("这一轮以完成收场后才归档：工具返回时还没归档，terminate 让这一轮停在这一下", async () => {
	const { ctx, archived, ended, requests } = await start([
		{ text: "做完了，按你说的归档。", toolCalls: [{ id: "c1", name: "archive_me", args: { end: true } }] },
	]);
	const launched = await ctx().sessions.launch({ cwd: workspace, message: "做完就归档" });
	expect(await launched.done).toEqual({ reason: "done" });
	await expect.poll(() => archived(launched.session.id)).toBe(true);
	expect(ended).toEqual([[launched.session.id, "archived"]]);
	// 调用之后没再问模型。
	expect(requests()).toBe(1);
});

it("出错收场不归档，请求只管那一轮：下一轮做完了也不归档", async () => {
	const { ctx, archived, turns } = await start([{ toolCalls: [{ id: "c1", name: "archive_me", args: {} }] }, { status: 400 }, { text: "好" }]);
	const launched = await ctx().sessions.launch({ cwd: workspace, message: "做完就归档" });
	expect((await launched.done).reason).toBe("error");
	expect(archived(launched.session.id)).toBe(false);
	agent!.service.send(launched.session.id, { content: [{ type: "text", text: "再说一句" }] });
	await expect.poll(() => turns).toEqual(["error", "done"]);
	expect(archived(launched.session.id)).toBe(false);
});

it("子会话拿不到这道口子", async () => {
	const { ctx, offered, archived } = await start([{ toolCalls: [{ id: "c1", name: "archive_me", args: { end: true } }] }]);
	const parent = await agent!.service.createSession({ cwd: workspace });
	const child = await ctx().sessions.create({ parentId: parent.id });
	expect(await ctx().sessions.send(child.id, "归档")).toEqual({ reason: "done" });
	expect(offered).toEqual([false]);
	expect(archived(parent.id)).toBe(false);
	expect(archived(child.id)).toBe(false);
});
