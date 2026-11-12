/**
 * 会话「真闲下来」要把工具起的后台工作算进去：plume.tools 的后台命令（`run_in_background`、monitor）和待触发的定时唤醒
 * （`schedule_wakeup`、`cron_create`）。看「闲没闲」的有四处：`launch` 的 `idle`、子会话经 `ToolRun.parent` 看到的
 * `ParentStatus`（侧边聊天看主会话用它）、摘要的 `background`、`idle` 事件（系统通知），还有 `Agent.busy()`。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentEvent, ParentStatus, Plugin, PluginContext } from "@plume/contract";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, type FakeReply, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string;
let workspace: string;
let model: FakeModel | undefined;
let agent: Agent | undefined;
const watching = new AbortController();

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-background-idle-"));
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

/** 比本体送达的聚合窗口（400ms）长：窗口里本来就算「还在等」，过了窗口还说没闲才说明真把后台工作算进去了。 */
const PAST_GATHER_MS = 700;

async function start(replies: FakeReply[]) {
	let ctx!: PluginContext;
	const seen: ParentStatus[] = [];
	const probe: Plugin = {
		name: "test.probe",
		inject: ["background.jobs", "session.wakeups"],
		apply(context) {
			ctx = context;
			// 子会话里的模型调它，记下这时父会话的状态：和侧边聊天的「看主会话在不在忙」是同一个入口。
			ctx.tools.register({
				name: "peek",
				description: "看父会话在不在忙",
				parameters: { type: "object", properties: {} },
				execute: async (_args, run) => {
					const status = run.parent?.status();
					if (status) seen.push(status);
					return { output: status?.state ?? "none" };
				},
			});
		},
	};
	model = await fakeAnthropic(replies);
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [...BUILTINS, { key: probe.name, load: async () => probe }],
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
	await service.setPermissionMode("full");
	const idleEvents: string[] = [];
	void (async () => {
		for await (const event of service.watch({ signal: watching.signal }) as AsyncIterable<AgentEvent>)
			if (event.type === "idle") idleEvents.push(event.sessionId);
	})();
	/** 用子会话里一次工具调用看父会话的状态：`send` 跑的一轮不算父会话派出去的后台运行，不会把父会话自己撑成「后台」。 */
	const peek = async (parentId: string) => {
		const child = await ctx.sessions.create({ parentId });
		await ctx.sessions.send(child.id, "看看主会话");
		return seen.at(-1);
	};
	/** 此刻各处说它闲没闲。 */
	const snapshot = async (sessionId: string, idle: () => boolean) => {
		const parent = await peek(sessionId);
		const summary = await ctx.sessions.get(sessionId);
		return {
			launchIdle: idle(),
			parentStatus: parent?.state,
			summaryBackground: summary?.background === true,
			idleEvent: idleEvents.includes(sessionId),
			busy: await agent!.busy(),
		};
	};
	return { ctx: () => ctx, snapshot };
}

/** promise 兑现了没有，不等它。 */
function settledFlag(promise: Promise<unknown>): () => boolean {
	let settled = false;
	void promise.then(
		() => (settled = true),
		() => (settled = true),
	);
	return () => settled;
}

const STILL_WAITING = { launchIdle: false, parentStatus: "background", summaryBackground: true, idleEvent: false, busy: true };

/*
 * 待修（第 4 步）：后台命令登记在 plume.tools 自己的任务表里，本体 `BackgroundRuns.pending` 看不见，这一轮一收尾各处就报「闲了」。
 * 实测（2026-11-12）`launchIdle` 已兑现、`parentStatus` 是 idle、`summaryBackground` 是 false、`idleEvent` 已发、`busy` 是 false。
 * 第 4 步把后台命令经 `BackgroundChannel.track` 登记进本体后去掉 skip（命令是 POSIX shell 的写法，到时用 `skipIf` 跳过 Windows）。
 */
it.skip("顶层会话起的后台命令没结束时不算闲：launch 的 idle、子会话看到的 ParentStatus、摘要、idle 事件、busy 都等它", async () => {
	const background = {
		id: "call_bg",
		name: "bash",
		args: { command: "while [ ! -f go ]; do sleep 0.05; done; echo finished", run_in_background: true, description: "等 go 文件" },
	};
	const peek = { id: "call_peek", name: "peek", args: {} };
	const { ctx, snapshot } = await start([{ toolCalls: [background] }, { text: "起好了" }, { toolCalls: [peek] }, { text: "看过了" }, { text: "命令跑完了" }]);
	const launched = await ctx().sessions.launch({ cwd: workspace, message: "起一个后台命令" });
	const id = launched.session.id;
	expect(await launched.done).toEqual({ reason: "done" });
	const idle = settledFlag(launched.idle);
	expect(ctx().use("background.jobs").list(id)).toMatchObject([{ status: "running" }]);
	await sleep(PAST_GATHER_MS);

	expect(await snapshot(id, idle)).toEqual(STILL_WAITING);

	// 命令结束：结果送进会话、开出一轮，那一轮做完才算闲。
	await writeFile(join(workspace, "go"), "");
	expect(await launched.idle).toMatchObject({ stop: { reason: "done" }, reply: "命令跑完了" });
	expect(await ctx().sessions.get(id)).not.toHaveProperty("background");
	expect(await agent!.busy()).toBe(false);
});

/*
 * 待修（第 4 步）：定时唤醒同样只在 plume.tools 的 `SessionWakeups` 里，本体不知道这个会话还约了「过一会儿再接着做」。
 * 实测（2026-11-12）结果同上一条：各处都报闲。第 4 步把调度经 `run.schedule` 搬进本体后去掉 skip。
 */
it.skip("有待触发的定时唤醒时不算闲；唤醒都取消了才闲", async () => {
	const wakeup = { id: "call_wakeup", name: "schedule_wakeup", args: { delay_seconds: 600, prompt: "再看看 CI", reason: "等 CI" } };
	const cron = { id: "call_cron", name: "cron_create", args: { cron: "0 9 * * *", prompt: "看看夜里的构建", recurring: false } };
	const peek = { id: "call_peek", name: "peek", args: {} };
	const { ctx, snapshot } = await start([{ toolCalls: [wakeup, cron] }, { text: "约好了" }, { toolCalls: [peek] }, { text: "看过了" }]);
	const launched = await ctx().sessions.launch({ cwd: workspace, message: "过一会儿再看" });
	const id = launched.session.id;
	expect(await launched.done).toEqual({ reason: "done" });
	const idle = settledFlag(launched.idle);
	const wakeups = ctx().use("session.wakeups");
	expect(wakeups.list(id)).toHaveLength(2);
	await sleep(PAST_GATHER_MS);

	expect(await snapshot(id, idle)).toEqual(STILL_WAITING);

	for (const { id: wakeupId } of wakeups.list(id)) expect(wakeups.cancel(id, wakeupId)).toBe(true);
	expect(await launched.idle).toMatchObject({ stop: { reason: "done" }, reply: "约好了" });
	expect(await ctx().sessions.get(id)).not.toHaveProperty("background");
});
