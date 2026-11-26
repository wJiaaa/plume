import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Message, Plugin, PluginContext, SessionAccess, SessionLaunch, ToolRun } from "@plume/contract";
import { createAgent, type Agent } from "../src/agent.ts";
import { fakeAnthropic, type FakeModel, type FakeReply } from "../src/testing.ts";

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

async function open(
	replies: FakeReply[] | ((request: Record<string, unknown>) => FakeReply),
	configure: (ctx: PluginContext) => void = () => undefined,
	others: Plugin[] = [],
) {
	dir = await mkdtemp(join(tmpdir(), "plume-launch-"));
	model = await fakeAnthropic(replies);
	let sessions!: SessionAccess;
	const plugin: Plugin = {
		name: "test.launcher",
		apply(ctx) {
			sessions = ctx.sessions;
			configure(ctx);
		},
	};
	agent = await createAgent({
		dataDir: dir,
		settingsFile: join(dir, "settings.json"),
		plugins: [plugin, ...others].map((entry) => ({ key: entry.name, load: async () => entry })),
		log: () => undefined,
	});
	const service = agent.service;
	const providerId = await service.saveProvider({
		id: "",
		name: "测试",
		api: "anthropic-messages",
		baseUrl: model.url,
		enabled: true,
		apiKey: "private-test-key",
		models: ["fake", "other"].map((modelId) => ({
			modelId,
			name: modelId,
			contextWindow: 200_000,
			maxOutputTokens: 32_000,
			supportsThinking: false,
			supportsImages: true,
			supportsTools: true,
		})),
	});
	return { service, sessions: () => sessions, providerId };
}

it("开一个顶层会话：进侧栏、不记在插件名下，第一句经 prompt.submit，done 给出第一轮怎么结束", async () => {
	const submitted: Array<{ text: string; fresh: boolean; synthetic: boolean; launched: boolean }> = [];
	const { service, sessions } = await open([{ text: "跑完了" }], (ctx) => {
		ctx.hook("prompt.submit", async (input, next) => {
			submitted.push({ text: input.text, fresh: input.fresh, synthetic: input.synthetic, launched: input.launched });
			return next(input);
		});
	});
	const { session, done } = await sessions().launch({ cwd: dir, message: "检查一下改动" });
	expect(session).toMatchObject({ cwd: dir, title: "" });
	expect(session.owner).toBeUndefined();
	expect(session.parentId).toBeUndefined();
	expect(await done).toEqual({ reason: "done" });
	expect(submitted).toEqual([{ text: "检查一下改动", fresh: true, synthetic: false, launched: true }]);

	const view = await service.getSession(session.id);
	expect(view.summary.title).toBe("检查一下改动");
	expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	expect(view.messages[0]).not.toHaveProperty("synthetic");
	expect(service.listSessions().some((summary) => summary.id === session.id)).toBe(true);

	// 开出来就是人的会话：人能接着聊；插件不能再往里发、停、删。
	await expect(sessions().send(session.id, "插件想接着说")).rejects.toThrow("不是插件 test.launcher 建的");
	await expect(sessions().delete(session.id)).rejects.toThrow("不是插件 test.launcher 建的");
	expect(() => service.send(session.id, { content: [{ type: "text", text: "人接着问" }] })).not.toThrow();
});

it("项目、模型、思考档位、标题、来处都能带上；第一轮出错时 done 交回原因", async () => {
	const { service, sessions } = await open([{ status: 401 }]);
	const created = await service.createProject("仓库", dir, undefined);
	// 逻辑入口自己查得到项目：只给 id、名字、目录。
	const projects = await sessions().projects();
	expect(projects).toEqual([{ id: created.id, name: "仓库", path: dir }]);
	const project = projects[0]!;
	const source = await service.createSession({ cwd: dir });
	const { session, done } = await sessions().launch({
		project: project.id,
		message: "按计划做",
		model: (await sessions().models()).find((entry) => entry.name === "other")!.id,
		thinking: "high",
		title: "  执行 计划  ",
		spawnedFrom: { sessionId: source.id },
	});
	expect(session).toMatchObject({ project: project.id, cwd: dir, title: "执行 计划", spawnedFrom: { sessionId: source.id } });
	expect(session.model).toMatch(/\/other$/);
	expect(session.thinking).toBe("high");
	const stop = await done;
	expect(stop.reason).toBe("error");
	expect(stop.error).toBeTruthy();
	expect((await service.getSession(session.id)).summary.title).toBe("执行 计划");
});

