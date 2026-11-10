import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BackgroundChannel, ChannelDelivery, Message, Plugin, PluginContext, SessionAccess, SessionRun } from "@plume/contract";
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

async function open(replies: FakeReply[], configure: (ctx: PluginContext) => void = () => undefined) {
	dir = await mkdtemp(join(tmpdir(), "plume-background-"));
	model = await fakeAnthropic(replies);
	let owner!: SessionAccess;
	let other!: SessionAccess;
	const plugins: Plugin[] = [
		{
			name: "test.owner",
			apply(ctx) {
				owner = ctx.sessions;
				configure(ctx);
			},
		},
		{
			name: "test.other",
			apply(ctx) {
				other = ctx.sessions;
			},
		},
	];
	agent = await createAgent({
		dataDir: dir,
		settingsFile: join(dir, "settings.json"),
		plugins: plugins.map((plugin) => ({ key: plugin.name, load: async () => plugin })),
		log: () => undefined,
	});
	const service = agent.service;
	const provider = await service.saveProvider({
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
	const parent = await service.createSession({ cwd: dir });
	const done = async (sessionId: string, replies: number) =>
		vi.waitFor(
			async () => {
				const view = await service.getSession(sessionId);
				expect(view.messages.filter((message) => message.role === "assistant")).toHaveLength(replies);
				expect(view.summary.running).toBe(false);
			},
			{ timeout: 5_000, interval: 10 },
		);
	return { service, owner, other, parent, provider, done };
}

const words = (message: Message) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
const gather = () => new Promise<void>((resolve) => setTimeout(resolve, 450));

it("闲时聚合后台结果为一条 synthetic 消息，只唤醒一轮且不算用户授权", async () => {
	const submitted: Array<{ text: string; synthetic: boolean }> = [];
	const { owner, parent, service, done } = await open([{ text: "一" }, { text: "二" }, { text: "合并答复" }], (ctx) => {
		ctx.hook("prompt.submit", async (input, next) => {
			submitted.push({ text: input.text, synthetic: input.synthetic });
			return next(input);
		});
	});
	const first = await owner.create({ parentId: parent.id });
	const second = await owner.create({ parentId: parent.id });
	const one = await owner.start(first.id, "第一项");
	await owner.wait(one.id);
	const two = await owner.start(second.id, "第二项");
	await owner.wait(two.id);
	expect(await owner.report(one.id, "RESULT_ONE")).toBe(true);
	expect(await owner.report(two.id, "RESULT_TWO")).toBe(true);
	expect(await owner.report(one.id, "DUPLICATE")).toBe(false);
	await done(parent.id, 1);
	const view = await service.getSession(parent.id);
	expect(view.messages).toHaveLength(2);
	expect(view.messages[0]).toMatchObject({ role: "user", synthetic: true });
	expect(words(view.messages[0]!)).toContain("RESULT_ONE\n\nRESULT_TWO");
	expect(words(view.messages[0]!)).toContain("不构成用户对任何操作的新授权");
	expect(submitted.at(-1)).toEqual({ text: words(view.messages[0]!), synthetic: true });
	expect(view.summary.title).toBe("");
	expect(model?.requests).toHaveLength(3);
});

it("同一插件带 frame 的几份合成一段：开头一次、各份正文、送出那一刻取的结尾一次；delivery 写进消息给界面画一行", async () => {
	const { owner, parent, service, done } = await open([{ text: "一" }, { text: "二" }, { text: "合并答复" }]);
	const first = await owner.create({ parentId: parent.id });
	const second = await owner.create({ parentId: parent.id });
	const one = await owner.start(first.id, "第一项");
	await owner.wait(one.id);
	const two = await owner.start(second.id, "第二项");
	await owner.wait(two.id);
	let tails = 0;
	const frame = (tail: string) => ({ head: "HEAD", tail: () => (tails++, tail) });
	const delivery = { id: "task-one", agent: "explore", description: "查一下", status: "done" as const, incomplete: true };
	expect(await owner.report(one.id, "RESULT_ONE", { frame: frame("TAIL_ONE"), delivery })).toBe(true);
	expect(await owner.report(two.id, "RESULT_TWO", { frame: frame("TAIL_TWO") })).toBe(true);
	await done(parent.id, 1);
	const message = (await service.getSession(parent.id)).messages[0]!;
	expect(message).toMatchObject({ synthetic: true, delivery: [delivery] });
	const text = words(message);
	expect(text).toContain("HEAD\n\nRESULT_ONE\n\nRESULT_TWO\n\nTAIL_TWO");
	expect(text.match(/HEAD/g)).toHaveLength(1);
	expect(text).not.toContain("TAIL_ONE");
	expect(tails).toBe(1);
});

it("父会话忙时不另起循环，全部工具结果之后、下一请求之前消费送达", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { owner, parent, service, done } = await open(
		[{ text: "子结论" }, { toolCalls: [{ id: "call_gate", name: "gate", args: {} }] }, { text: "收到后台结果" }],
		(ctx) =>
			ctx.tools.register({
				name: "gate",
				description: "等待",
				parameters: { type: "object", properties: {} },
				async execute() {
					entered.resolve();
					await release.promise;
					return { output: "完整工具结果" };
				},
			}),
	);
	const child = await owner.create({ parentId: parent.id });
	const run = await owner.start(child.id, "查一下");
	await owner.wait(run.id);
	service.send(parent.id, { content: [{ type: "text", text: "父任务" }] });
	await entered.promise;
	try {
		expect(await owner.report(run.id, "BACKGROUND_RESULT")).toBe(true);
		await gather();
		expect(model?.requests).toHaveLength(2);
		expect((await service.getSession(parent.id)).messages.some((message) => message.role === "user" && message.synthetic)).toBe(false);
	} finally {
		release.resolve();
	}
	await done(parent.id, 2);
	const messages = (await service.getSession(parent.id)).messages;
	expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
	expect(words(messages[2]!)).toContain("完整工具结果");
	expect(messages[3]).toMatchObject({ synthetic: true });
	expect(JSON.stringify(model?.requests[2]?.messages)).toContain("BACKGROUND_RESULT");
});

it("父轮正常完成不取消后台，子结果随后仍可唤醒真实父会话", async () => {
	const release = Promise.withResolvers<void>();
	let dispatched!: SessionRun;
	const { owner, parent, service, done } = await open(
		[{ toolCalls: [{ id: "call_dispatch", name: "dispatch", args: {} }] }, { text: "等待子任务" }, { text: "子任务完成" }, { text: "最终合并" }],
		(ctx) => {
			ctx.hook("prompt.submit", async (input, next) => {
				if (input.text === "CHILD_TASK") await release.promise;
				return next(input);
			});
			ctx.tools.register({
				name: "dispatch",
				description: "后台派发",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					const child = await ctx.sessions.create({ parentId: run.sessionId });
					dispatched = await ctx.sessions.start(child.id, "CHILD_TASK");
					return { output: "已派发" };
				},
			});
		},
	);
	service.send(parent.id, { content: [{ type: "text", text: "开始" }] });
	try {
		await done(parent.id, 2);
		expect((await service.getSession(dispatched.sessionId)).summary.running).toBe(true);
	} finally {
		release.resolve();
	}
	expect(await owner.wait(dispatched.id)).toEqual({ reason: "done" });
	expect(await owner.report(dispatched.id, "CHILD_RESULT")).toBe(true);
	await done(parent.id, 3);
	expect(JSON.stringify((await service.getSession(parent.id)).messages)).toContain("CHILD_RESULT");
});

