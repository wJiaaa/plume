/**
 * 工具登记进本体的后台工作（`ToolRun.track`、`ToolRun.schedule`）：一次性的后台任务在时会话不算闲，结束、被人停掉、撤回截掉起它的
 * 那次调用后恢复为闲；挂着的（`wakes` 的监视、经 `stand` 标成服务的、约好的唤醒）不挡闲；子会话的任务列得出来、派出去的那次运行
 * 结束时被本体停掉；唤醒到点送进会话的是约它的插件给的话、那一行记在它名下；人按停时唤醒全部取消并说一声。用假工具登记，不起真进程：
 * 真命令的那一条在 `background-idle.test.ts`。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent, Plugin, PluginContext, TrackedJob, UserMessage } from "@plume/contract";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, type FakeReply, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string;
let workspace: string;
let model: FakeModel | undefined;
let agent: Agent | undefined;
let watching: AbortController;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-background-work-"));
	workspace = join(dir, "workspace");
	await mkdir(workspace);
	watching = new AbortController();
});

afterEach(async () => {
	watching.abort();
	await agent?.shutdown();
	await model?.close();
	agent = undefined;
	model = undefined;
	await rm(dir, { recursive: true, force: true });
});

async function start(replies: FakeReply[]) {
	let ctx!: PluginContext;
	/** 登记过的假任务：本体叫停时记下来，并当作它退出了。 */
	const jobs = new Map<string, { handle: TrackedJob; stops: boolean[] }>();
	const probe: Plugin = {
		name: "test.probe",
		apply(context) {
			ctx = context;
			ctx.tools.register({
				name: "start_job",
				description: "起一个后台任务",
				parameters: { type: "object", properties: { wakes: { type: "boolean" } } },
				execute: async (args, run) => {
					const stops: boolean[] = [];
					const handle = run.track({
						command: "serve",
						description: "起个服务",
						...(args.wakes === true ? { wakes: true } : {}),
						output: async () => ({ text: "listening", done: false, truncated: false }),
						stop: (force) => {
							stops.push(force);
							handle.done(null);
						},
					});
					jobs.set(handle.id, { handle, stops });
					return { output: `started ${handle.id}` };
				},
			});
			ctx.tools.register({
				name: "wake_soon",
				description: "过一会儿再接着做",
				parameters: { type: "object", properties: { ms: { type: "number" } } },
				execute: async (args, run) => {
					const wakeup = run.schedule?.({
						at: Date.now() + Number(args.ms),
						prompt: "接着看",
						reason: "等一下",
						message: (current, info) => ({
							text: `WAKE ${current.id} fired=${current.fired} next=${String(info.next)}`,
							delivery: { id: current.id, title: "醒来", status: "done", details: { mine: true } },
						}),
					});
					return { output: wakeup ? `scheduled ${wakeup.id}` : "no schedule here" };
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
	const events: AgentEvent[] = [];
	void (async () => {
		for await (const event of service.watch({ signal: watching.signal }) as AsyncIterable<AgentEvent>) events.push(event);
	})();
	const launch = async (message: string) => {
		const launched = await ctx.sessions.launch({ cwd: workspace, message });
		expect(await launched.done).toEqual({ reason: "done" });
		let idle = false;
		void launched.idle.then(() => (idle = true));
		return { launched, id: launched.session.id, idle: () => idle };
	};
	const background = async (id: string) => (await ctx.sessions.get(id))?.background === true;
	return { ctx: () => ctx, service, jobs, events, launch, background };
}

const startJob = { toolCalls: [{ id: "call_job", name: "start_job", args: {} }] };

it("后台任务在时不算闲；结束了才闲", async () => {
	const h = await start([startJob, { text: "起好了" }]);
	const { launched, id, idle } = await h.launch("起个服务");
	await vi.waitFor(() => expect(h.jobs.size).toBe(1));
	// 过了送达的聚合窗口（400ms）还说没闲，才是任务本身撑着。
	await new Promise((resolve) => setTimeout(resolve, 600));
	expect(idle()).toBe(false);
	expect(await h.background(id)).toBe(true);
	expect(await agent!.busy()).toBe(true);
	expect(h.ctx().sessions.jobs(id)).toMatchObject([{ command: "serve", description: "起个服务", status: "running" }]);
	expect(await h.ctx().sessions.jobOutput(id, [...h.jobs.keys()][0]!)).toMatchObject({ text: "listening" });
	[...h.jobs.values()][0]!.handle.done(0);
	await launched.idle;
	expect(await h.background(id)).toBe(false);
	expect(h.ctx().sessions.jobs(id)).toMatchObject([{ status: "exited", exitCode: 0 }]);
	expect(h.events.some((event) => event.type === "idle" && event.sessionId === id)).toBe(true);
});

it("有输出就叫醒会话的监视（`wakes`）是挂着的：在跑时会话照样闲", async () => {
	const h = await start([{ toolCalls: [{ id: "call_job", name: "start_job", args: { wakes: true } }] }, { text: "盯上了" }]);
	const { launched, id } = await h.launch("盯着日志");
	expect(await launched.idle).toMatchObject({ stop: { reason: "done" }, reply: "盯上了" });
	expect(h.ctx().sessions.jobs(id)).toMatchObject([{ status: "running", wakes: true }]);
	expect(await h.background(id)).toBe(false);
	expect(await agent!.busy()).toBe(false);
	await vi.waitFor(() => expect(h.events.some((event) => event.type === "idle" && event.sessionId === id)).toBe(true));
});

it("任务跑起来以后被标成挂着的（`stand`，认出是开发服务器）：不再挡闲，idle 兑现、idle 事件发出；之后再标、结束都不变", async () => {
	const h = await start([startJob, { text: "起好了" }]);
	const { launched, id, idle } = await h.launch("起个服务");
	await vi.waitFor(() => expect(h.jobs.size).toBe(1));
	await new Promise((resolve) => setTimeout(resolve, 600));
	expect(idle()).toBe(false);
	expect(await h.background(id)).toBe(true);
	const { handle } = [...h.jobs.values()][0]!;
	handle.stand();
	expect(await launched.idle).toMatchObject({ stop: { reason: "done" }, reply: "起好了" });
	expect(await h.background(id)).toBe(false);
	expect(await agent!.busy()).toBe(false);
	await vi.waitFor(() => expect(h.events.some((event) => event.type === "idle" && event.sessionId === id)).toBe(true));
	expect(h.ctx().sessions.jobs(id)).toMatchObject([{ status: "running" }]);
	handle.stand();
	handle.done(0);
	expect(await h.background(id)).toBe(false);
});

it("人按停：任务不再算在等（本体不替工具停它），会话恢复为闲；面板里叫停走登记时给的 stop", async () => {
	const h = await start([startJob, { text: "起好了" }]);
	const { launched, id } = await h.launch("起个服务");
	await vi.waitFor(() => expect(h.jobs.size).toBe(1));
	expect(await h.background(id)).toBe(true);
	h.service.stop(id);
	await launched.idle;
	expect(await h.background(id)).toBe(false);
	const [jobId, job] = [...h.jobs.entries()][0]!;
	expect(job.stops).toEqual([]);
	expect(h.ctx().sessions.jobs(id)).toMatchObject([{ status: "running" }]);
	expect(h.ctx().sessions.stopJob("别的会话", jobId, false)).toBe(false);
	expect(h.ctx().sessions.stopJob(id, jobId, false)).toBe(true);
	expect(job.stops).toEqual([false]);
	expect(h.ctx().sessions.stopJob(id, jobId, true)).toBe(false);
	await expect(h.ctx().sessions.jobOutput("别的会话", jobId)).rejects.toThrow();
});

it("撤回截掉起它的那次调用：任务不再算在等，会话恢复为闲；删会话时本体停掉它", async () => {
	const h = await start([startJob, { text: "起好了" }]);
	const { launched, id } = await h.launch("起个服务");
	await vi.waitFor(() => expect(h.jobs.size).toBe(1));
	expect(await h.background(id)).toBe(true);
	// 收尾的压缩检查放开会话以后才能撤回。
	await vi.waitFor(async () => expect((await h.ctx().sessions.get(id))?.running).toBe(false));
	await h.service.revertMessage(id, 0);
	await launched.idle;
	expect(await h.background(id)).toBe(false);
	const job = [...h.jobs.values()][0]!;
	expect(job.stops).toEqual([]);
	await h.service.deleteSession(id);
	expect(job.stops).toEqual([true]);
	expect(h.ctx().sessions.jobs(id)).toEqual([]);
});

it("子会话的后台任务列得出来，不算父会话在等；派出去的那次运行结束时本体停掉它", async () => {
	const h = await start([{ text: "好" }, startJob, { text: "子会话起好了" }]);
	const { id } = await h.launch("开个会话");
	const child = await h.ctx().sessions.create({ parentId: id });
	const run = await h.ctx().sessions.start(child.id, "起个服务");
	expect(await h.ctx().sessions.wait(run.id)).toEqual({ reason: "done" });
	const [jobId, job] = [...h.jobs.entries()][0]!;
	expect(job.stops).toEqual([true]);
	expect(h.ctx().sessions.jobs(child.id)).toMatchObject([{ id: jobId, status: "exited" }]);
	expect(h.ctx().sessions.jobs(id)).toEqual([]);
});

it("唤醒是挂着的，在时会话照样闲；到点送进去的是约它的插件给的话，那一行记在它名下，开出一轮", async () => {
	const h = await start([{ toolCalls: [{ id: "call_wake", name: "wake_soon", args: { ms: 800 } }] }, { text: "约好了" }, { text: "醒了接着看" }]);
	const { launched, id } = await h.launch("过一会儿再看");
	expect(h.ctx().sessions.wakeups(id)).toMatchObject([{ id: "wake-1", kind: "wakeup", reason: "等一下", fired: 0 }]);
	expect(await launched.idle).toMatchObject({ stop: { reason: "done" }, reply: "约好了" });
	expect(await h.background(id)).toBe(false);
	expect(await agent!.busy()).toBe(false);
	await vi.waitFor(async () => {
		const last = (await h.ctx().sessions.messages(id)).at(-1);
		expect(last).toMatchObject({ role: "assistant", content: [{ type: "text", text: "醒了接着看" }] });
	}, 5000);
	const messages = await h.ctx().sessions.messages(id);
	const delivered = messages.find((message): message is UserMessage => message.role === "user" && message.delivery !== undefined);
	expect(delivered?.delivery).toEqual([{ id: "wake-1", plugin: "test.probe", title: "醒来", status: "done", details: { mine: true } }]);
	expect(JSON.stringify(delivered?.content)).toContain("WAKE wake-1 fired=1 next=null");
	expect(h.ctx().sessions.wakeups(id)).toEqual([]);
});

it("人按停：唤醒全部取消，说一声取消了几个", async () => {
	const wake = (n: number) => ({ id: `call_wake_${n}`, name: "wake_soon", args: { ms: 600_000 } });
	const h = await start([{ toolCalls: [wake(1), wake(2)] }, { text: "约好了" }]);
	const { launched, id } = await h.launch("过一会儿再看");
	expect(h.ctx().sessions.wakeups(id)).toHaveLength(2);
	h.service.stop(id);
	await launched.idle;
	expect(h.ctx().sessions.wakeups(id)).toEqual([]);
	expect(await h.background(id)).toBe(false);
	await vi.waitFor(() =>
		expect(h.events).toContainEqual(
			expect.objectContaining({ type: "notice", sessionId: id, text: expect.stringMatching(/2 个定时唤醒一并取消|2 scheduled wakeups/) }),
		),
	);
	// 已经取消了的再取消：false。
	expect(h.ctx().sessions.cancelWakeup(id, "wake-1")).toBe(false);
});