it("第一句被 prompt.submit 拦下时这一轮按完成收场，会话照样在", async () => {
	const { service, sessions } = await open([{ text: "不该发" }], (ctx) => {
		ctx.hook("prompt.submit", async () => ({ block: true, reason: "不许" }));
	});
	const { session, done } = await sessions().launch({ cwd: dir, message: "试试" });
	expect(await done).toEqual({ reason: "done" });
	expect((await service.getSession(session.id)).messages).toEqual([]);
	expect(model?.requests).toHaveLength(0);
});

it("只开新的：目录、项目、模型、思考档位、来处不对都抛错，不开出半个会话", async () => {
	const { service, sessions } = await open([{ text: "x" }]);
	const before = service.listSessions().length;
	await expect(sessions().launch({ cwd: dir, message: "  " })).rejects.toThrow("消息不能为空");
	await expect(sessions().launch({ cwd: "relative/dir", message: "做" })).rejects.toThrow("不是已有目录的绝对路径");
	await expect(sessions().launch({ cwd: join(dir, "missing"), message: "做" })).rejects.toThrow("不是已有目录的绝对路径");
	await expect(sessions().launch({ project: "nope", message: "做" })).rejects.toThrow();
	await expect(sessions().launch({ cwd: dir, message: "做", model: "nope/none" })).rejects.toThrow();
	await expect(sessions().launch({ cwd: dir, message: "做", thinking: "loud" as never })).rejects.toThrow("loud");
	await expect(sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: "nope" } })).rejects.toThrow("没有会话 nope");
	const parent = await service.createSession({ cwd: dir });
	const child = await sessions().create({ parentId: parent.id });
	await expect(sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: child.id } })).rejects.toThrow("下面不能再建子会话");
	expect(service.listSessions()).toHaveLength(before + 2);
});

it("插件停用以后，留着的 ctx 开不了会话", async () => {
	const { service, sessions } = await open([{ text: "x" }]);
	const stale = sessions();
	await service.setPluginEnabled("test.launcher", false);
	await expect(stale.launch({ cwd: dir, message: "做" })).rejects.toThrow("已停用");
	expect(service.listSessions()).toHaveLength(0);
});

/**
 * 来处会话里先有一次本插件工具（`suggest`）的调用 `call_1`：带调用 id 开（每轮交回）、带记录开只认这样的来处。之后的请求按 `replies` 答，
 * 给函数时按请求里最后一条消息的字答（几个会话同时在跑，先后不定）。
 */
async function withSuggestion(
	replies: FakeReply[] | ((last: string) => FakeReply),
	configure: (ctx: PluginContext) => void = () => undefined,
	others: Plugin[] = [],
) {
	let served = 0;
	const answer = (request: Record<string, unknown>): FakeReply => {
		served++;
		if (served === 1) return { toolCalls: [{ id: "call_1", name: "suggest", args: {} }] };
		if (served === 2) return { text: "建议好了" };
		return typeof replies === "function" ? replies(lastText(request)) : (replies[served - 3] ?? { text: "多出来的一问" });
	};
	const opened = await open(
		answer,
		(ctx) => {
			ctx.tools.register({ name: "suggest", description: "提建议", parameters: { type: "object", properties: {} }, execute: async () => ({ output: "好" }) });
			configure(ctx);
		},
		others,
	);
	const source = await opened.service.createSession({ cwd: dir });
	opened.service.send(source.id, { content: [{ type: "text", text: "看看" }] });
	await vi.waitFor(async () => expect((await opened.service.getSession(source.id)).summary.stop).toEqual({ reason: "done" }), { timeout: 5_000, interval: 10 });
	return { ...opened, source };
}

/** 请求体里最后一条消息的字（工具结果也算；本体接的日期 `<env>` 是单独一条，不算）。 */
function lastText(request: Record<string, unknown>): string {
	const messages = ((request.messages ?? []) as Array<{ content: unknown }>).filter((message) => !JSON.stringify(message.content).includes('"text":"<env>'));
	return JSON.stringify(messages.at(-1)?.content ?? "");
}

const roles = async (service: Awaited<ReturnType<typeof open>>["service"], id: string) =>
	(await service.getSession(id)).messages.map((message) => (message.role === "user" && message.delivery ? "delivery" : message.role));

const settled = async (service: Awaited<ReturnType<typeof open>>["service"], id: string, expected: string[]) =>
	vi.waitFor(
		async () => {
			expect(await roles(service, id)).toEqual(expected);
			expect((await service.getSession(id)).summary.running).toBe(false);
		},
		{ timeout: 5_000, interval: 10 },
	);