it("摘要的 background：派出去就立起，父轮收尾、送达开轮之间都不落下，送达那一轮做完才落", async () => {
	const release = Promise.withResolvers<void>();
	let dispatched!: SessionRun;
	const { owner, parent, service, done } = await open(
		[{ toolCalls: [{ id: "call_dispatch", name: "dispatch", args: {} }] }, { text: "等待子任务" }, { text: "子任务完成" }, { text: "最终合并" }],
		(ctx) => {
			ctx.hook("prompt.submit", async (input, next) => {
				if (input.text === "CHILD_TASK") await release.promise;
				return next(input);
			});
			ctx.tools.register({
				name: "dispatch",
				description: "后台派发",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					const child = await ctx.sessions.create({ parentId: run.sessionId });
					dispatched = await ctx.sessions.start(child.id, "CHILD_TASK");
					return { output: "已派发" };
				},
			});
		},
	);
	const states: Array<{ running: boolean; background: boolean }> = [];
	const watching = new AbortController();
	void (async () => {
		for await (const event of service.watch({ signal: watching.signal })) {
			if (event.type !== "sessions") continue;
			const summary = event.sessions.find((session) => session.id === parent.id);
			if (summary) states.push({ running: summary.running, background: summary.background === true });
		}
	})();
	try {
		service.send(parent.id, { content: [{ type: "text", text: "开始" }] });
		try {
			await done(parent.id, 2);
			expect((await service.getSession(parent.id)).summary).toMatchObject({ running: false, background: true });
		} finally {
			release.resolve();
		}
		await owner.wait(dispatched.id);
		expect(await owner.report(dispatched.id, "CHILD_RESULT")).toBe(true);
		await done(parent.id, 3);
		await vi.waitFor(async () => expect((await service.getSession(parent.id)).summary.background).toBeUndefined(), { timeout: 2_000, interval: 10 });
	} finally {
		watching.abort();
	}
	// 从派出去到最后：中间没有一刻既不在跑、也不在等后台——交付卡片不会先挂出来再收掉。
	const from = states.findIndex((state) => state.background);
	expect(from).toBeGreaterThanOrEqual(0);
	const settled = states.slice(from).findIndex((state) => !state.running && !state.background);
	expect(settled).toBe(states.length - from - 1);
});

it("同子会话续跑用新 runId，旧运行的结束原因和送达不读取最新 stop", async () => {
	const entered = Promise.withResolvers<void>();
	const { owner, other, parent, service, done } = await open([{ text: "第一轮完成" }, { text: "父结论" }], (ctx) => {
		ctx.hook("prompt.submit", async (input, next) => {
			if (input.text === "HOLD") {
				entered.resolve();
				await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
			}
			return next(input);
		});
	});
	const child = await owner.create({ parentId: parent.id });
	const old = await owner.start(child.id, "第一轮");
	await owner.wait(old.id);
	const current = await owner.start(child.id, "HOLD");
	await entered.promise;
	expect(current.id).not.toBe(old.id);
	await expect(other.start(child.id, "越权")).rejects.toThrow("test.other");
	await expect(other.wait(old.id)).rejects.toThrow("test.other");
	await expect(other.report(old.id, "越权")).rejects.toThrow("test.other");
	await expect(owner.report("unknown", "不存在")).rejects.toThrow("unknown");
	expect(await owner.report(current.id, "未结束")).toBe(false);
	expect(await owner.report(old.id, "OLD_RESULT")).toBe(true);
	await done(parent.id, 1);
	owner.stop(child.id);
	expect(await owner.wait(current.id)).toEqual({ reason: "aborted" });
	expect(await owner.wait(old.id)).toEqual({ reason: "done" });
	expect((await service.getSession(child.id)).summary.stop).toEqual({ reason: "aborted" });
});

it("闲时主动父 stop 也通知排队插件，取消后台和已报告结果，随后不能自行唤醒", async () => {
	const stopped: string[] = [];
	const { owner, parent, service } = await open([{ text: "已完成" }], (ctx) => {
		ctx.sessions.onStopped((id) => stopped.push(id));
		ctx.hook("prompt.submit", async (input, next) => {
			if (input.text === "HOLD") await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
			return next(input);
		});
	});
	const first = await owner.create({ parentId: parent.id });
	const second = await owner.create({ parentId: parent.id });
	const done = await owner.start(first.id, "已完成");
	await owner.wait(done.id);
	const running = await owner.start(second.id, "HOLD");
	expect(await owner.report(done.id, "不能唤醒")).toBe(true);
	service.stop(parent.id);
	expect(stopped).toContain(parent.id);
	expect(await owner.wait(running.id)).toEqual({ reason: "aborted" });
	expect(await owner.report(running.id, "停止后")).toBe(false);
	await expect(owner.start(second.id, "竞态派发")).rejects.toThrow("父会话已停止");
	await gather();
	expect((await service.getSession(parent.id)).messages).toEqual([]);
	expect(model?.requests).toHaveLength(1);
});