/** 一条消息里的字。 */
const textOf = (message: Message | undefined) =>
	message && message.role !== "toolResult" && Array.isArray(message.content)
		? message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
		: "";

it("开出来的会话每结束一轮，本体把收尾那段回复交回来处：第一轮叫醒来处；那一行带着新会话的 id、记在开它的插件名下", async () => {
	const { service, sessions, source } = await withSuggestion((last) =>
		last.includes("session-report") ? { text: "收到交回的结果" } : { text: "新会话做完了" },
	);
	const launched = await sessions().launch({
		cwd: dir,
		message: "去做",
		title: "清理死代码",
		spawnedFrom: { sessionId: source.id, toolCallId: "call_1", name: "cleanup", reportBack: true },
	});
	await settled(service, source.id, ["user", "assistant", "toolResult", "assistant", "delivery", "assistant"]);
	const delivered = (await service.getSession(source.id)).messages[4];
	expect(delivered).toMatchObject({
		role: "user",
		synthetic: true,
		delivery: [{ plugin: "test.launcher", title: "清理死代码", status: "done", sessionId: launched.session.id, text: "新会话做完了" }],
	});
	const words = textOf(delivered);
	expect(words).toContain("不是用户说的话");
	expect(words).toContain(`<session-report id="${launched.session.id}" name="cleanup" title="清理死代码" status="done">`);
	expect(words).toContain("新会话做完了");
});