it("停止父任务不终止独立 send 的侧边聊天，也不阻止下一次侧聊提问", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { owner, parent, service } = await open([{ text: "侧聊完成" }, { text: "侧聊再答" }], (ctx) => {
		ctx.hook("prompt.submit", async (input, next) => {
			if (input.text === "SIDE") {
				entered.resolve();
				await release.promise;
			}
			return next(input);
		});
	});
	const side = await owner.create({ parentId: parent.id });
	const turn = owner.send(side.id, "SIDE");
	await entered.promise;
	try {
		service.stop(parent.id);
		expect((await service.getSession(side.id)).summary.running).toBe(true);
	} finally {
		release.resolve();
	}
	expect(await turn).toEqual({ reason: "done" });
	expect(await owner.send(side.id, "再问一句")).toEqual({ reason: "done" });
});

it("单个子会话停止不影响兄弟，父删除撤销全部待送达", async () => {
	const { owner, parent, service } = await open([{ text: "不会用到" }], (ctx) => {
		ctx.hook("prompt.submit", async (input, next) => {
			if (input.text === "HOLD") await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
			return next(input);
		});
	});
	const one = await owner.create({ parentId: parent.id });
	const two = await owner.create({ parentId: parent.id });
	const first = await owner.start(one.id, "HOLD");
	const second = await owner.start(two.id, "HOLD");
	owner.stop(one.id);
	expect(await owner.wait(first.id)).toEqual({ reason: "aborted" });
	expect((await service.getSession(two.id)).summary.running).toBe(true);
	await service.deleteSession(parent.id);
	expect(await owner.wait(second.id)).toEqual({ reason: "aborted" });
	expect(await owner.report(second.id, "父已删除")).toBe(false);
	expect(service.listSessions()).toEqual([]);
});

it("插话不打断工具，经过 prompt.submit 并保留附件、显示文本和 parent origin", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const seen: string[] = [];
	const { owner, other, parent, service } = await open([{ toolCalls: [{ id: "call_gate", name: "gate", args: {} }] }, { text: "插话后完成" }], (ctx) => {
		ctx.hook("prompt.submit", async (input, next) => {
			seen.push(input.text);
			if (input.text === "插话【文件 1】") return { block: false, context: "STEER_CONTEXT" };
			return next(input);
		});
		ctx.tools.register({
			name: "gate",
			description: "等待",
			parameters: { type: "object", properties: {} },
			async execute() {
				entered.resolve();
				await release.promise;
				return { output: "完整结果" };
			},
		});
	});
	const child = await owner.create({ parentId: parent.id });
	const attachment = { name: "note.txt", path: join(dir, "note.txt"), kind: "file" };
	const running = owner.send(child.id, { content: [{ type: "text", text: "初始任务" }], attachments: [attachment], origin: "parent" });
	await entered.promise;
	try {
		await expect(other.steer(child.id, "越权插话")).rejects.toThrow("test.other");
		await owner.steer(child.id, {
			content: [{ type: "text", text: "STEERING_TEXT" }],
			displayText: "插话【文件 1】",
			attachments: [attachment],
			origin: "parent",
		});
		expect((await service.getSession(child.id)).messages).toHaveLength(2);
		expect(seen).toEqual(["初始任务"]);
	} finally {
		release.resolve();
	}
	expect(await running).toEqual({ reason: "done" });
	const messages = (await service.getSession(child.id)).messages;
	expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user", "user", "assistant"]);
	expect(messages[0]).toMatchObject({ origin: "parent", attachments: [attachment] });
	expect(messages[3]).toMatchObject({ origin: "parent", displayText: "插话【文件 1】", attachments: [attachment] });
	expect(messages[4]).toMatchObject({ synthetic: true });
	expect(JSON.stringify(model?.requests[1]?.messages)).toContain("STEERING_TEXT");
	expect(JSON.stringify(model?.requests[1]?.messages)).toContain("STEER_CONTEXT");
	await expect(owner.steer(child.id, "空闲插话")).rejects.toThrow("没有正在运行");
});