it("人在开出来的会话里说话引起的那一轮、来处被人按停时交回的：都不叫醒来处，留到它下一轮开头接在人那句后面读到", async () => {
	const { service, sessions, source } = await withSuggestion((last) => ({ text: last.includes("再改一下") ? "改好了" : "新会话做完了" }));
	service.stop(source.id);
	const launched = await sessions().launch({ cwd: dir, message: "去做", spawnedFrom: { sessionId: source.id, toolCallId: "call_1", reportBack: true } });
	await launched.idle;
	service.send(launched.session.id, { content: [{ type: "text", text: "再改一下" }] });
	await settled(service, launched.session.id, ["user", "assistant", "user", "assistant"]);
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	expect(await roles(service, source.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	expect((await service.getSession(source.id)).summary.background ?? false).toBe(false);
	service.send(source.id, { content: [{ type: "text", text: "人开口" }] });
	await settled(service, source.id, ["user", "assistant", "toolResult", "assistant", "user", "delivery", "assistant"]);
	const words = textOf((await service.getSession(source.id)).messages[5]);
	expect(words).toContain("新会话做完了");
	expect(words).toContain("改好了");
});

/** 两个兄弟会话：甲当场做完，乙在 `wait` 里等 `gate` 打开。`quiet` 时乙不要交回（侧边聊天的卡开的那种）。 */
async function siblings(quiet = false) {
	let gate!: () => void;
	const opened = new Promise<void>((resolve) => (gate = resolve));
	const setup = await withSuggestion(
		(last) => {
			if (last.includes("session-report")) return { text: "收到" };
			if (last.includes("做甲")) return { text: "甲做完了" };
			if (last.includes("做乙")) return { toolCalls: [{ id: "call_wait", name: "wait", args: {} }] };
			if (last.includes("等好了")) return { text: "乙做完了" };
			return { text: "多出来的一问" };
		},
		(ctx) =>
			ctx.tools.register({
				name: "wait",
				description: "等",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					await opened;
					return { output: "等好了" };
				},
			}),
	);
	const launch = (message: string, name: string, reportBack = true) =>
		setup
			.sessions()
			.launch({ cwd: dir, message, spawnedFrom: { sessionId: setup.source.id, toolCallId: "call_1", name, ...(reportBack ? { reportBack } : {}) } });
	const first = await launch("做甲", "jia");
	const second = await launch("做乙", "yi", !quiet);
	return { ...setup, first, second, gate };
}

it("从来处开出来的会话还有在跑的：先不叫醒，最后一个停下后几份合成一次送达", async () => {
	const { service, source, first, second, gate } = await siblings();
	await first.done;
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	expect(await roles(service, source.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	gate();
	await second.done;
	await settled(service, source.id, ["user", "assistant", "toolResult", "assistant", "delivery", "assistant"]);
	expect((await service.getSession(source.id)).messages[4]).toMatchObject({
		delivery: [{ sessionId: first.session.id }, { sessionId: second.session.id }],
	});
	expect((await service.getSession(first.session.id)).summary.spawnedFrom).toEqual({
		sessionId: source.id,
		toolCallId: "call_1",
		name: "jia",
		reportBack: true,
	});
});

it("不交回的兄弟会话还在跑：不等它，先做完的那份当场送", async () => {
	const { service, source, first, second, gate } = await siblings(true);
	await first.done;
	await settled(service, source.id, ["user", "assistant", "toolResult", "assistant", "delivery", "assistant"]);
	expect((await service.getSession(source.id)).messages[4]).toMatchObject({ delivery: [{ sessionId: first.session.id }] });
	gate();
	await second.done;
});

it("兄弟会话跑得久：先做完的那份最多等一分钟，到点还有在跑的也先送，后做完的另送一次", async () => {
	const { service, source, first, second, gate } = await siblings();
	await first.done;
	// 假计时器跟着真时间走，网络和假模型照常；要跳过的只有那一分钟。
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(await roles(service, source.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		await vi.advanceTimersByTimeAsync(60_000);
		await settled(service, source.id, ["user", "assistant", "toolResult", "assistant", "delivery", "assistant"]);
		expect((await service.getSession(source.id)).messages[4]).toMatchObject({ delivery: [{ sessionId: first.session.id }] });
	} finally {
		vi.useRealTimers();
	}
	gate();
	await second.done;
	await settled(service, source.id, ["user", "assistant", "toolResult", "assistant", "delivery", "assistant", "delivery", "assistant"]);
	expect((await service.getSession(source.id)).messages[6]).toMatchObject({ delivery: [{ sessionId: second.session.id }] });
});

it("fork 带着来处在那次调用之前的记录开；没有调用、短名不对时抛错", async () => {
	const { service, sessions, source } = await withSuggestion([{ text: "接着做了" }]);
	const forked = await sessions().launch({ cwd: dir, message: "接着做剩下的", fork: true, spawnedFrom: { sessionId: source.id, toolCallId: "call_1" } });
	await forked.done;
	const messages = (await service.getSession(forked.session.id)).messages;
	expect(messages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
	expect(JSON.stringify(messages[0]?.content)).toContain("看看");
	expect(JSON.stringify(messages[1]?.content)).toContain("接着做剩下的");
	await expect(sessions().launch({ cwd: dir, message: "做", fork: true, spawnedFrom: { sessionId: source.id } })).rejects.toThrow();
	await expect(sessions().launch({ cwd: dir, message: "做", fork: true, spawnedFrom: { sessionId: source.id, toolCallId: "nope" } })).rejects.toThrow();
	await expect(sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: source.id, name: "Bad Name" } })).rejects.toThrow();
});

it("调用 id 要是本插件的工具在那个会话里的一次调用：别的会话、没有的调用抛错；挂在来处下面的子会话里的调用要写明 callIn", async () => {
	const { service, sessions, source } = await withSuggestion((last) =>
		last.includes("侧边看看") ? { toolCalls: [{ id: "call_side", name: "suggest", args: {} }] } : { text: "好了" },
	);
	const side = await sessions().create({ parentId: source.id });
	await sessions().send(side.id, "侧边看看");

	const other = await service.createSession({ cwd: dir });
	const before = service.listSessions().length;
	const launch = (spawnedFrom: SessionLaunch["spawnedFrom"]) => sessions().launch({ cwd: dir, message: "做", spawnedFrom });
	await expect(launch({ sessionId: other.id, toolCallId: "call_1" })).rejects.toThrow("来处不对");
	await expect(launch({ sessionId: source.id, toolCallId: "nope" })).rejects.toThrow("来处不对");
	// 子会话里的调用要写明在哪（`callIn`），不写就按在来处里找。
	await expect(launch({ sessionId: source.id, toolCallId: "call_side" })).rejects.toThrow("来处不对");
	// `callIn` 只能是挂在来处下面的子会话，还得带上调用 id。
	await expect(launch({ sessionId: source.id, toolCallId: "call_1", callIn: other.id })).rejects.toThrow("来处不对");
	await expect(launch({ sessionId: source.id, callIn: side.id })).rejects.toThrow("来处不对");
	await expect(launch({ sessionId: source.id, reportBack: true })).rejects.toThrow("要交回");
	await expect(
		sessions().launch({ cwd: dir, message: "做", fork: true, spawnedFrom: { sessionId: source.id, toolCallId: "call_side", callIn: side.id } }),
	).rejects.toThrow();
	expect(service.listSessions()).toHaveLength(before);
	expect((await service.getSession(other.id)).messages).toEqual([]);

	const fromSide = await launch({ sessionId: source.id, toolCallId: "call_side", callIn: side.id });
	expect(fromSide.session.spawnedFrom).toEqual({ sessionId: source.id, toolCallId: "call_side", callIn: side.id });
	await fromSide.idle;
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	expect(await roles(service, source.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);
});

it("子会话里的调用开出、要交回的会话：每轮交回那个子会话并叫醒它，不交来处；子会话寄去的信引起的那一轮也叫醒它", async () => {
	let launchedId = "";
	const { service, sessions, source } = await withSuggestion(
		(last) => {
			if (last.includes("session-report")) return { text: "收到交回的结果" };
			if (last.includes("侧边看看")) return { toolCalls: [{ id: "call_side", name: "suggest", args: {} }] };
			if (last.includes("交给它")) return { toolCalls: [{ id: "call_relay", name: "relay", args: {} }] };
			if (last.includes("再改一下")) return { text: "改好了" };
			if (last.includes("去做")) return { text: "新会话做完了" };
			return { text: "好了" };
		},
		(ctx) =>
			ctx.tools.register({
				name: "relay",
				description: "转一句",
				parameters: { type: "object", properties: {} },
				execute: async (_args, run: ToolRun) => {
					run.letter?.(launchedId, { from: "侧边", text: "再改一下" });
					return { output: "已寄出" };
				},
			}),
	);
	const side = await sessions().create({ parentId: source.id });
	await sessions().send(side.id, "侧边看看");
	const launched = await sessions().launch({
		cwd: dir,
		message: "去做",
		title: "改标识",
		spawnedFrom: { sessionId: source.id, toolCallId: "call_side", callIn: side.id, reportBack: true },
	});
	launchedId = launched.session.id;
	await settled(service, side.id, ["user", "assistant", "toolResult", "assistant", "delivery", "assistant"]);
	expect((await service.getSession(side.id)).messages[4]).toMatchObject({
		delivery: [{ plugin: "test.launcher", title: "改标识", status: "done", sessionId: launchedId, text: "新会话做完了" }],
	});
	expect(await roles(service, source.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);

	await sessions().send(side.id, "交给它");
	await settled(service, launchedId, ["user", "assistant", "user", "assistant"]);
	await settled(service, side.id, [
		...["user", "assistant", "toolResult", "assistant", "delivery", "assistant"],
		...["user", "assistant", "toolResult", "assistant", "delivery", "assistant"],
	]);
	expect(textOf((await service.getSession(side.id)).messages[10])).toContain("改好了");
	expect(await roles(service, source.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);
}, 20_000);

it("来处那次调用的工具换成了别的插件的：不能拿它当来处", async () => {
	const rival: Plugin = {
		name: "test.rival",
		apply(ctx) {
			ctx.tools.register({ name: "suggest", description: "抢名字", parameters: { type: "object", properties: {} }, execute: async () => ({ output: "好" }) });
		},
	};
	const { sessions, source } = await withSuggestion([{ text: "x" }], () => undefined, [rival]);
	await expect(sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: source.id, toolCallId: "call_1", reportBack: true } })).rejects.toThrow(
		"来处不对",
	);
});

it("不交：没要 reportBack 的只记来处（给了调用 id 也一样）；来处归档了、删了就不送", async () => {
	const { service, sessions, source } = await withSuggestion(() => ({ text: "做完了" }));
	const plain = await sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: source.id } });
	await plain.idle;
	const card = await sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: source.id, toolCallId: "call_1" } });
	await card.idle;
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	expect(await roles(service, source.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	await sessions().setArchived(source.id, true);
	const fromArchived = await sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: source.id, toolCallId: "call_1", reportBack: true } });
	await fromArchived.idle;
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	expect(await roles(service, source.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);

	await service.deleteSession(source.id);
	service.send(fromArchived.session.id, { content: [{ type: "text", text: "接着做" }] });
	await settled(service, fromArchived.session.id, ["user", "assistant", "user", "assistant"]);
});