it("卸载先取消并等子会话工具层收尾，再撤工具和钩子；旧 ctx 不能再派发", async () => {
	const entered = Promise.withResolvers<void>();
	const finishing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { owner, parent } = await open([{ toolCalls: [{ id: "call_gate", name: "gate", args: {} }] }], (ctx) => {
		ctx.hook("tool.execute", async (input, next) => {
			const result = await next(input);
			finishing.resolve();
			await release.promise;
			return result;
		});
		ctx.tools.register({
			name: "gate",
			description: "等停止",
			parameters: { type: "object", properties: {} },
			async execute(_args, run) {
				entered.resolve();
				await new Promise<void>((resolve) => run.signal.addEventListener("abort", () => resolve(), { once: true }));
				return { output: "已收尾" };
			},
		});
	});
	const child = await owner.create({ parentId: parent.id });
	const run = await owner.start(child.id, "开始");
	await entered.promise;
	let removed = false;
	const removing = agent!.removePlugin("test.owner").then(() => {
		removed = true;
	});
	try {
		await finishing.promise;
		expect(removed).toBe(false);
		expect(agent!.host.tool("gate")).toBeDefined();
		await expect(owner.start(child.id, "卸载中不能派发")).rejects.toThrow("已停用");
	} finally {
		release.resolve();
	}
	await removing;
	expect(await owner.wait(run.id)).toEqual({ reason: "aborted" });
	expect(await owner.report(run.id, "不能唤醒")).toBe(false);
	expect(agent!.host.tool("gate")).toBeUndefined();
	await expect(owner.send(child.id, "旧 ctx")).rejects.toThrow("已停用");
});

it("最后一步等待期间到达的结果仍在原轮消费，不被自然结束丢掉", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let parentId = "";
	let held = false;
	const { owner, parent, service, done } = await open([{ text: "子完成" }, { text: "父原本结束" }, { text: "读结果后完成" }], (ctx) => {
		ctx.hook("step.end", async (input, next) => {
			if (input.sessionId === parentId && !held) {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return next(input);
		});
	});
	parentId = parent.id;
	const child = await owner.create({ parentId });
	const run = await owner.start(child.id, "子任务");
	await owner.wait(run.id);
	service.send(parentId, { content: [{ type: "text", text: "父任务" }] });
	await entered.promise;
	try {
		await owner.report(run.id, "LATE_RESULT");
		await gather();
	} finally {
		release.resolve();
	}
	await done(parentId, 2);
	expect((await service.getSession(parentId)).messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
	expect(JSON.stringify(model?.requests[2]?.messages)).toContain("LATE_RESULT");
});

it("送达已取出但 prompt.submit 尚未放行时停止，不能写入或再唤醒", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { owner, parent, service } = await open([{ text: "子完成" }], (ctx) => {
		ctx.hook("prompt.submit", async (input, next) => {
			if (input.synthetic) {
				entered.resolve();
				await release.promise;
			}
			return next(input);
		});
	});
	const child = await owner.create({ parentId: parent.id });
	const run = await owner.start(child.id, "子任务");
	await owner.wait(run.id);
	await owner.report(run.id, "TAKEN_RESULT");
	await entered.promise;
	try {
		service.stop(parent.id);
	} finally {
		release.resolve();
	}
	await vi.waitFor(async () => expect((await service.getSession(parent.id)).summary.running).toBe(false));
	expect((await service.getSession(parent.id)).messages).toEqual([]);
	expect(model?.requests).toHaveLength(1);
	expect(await owner.report(run.id, "再次尝试")).toBe(false);
});

it("一批送达在钩子等待期间撤回其中一个，只给剩余结果重新生成 context", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const seen: string[] = [];
	const { owner, other, parent, service, done } = await open([{ text: "一" }, { text: "二" }, { text: "父完成" }], (ctx) => {
		ctx.hook("prompt.submit", async (input, next) => {
			if (!input.synthetic) return next(input);
			seen.push(input.text);
			if (seen.length === 1) {
				entered.resolve();
				await release.promise;
			}
			return { block: false, context: `CONTEXT:${input.text}` };
		});
	});
	const one = await owner.create({ parentId: parent.id });
	const two = await other.create({ parentId: parent.id });
	const first = await owner.start(one.id, "一");
	await owner.wait(first.id);
	const second = await other.start(two.id, "二");
	await other.wait(second.id);
	await owner.report(first.id, "CANCELLED_ONE");
	await other.report(second.id, "KEPT_TWO");
	await entered.promise;
	try {
		owner.stop(one.id);
	} finally {
		release.resolve();
	}
	await done(parent.id, 1);
	expect(seen).toHaveLength(2);
	expect(seen[0]).toContain("CANCELLED_ONE\n\nKEPT_TWO");
	expect(seen[1]).toContain("KEPT_TWO");
	expect(seen[1]).not.toContain("CANCELLED_ONE");
	expect(JSON.stringify((await service.getSession(parent.id)).messages)).not.toContain("CANCELLED_ONE");
	expect(JSON.stringify(model?.requests[2]?.messages)).toContain(`CONTEXT:${seen[1]}`.replaceAll("\n", "\\n"));
});

it("退出取消后台并等待收尾，运行以 interrupted 结束且不再报告", async () => {
	const { owner, parent } = await open([{ text: "不应调用" }], (ctx) => {
		ctx.hook("prompt.submit", async (input, next) => {
			await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
			return next(input);
		});
	});
	const child = await owner.create({ parentId: parent.id });
	const run = await owner.start(child.id, "后台任务");
	await agent!.shutdown();
	agent = undefined;
	expect(await owner.wait(run.id)).toEqual({ reason: "interrupted" });
	expect(await owner.report(run.id, "退出后")).toBe(false);
	expect(model?.requests).toHaveLength(0);
});

it("start 调用与同一步父 stop 竞态时，不提交任务、不调模型", async () => {
	const { owner, parent, service } = await open([{ text: "不应调用" }]);
	const child = await owner.create({ parentId: parent.id });
	const starting = owner.start(child.id, "竞态任务");
	service.stop(parent.id);
	const run = await starting;
	expect(await owner.wait(run.id)).toEqual({ reason: "aborted" });
	expect(await owner.report(run.id, "不能唤醒")).toBe(false);
	expect((await service.getSession(child.id)).messages).toEqual([]);
	expect(model?.requests).toHaveLength(0);
});

it("热加载撤掉停止监听和待送达，重新加载后旧 ctx 仍不能派发", async () => {
	const accesses: SessionAccess[] = [];
	const stopped: string[] = [];
	const { owner, parent, service, done } = await open([{ text: "子完成" }, { text: "重载后完成" }], (ctx) => {
		accesses.push(ctx.sessions);
		ctx.sessions.onStopped((id) => stopped.push(id));
	});
	const child = await owner.create({ parentId: parent.id });
	const run = await owner.start(child.id, "子任务");
	await owner.wait(run.id);
	await owner.report(run.id, "卸载应丢弃");
	await service.setPluginEnabled("test.owner", false);
	stopped.length = 0;
	service.stop(parent.id);
	expect(stopped).toEqual([]);
	await service.setPluginEnabled("test.owner", true);
	expect(accesses).toHaveLength(2);
	await expect(owner.start(child.id, "旧 ctx")).rejects.toThrow("已停用");
	// 用户继续后，新加载实例才能派发；停止前的那份送达仍被撤销。
	service.send(parent.id, { content: [{ type: "text", text: "继续" }] });
	await done(parent.id, 1);
	const next = await accesses[1]!.start(child.id, "新 ctx");
	expect(await accesses[1]!.wait(next.id)).toEqual({ reason: "done" });
	await gather();
	expect(JSON.stringify((await service.getSession(parent.id)).messages)).not.toContain("卸载应丢弃");
});

it("后台运行首次继承模型后固定，续跑不随父模型变动或失效后偷偷换模型", async () => {
	const { owner, parent, provider, service } = await open([{ text: "第一次" }, { text: "续跑" }]);
	await service.setSessionModel(parent.id, `${provider}/fake`);
	const child = await owner.create({ parentId: parent.id });
	const first = await owner.start(child.id, "任务");
	await owner.wait(first.id);
	await service.setSessionModel(parent.id, `${provider}/other`);
	const second = await owner.start(child.id, "接着做");
	await owner.wait(second.id);
	expect(model?.requests.map((request) => request.model)).toEqual(["fake", "fake"]);
	await service.deleteProvider(provider);
	const third = await owner.start(child.id, "再续跑");
	expect(await owner.wait(third.id)).toMatchObject({ reason: "error" });
	expect(model?.requests).toHaveLength(2);
});