it("插件的独立会话：不挂在别的会话下、记在插件名下，只有它能发；没有后台结果、寄信、归档，下面不再挂子会话", async () => {
	const runs: ToolRun[] = [];
	let letterTo: string | undefined;
	let letterError = "";
	const { service, sessions } = await open(
		[
			{ toolCalls: [{ id: "call_probe", name: "probe", args: {} }] },
			{ text: "看过了" },
			{ toolCalls: [{ id: "call_probe2", name: "probe", args: {} }] },
			{ text: "也看过了" },
		],
		(ctx) =>
			ctx.tools.register({
				name: "probe",
				description: "留下这次调用",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					runs.push(run);
					if (letterTo)
						try {
							run.letter?.(letterTo, { from: "顶层", text: "你好" });
						} catch (error) {
							letterError = String(error);
						}
					return { output: "好" };
				},
			}),
	);
	const standalone = await sessions().create({ cwd: dir, title: "  运维  助手 " });
	expect(standalone).toMatchObject({ cwd: dir, title: "运维 助手", owner: "test.launcher" });
	expect(standalone.parentId).toBeUndefined();

	expect(await sessions().send(standalone.id, "看一眼")).toEqual({ reason: "done" });
	expect([runs[0]?.background, runs[0]?.letter, runs[0]?.archiveAfterTurn, runs[0]?.parent]).toEqual([undefined, undefined, undefined, undefined]);
	expect((await service.getSession(standalone.id)).messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

	// 界面不能在里面发，不能归档，不能挂子会话，不能当后台运行跑；顶层会话的信也寄不到它。
	expect(() => service.send(standalone.id, { content: [{ type: "text", text: "人插一句" }] })).toThrow("test.launcher");
	await expect(sessions().setArchived(standalone.id, true)).rejects.toThrow("不能归档");
	await expect(sessions().create({ parentId: standalone.id })).rejects.toThrow("下面不能再建子会话");
	await expect(sessions().start(standalone.id, "后台跑")).rejects.toThrow("这不是子会话");
	const top = await service.createSession({ cwd: dir });
	letterTo = standalone.id;
	service.send(top.id, { content: [{ type: "text", text: "开始" }] });
	await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 5_000, interval: 10 });
	expect(letterError).toContain(standalone.id);
	// 调用答完以后，留着的寄信句柄不能再用。
	expect(() => runs[1]?.letter?.(top.id, { from: "顶层", text: "你好" })).toThrow("已经结束");

	// 子会话的目录随父会话，不能另给；独立会话的目录要是已有的。
	await expect(sessions().create({ parentId: top.id, cwd: dir })).rejects.toThrow("随父会话");
	await expect(sessions().create({ cwd: "relative/dir" })).rejects.toThrow("relative/dir");

	await sessions().delete(standalone.id);
	expect(service.listSessions().map((summary) => summary.id)).not.toContain(standalone.id);
});