it("模型目录不带凭据，显式子模型经过校验并保存；未指定仍随父选项", async () => {
	const { owner, parent, provider, service } = await open([{ text: "显式模型" }, { text: "跟父模型" }]);
	const models = await owner.models();
	expect(models.map((model) => model.id)).toEqual([`${provider}/fake`, `${provider}/other`]);
	expect(models[0]).toEqual({ id: `${provider}/fake`, name: "fake", contextWindow: 200_000, thinking: [] });
	expect(JSON.stringify(models)).not.toContain("private-test-key");
	await expect(owner.create({ parentId: parent.id, model: "missing/model" })).rejects.toThrow("没有可用的模型");
	await expect(owner.create({ parentId: parent.id, thinking: "invalid" as never })).rejects.toThrow("思考档位");
	const explicit = await owner.create({ parentId: parent.id, model: `${provider}/other`, thinking: "high" });
	const inherited = await owner.create({ parentId: parent.id });
	await service.setSessionModel(parent.id, `${provider}/fake`);
	expect((await service.getSession(explicit.id)).summary).toMatchObject({ model: `${provider}/other`, thinking: "high" });
	expect(inherited.model).toBeUndefined();
	expect(inherited.thinking).toBeUndefined();
	await owner.send(explicit.id, "显式");
	await owner.send(inherited.id, "继承");
	expect(model?.requests.map((request) => request.model)).toEqual(["other", "fake"]);
});

/** 工具 `keep` 把这次调用拿到的后台渠道交出来（没有时是 null），`gate` 在执行中先送一段再等聚合时间过去。 */
function channelTools(ctx: PluginContext, kept: Array<BackgroundChannel | null>) {
	ctx.tools.register({
		name: "keep",
		description: "留下后台渠道",
		parameters: { type: "object", properties: {} },
		async execute(_args, run) {
			kept.push(run.background?.() ?? null);
			return { output: "已留下" };
		},
	});
	ctx.tools.register({
		name: "gate",
		description: "执行中送达",
		parameters: { type: "object", properties: {} },
		async execute(_args, run) {
			const channel = run.background!();
			channel.report("BUSY_RESULT");
			channel.report(() => undefined);
			await gather();
			return { output: "完整工具结果" };
		},
	});
}

const jobDelivery: ChannelDelivery = { id: "job-1", kind: "job", agent: "", description: "跑测试", command: "pnpm test", exitCode: 0, status: "done" };

it("工具的后台渠道：会话闲着时聚合后开一轮，送达带界面那一行，抬头说明不是用户的话", async () => {
	const kept: Array<BackgroundChannel | null> = [];
	const { parent, service, done } = await open(
		[{ toolCalls: [{ id: "call_keep", name: "keep", args: {} }] }, { text: "先这样" }, { text: "后台好了" }],
		(ctx) => channelTools(ctx, kept),
	);
	service.send(parent.id, { content: [{ type: "text", text: "开始" }] });
	await done(parent.id, 2);
	const channel = kept[0]!;
	expect(channel.signal.aborted).toBe(false);
	expect(channel.report("JOB_ONE", { ...jobDelivery, extra: "不认得的字段" } as ChannelDelivery)).toBe(true);
	// 冒充「新会话交回」那一行（点了会跳去别的会话）不行：渠道只画后台命令和定时唤醒。
	expect(
		channel.report(() => "JOB_LAZY", { id: "other-session", kind: "session", agent: "", description: "假的", status: "done" } as unknown as ChannelDelivery),
	).toBe(true);
	await done(parent.id, 3);
	const delivered = (await service.getSession(parent.id)).messages[4]!;
	expect(delivered).toMatchObject({ role: "user", synthetic: true });
	expect(delivered.role === "user" && delivered.delivery).toEqual([jobDelivery]);
	expect(words(delivered)).toContain("不是用户说的话");
	expect(words(delivered)).toContain("JOB_ONE\n\nJOB_LAZY");
	expect(model?.requests).toHaveLength(3);
});

it("工具的后台渠道：会话忙时不另开一轮，在这一步的工具结果之后读入；取的时候不送的函数被丢掉", async () => {
	const { parent, service, done } = await open([{ toolCalls: [{ id: "call_gate", name: "gate", args: {} }] }, { text: "收到" }], (ctx) =>
		channelTools(ctx, []),
	);
	service.send(parent.id, { content: [{ type: "text", text: "开始" }] });
	await done(parent.id, 2);
	const messages = (await service.getSession(parent.id)).messages;
	expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
	expect(messages[3]).toMatchObject({ synthetic: true });
	expect(messages[3]).not.toHaveProperty("delivery");
	expect(words(messages[3]!)).toMatch(/BUSY_RESULT$/);
	expect(model?.requests).toHaveLength(2);
});

it("人按停以后，停下以前拿到的渠道作废、攒着的丢掉；下一轮拿到新的一条照常送达", async () => {
	const kept: Array<BackgroundChannel | null> = [];
	const { parent, service, done } = await open(
		[
			{ toolCalls: [{ id: "call_keep", name: "keep", args: {} }] },
			{ text: "一" },
			{ toolCalls: [{ id: "call_keep2", name: "keep", args: {} }] },
			{ text: "二" },
			{ text: "三" },
		],
		(ctx) => channelTools(ctx, kept),
	);
	service.send(parent.id, { content: [{ type: "text", text: "开始" }] });
	await done(parent.id, 2);
	const old = kept[0]!;
	expect(old.report("BEFORE_STOP")).toBe(true);
	service.stop(parent.id);
	expect(old.signal.aborted).toBe(true);
	expect(old.report("AFTER_STOP")).toBe(false);
	await gather();
	expect((await service.getSession(parent.id)).messages).toHaveLength(4);

	service.send(parent.id, { content: [{ type: "text", text: "再来" }] });
	await done(parent.id, 4);
	const fresh = kept[1]!;
	expect(fresh).not.toBe(old);
	expect(fresh.signal.aborted).toBe(false);
	expect(fresh.report("AFTER_RESTART")).toBe(true);
	await done(parent.id, 5);
	const text = JSON.stringify((await service.getSession(parent.id)).messages);
	expect(text).toContain("AFTER_RESTART");
	expect(text).not.toContain("BEFORE_STOP");
});

it("撤回只作废截掉那段里的调用拿到的渠道；留下那段里拿到的照常送达", async () => {
	const kept: Array<BackgroundChannel | null> = [];
	const { parent, service, done } = await open(
		[
			{ toolCalls: [{ id: "call_keep", name: "keep", args: {} }] },
			{ text: "一" },
			{ toolCalls: [{ id: "call_keep2", name: "keep", args: {} }] },
			{ text: "二" },
			{ text: "三" },
		],
		(ctx) => channelTools(ctx, kept),
	);
	service.send(parent.id, { content: [{ type: "text", text: "开始" }] });
	await done(parent.id, 2);
	service.send(parent.id, { content: [{ type: "text", text: "再来" }] });
	await done(parent.id, 4);
	const [kept1, cut] = kept as BackgroundChannel[];
	expect(cut!.report("CUT_PENDING")).toBe(true);
	await service.revertMessage(parent.id, 4);
	expect(cut!.signal.aborted).toBe(true);
	expect(cut!.report("CUT_AFTER")).toBe(false);
	expect(kept1!.signal.aborted).toBe(false);
	expect(kept1!.report("KEPT_AFTER")).toBe(true);
	await done(parent.id, 3);
	const text = JSON.stringify((await service.getSession(parent.id)).messages);
	expect(text).toContain("KEPT_AFTER");
	expect(text).not.toContain("CUT_");
});

it("插件的子会话里工具拿不到后台渠道", async () => {
	const kept: Array<BackgroundChannel | null> = [];
	const { owner, parent } = await open([{ toolCalls: [{ id: "call_keep", name: "keep", args: {} }] }, { text: "子完成" }], (ctx) => channelTools(ctx, kept));
	const child = await owner.create({ parentId: parent.id });
	expect(await owner.send(child.id, "子任务")).toEqual({ reason: "done" });
	expect(kept).toEqual([null]);
});