it("插件改自己会话的模型、思考档位和目录：下一轮生效、记录不丢；有一项不对就都不改；子会话不能换目录，别人的会话改不了", async () => {
	const ended: Array<[string, string]> = [];
	const { service, sessions, providerId } = await open([{ text: "一" }, { text: "二" }], (ctx) =>
		ctx.sessions.onEnded((sessionId, reason) => void ended.push([sessionId, reason])),
	);
	const standalone = await sessions().create({ title: "助理" });
	const chats = standalone.cwd;
	expect(await sessions().send(standalone.id, "在吗")).toEqual({ reason: "done" });

	const changed = await sessions().configure(standalone.id, { model: `${providerId}/other`, thinking: "off", cwd: dir });
	expect(changed).toMatchObject({ model: `${providerId}/other`, thinking: "off", cwd: dir });
	expect(ended).toEqual([[standalone.id, "moved"]]);
	expect(await sessions().send(standalone.id, "换了吗")).toEqual({ reason: "done" });
	expect(model?.requests.at(-1)?.model).toBe("other");
	expect((await service.getSession(standalone.id)).messages.filter((message) => message.role === "user")).toHaveLength(2);

	// 模型不认识：目录也不换。
	await expect(sessions().configure(standalone.id, { model: `${providerId}/missing`, cwd: null })).rejects.toThrow("missing");
	expect((await sessions().get(standalone.id))?.cwd).toBe(dir);

	// null 回到默认：模型跟默认、目录回聊天目录。
	const reset = await sessions().configure(standalone.id, { model: null, cwd: null });
	expect(reset.model).toBeUndefined();
	expect(reset.cwd).toBe(chats);

	const top = await service.createSession({ cwd: dir });
	const child = await sessions().create({ parentId: top.id });
	await expect(sessions().configure(child.id, { cwd: dir })).rejects.toThrow("随父会话");
	expect(await sessions().configure(child.id, { model: `${providerId}/other` })).toMatchObject({ model: `${providerId}/other` });
	await expect(sessions().configure(top.id, { model: null })).rejects.toThrow("test.launcher");
});
