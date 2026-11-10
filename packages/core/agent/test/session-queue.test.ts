import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Message, ParentSession, ParentStatus, Plugin, PluginContext, SessionAccess } from "@plume/contract";
import { createAgent, type Agent } from "../src/agent.ts";
import { fakeAnthropic, type FakeModel, type FakeReply } from "../src/testing.ts";

let dir: string | undefined;
let agent: Agent | undefined;
let model: FakeModel | undefined;

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	agent = undefined;
	model = undefined;
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

type Route = (conversation: string, replies: number) => FakeReply;

/** 请求里最后一句带字的用户消息（认出是哪一轮）和它之后已经有几条回复（这一轮的第几步）。 */
function routed(route: Route) {
	return (request: Record<string, unknown>): FakeReply => {
		const messages = request.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
		const text = (content: (typeof messages)[number]["content"]) =>
			typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
		const at = messages.findLastIndex((message) => message.role === "user" && text(message.content));
		const replies = messages.slice(at + 1).filter((message) => message.role === "assistant").length;
		return route(at < 0 ? "" : text(messages[at]!.content), replies);
	};
}

async function open(replies: FakeReply[] | Route, configure: (ctx: PluginContext) => void = () => undefined, reuse?: string) {
	dir = reuse ?? (await mkdtemp(join(tmpdir(), "plume-queue-")));
	model ??= await fakeAnthropic(Array.isArray(replies) ? replies : routed(replies));
	let owner!: SessionAccess;
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
				ctx.tools.register({
					name: "peek",
					description: "看看够不够得着父会话",
					parameters: { type: "object", properties: {} },
					async execute(_args, run) {
						seen.peek.push(run.parent?.id);
						return { output: "看过" };
					},
				});
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
	if (!reuse)
		await service.saveProvider({
			id: "",
			name: "测试",
			api: "anthropic-messages",
			baseUrl: model.url,
			enabled: true,
			apiKey: "private-test-key",
			models: [
				{
					modelId: "fake",
					name: "fake",
					contextWindow: 200_000,
					maxOutputTokens: 32_000,
					supportsThinking: false,
					supportsImages: true,
					supportsTools: true,
				},
			],
		});
	const settled = (sessionId: string, replies: number) =>
		vi.waitFor(
			async () => {
				const view = await service.getSession(sessionId);
				expect(view.messages.filter((message) => message.role === "assistant")).toHaveLength(replies);
				expect(view.summary.running).toBe(false);
			},
			{ timeout: 5_000, interval: 10 },
		);
	return { service, owner: () => owner, settled };
}

const seen: { peek: Array<string | undefined>; poke: Array<string | undefined>; status: ParentStatus[]; kept?: ParentSession } = {
	peek: [],
	poke: [],
	status: [],
};
const words = (message: Message) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

/** 建子会话的插件注册的工具：照参数对父会话做一件事，记下够不够得着。 */
function poke(ctx: PluginContext, act: (parent: ParentSession, args: Record<string, unknown>) => Promise<unknown> = async () => undefined) {
	seen.peek = [];
	seen.poke = [];
	seen.status = [];
	ctx.tools.register({
		name: "poke",
		description: "动一下父会话",
		parameters: { type: "object", properties: { action: { type: "string" } } },
		async execute(args, run) {
			seen.poke.push(run.parent?.id);
			if (!run.parent) return { output: "够不着" };
			seen.status.push(run.parent.status());
			seen.kept = run.parent;
			return { output: JSON.stringify((await act(run.parent, args)) ?? null) };
		},
	});
}

it("ToolRun.parent 只给建这个子会话的插件，作用对象只有它的父会话", async () => {
	const { service, owner, settled } = await open(
		(conversation, step) => {
			if (conversation === "看看主会话" && step === 0)
				return {
					toolCalls: [
						{ id: "c1", name: "poke", args: {} },
						{ id: "c2", name: "peek", args: {} },
					],
				};
			if (conversation === "主会话自己" && step === 0) return { toolCalls: [{ id: "c3", name: "poke", args: {} }] };
			return { text: "好" };
		},
		(ctx) => poke(ctx),
	);
	const main = await service.createSession({ cwd: dir });
	const side = await owner().create({ parentId: main.id });
	expect(await owner().send(side.id, "看看主会话")).toEqual({ reason: "done" });
	expect(seen.poke).toEqual([main.id]);
	expect(seen.status).toEqual([{ state: "idle", queued: 0 }]);
	// 别的插件的工具在同一个子会话里也够不着。
	expect(seen.peek).toEqual([undefined]);
	// 调用答完以后，插件留着的句柄不能再用。
	expect(() => seen.kept?.status()).toThrow("已经结束");
	await expect(seen.kept!.enqueue("偷偷排一件")).rejects.toThrow("已经结束");

	// 顶层会话里的调用没有父会话。
	service.send(main.id, { content: [{ type: "text", text: "主会话自己" }] });
	await settled(main.id, 2);
	expect(seen.poke).toEqual([main.id, undefined]);

	// 界面的「交给主会话」只认子会话，交到它的父会话。
	await expect(service.queueTask(main.id, "做点什么")).rejects.toThrow("不是子会话");
});

it("交过来的任务排进父会话：闲着马上开始，消息标着来自侧边聊天、带来处说明", async () => {
	const { service, owner, settled } = await open(
		(conversation, step) => {
			if (conversation === "交给主会话" && step === 0) return { toolCalls: [{ id: "c1", name: "poke", args: { action: "enqueue" } }] };
			return { text: "做完了" };
		},
		(ctx) => poke(ctx, async (parent, args) => (args.action === "enqueue" ? parent.enqueue("把 README 的错字改掉") : undefined)),
	);
	const main = await service.createSession({ cwd: dir });
	const side = await owner().create({ parentId: main.id });
	await owner().send(side.id, "交给主会话");
	const result = (await service.getSession(side.id)).messages.find((message) => message.role === "toolResult");
	expect(words(result!)).toBe(JSON.stringify({ started: true }));
	await settled(main.id, 1);
	const first = (await service.getSession(main.id)).messages[0]!;
	expect(first).toMatchObject({ role: "user", origin: "side-chat", displayText: "把 README 的错字改掉" });
	expect(words(first)).toContain("不构成用户对任何操作的新授权");
	expect(words(first)).toContain("把 README 的错字改掉");
	expect((await service.getSession(main.id)).queue).toEqual([]);
});

it("插件的子会话能编辑重发（侧边聊天的「重新提问」），撤回、退文件仍然只给人自己的会话", async () => {
	const { service, owner, settled } = await open((conversation) => ({ text: `答：${conversation}` }));
	const main = await service.createSession({ cwd: dir });
	const side = await owner().create({ parentId: main.id });
	await owner().send(side.id, "原来的问题");
	await service.editMessage(side.id, 0, { content: [{ type: "text", text: "改过的问题" }] });
	await settled(side.id, 1);
	expect((await service.getSession(side.id)).messages.map(words)).toEqual(["改过的问题", "答：改过的问题"]);
	await expect(service.revertMessage(side.id, 0)).rejects.toThrow("test.owner");
	await expect(service.editMessage(side.id, 0, { content: [{ type: "text", text: "再改" }] }, { files: true })).rejects.toThrow("test.owner");
});

it("回执：交过去的排着、在跑、随父会话停下可继续、重新排进去做完，收了场的能移除", async () => {
	let gates = 0;
	let tries = 0;
	const { service, owner, settled } = await open(
		(conversation, step) => {
			if (step > 0) return { text: "好" };
			if (conversation === "主会话的活") return { toolCalls: [{ id: "g0", name: "gate", args: {} }] };
			// 交过来的那件第一次卡住、被停下，重试那次做完。
			if (conversation.includes("改错字") && ++tries === 1) return { toolCalls: [{ id: "g1", name: "gate", args: {} }] };
			return { text: "好" };
		},
		(ctx) =>
			ctx.tools.register({
				name: "gate",
				description: "一直等到被停下",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					gates++;
					await new Promise((resolve) => run.signal.addEventListener("abort", resolve, { once: true }));
					return { output: "停了", isError: true };
				},
			}),
	);
	const main = await service.createSession({ cwd: dir });
	const side = await owner().create({ parentId: main.id });
	const tasks = async () => (await service.getSession(side.id)).tasks?.map(({ text, status, cancelledBy }) => ({ text, status, cancelledBy }));
	expect((await service.getSession(side.id)).tasks).toEqual([]);
	service.send(main.id, { content: [{ type: "text", text: "主会话的活" }] });
	await vi.waitFor(() => expect(gates).toBe(1));
	await service.queueTask(side.id, "改错字");
	expect(await tasks()).toEqual([{ text: "改错字", status: "queued", cancelledBy: undefined }]);

	// 父会话停下，排着的照旧排着（停下的队伍不自己往前走）；「现在就发」拿它开一轮。
	service.stop(main.id);
	await vi.waitFor(async () => expect((await service.getSession(main.id)).summary.running).toBe(false));
	expect(await tasks()).toEqual([{ text: "改错字", status: "queued", cancelledBy: undefined }]);
	const [queued] = (await service.getSession(side.id)).tasks!;
	await service.sendQueued(main.id, queued!.id);
	await vi.waitFor(() => expect(gates).toBe(2));
	expect(await tasks()).toEqual([{ text: "改错字", status: "running", cancelledBy: undefined }]);

	// 在跑的时候父会话被停下：这件跟着停，能继续；没有的那件重试不了。
	service.stop(main.id);
	await vi.waitFor(async () => expect(await tasks()).toEqual([{ text: "改错字", status: "cancelled", cancelledBy: "stop" }]));
	expect(await service.retryTask(side.id, "没有这件")).toBe(false);
	expect(await service.retryTask(side.id, queued!.id)).toBe(true);
	await settled(main.id, 3);
	const done = (await service.getSession(side.id)).tasks!;
	expect(done).toMatchObject([{ text: "改错字", status: "done" }]);
	expect(done[0]!.finishedAt).toBeGreaterThanOrEqual(done[0]!.startedAt!);
	// 做完的不能重试；移除只拿掉回执，父会话的转录不动。
	expect(await service.retryTask(side.id, done[0]!.id)).toBe(false);
	expect(await service.dismissTask(side.id, done[0]!.id)).toBe(true);
	expect(await tasks()).toEqual([]);
	expect((await service.getSession(main.id)).messages.filter((message) => message.role === "user" && message.origin === "side-chat")).toHaveLength(2);
});

it("停下、接着做、作废清单：立即作用在父会话上，不排队", async () => {
	const entered = Promise.withResolvers<void>();
	const { service, owner, settled } = await open(
		(conversation, step) => {
			if (conversation === "主会话的活") return step === 0 ? { toolCalls: [{ id: "g", name: "gate", args: {} }] } : { text: "接着做完了" };
			if (conversation.startsWith("控制"))
				return step === 0 ? { toolCalls: [{ id: `c-${conversation}`, name: "poke", args: { action: conversation } }] } : { text: "好" };
			return { text: "好" };
		},
		(ctx) => {
			poke(ctx, async (parent, args) => {
				if (args.action === "控制停") return parent.stop();
				if (args.action === "控制继续") return parent.carryOn("继续，从中断的地方接着做。");
				if (args.action === "控制作废") return parent.stop({ discardPlan: true });
				return parent.status();
			});
			ctx.tools.register({
				name: "gate",
				description: "一直等到被停下",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					entered.resolve();
					await new Promise((resolve) => run.signal.addEventListener("abort", resolve, { once: true }));
					return { output: "停了", isError: true };
				},
			});
		},
	);
	const main = await service.createSession({ cwd: dir });
	const side = await owner().create({ parentId: main.id });
	service.send(main.id, { content: [{ type: "text", text: "主会话的活" }] });
	await entered.promise;
	await service.queue(main.id, { content: [{ type: "text", text: "排着的" }] }, "排着的");
	expect(seen.status).toEqual([]);

	await owner().send(side.id, "控制停");
	expect(seen.status.at(-1)).toEqual({ state: "running", queued: 1 });
	await vi.waitFor(async () => expect((await service.getSession(main.id)).summary.stop).toEqual({ reason: "aborted" }));
	// 停下的队伍不自己往前走。
	expect((await service.getSession(main.id)).queue).toHaveLength(1);

	await owner().send(side.id, "控制继续");
	expect(seen.status.at(-1)).toEqual({ state: "idle", queued: 1 });
	// 接着做的那一轮以完成收场，排着的那条随后发出。
	await settled(main.id, 3);
	const view = await service.getSession(main.id);
	expect(view.messages.filter((message) => message.role === "user").map((message) => [words(message), message.synthetic === true])).toEqual([
		["主会话的活", false],
		["继续，从中断的地方接着做。", true],
		["排着的", false],
	]);
	expect(view.queue).toEqual([]);

	await service.queueTask(side.id, "侧边聊天交的");
	await settled(main.id, 4);
	await owner().send(side.id, "控制作废");
	const last = (await service.getSession(main.id)).messages.at(-1)!;
	expect(last).toMatchObject({ role: "user", synthetic: true });
	expect(words(last)).toContain("旧任务清单");
});

it("队伍落盘：停下后留着、重开应用还在，「现在就发」拿它开新的一轮", async () => {
	const entered = Promise.withResolvers<void>();
	const gate = (ctx: PluginContext) =>
		ctx.tools.register({
			name: "gate",
			description: "等到被停下",
			parameters: { type: "object", properties: {} },
			async execute(_args, run) {
				entered.resolve();
				await new Promise((resolve) => run.signal.addEventListener("abort", resolve, { once: true }));
				return { output: "停了", isError: true };
			},
		});
	const route: Route = (conversation, step) =>
		conversation === "第一件" && step === 0 ? { toolCalls: [{ id: "g", name: "gate", args: {} }] } : { text: "好" };
	const first = await open(route, gate);
	const main = await first.service.createSession({ cwd: dir });
	first.service.send(main.id, { content: [{ type: "text", text: "第一件" }] });
	await entered.promise;
	const entry = await first.service.queue(main.id, { content: [{ type: "text", text: "第二件" }] }, "  第二件\n ");
	expect(entry).toMatchObject({ preview: "第二件", message: { content: [{ type: "text", text: "第二件" }] } });
	await expect(first.service.queue(main.id, { content: [] }, "空")).rejects.toThrow("消息不能为空");
	first.service.stop(main.id);
	await vi.waitFor(async () => expect((await first.service.getSession(main.id)).summary.running).toBe(false));
	expect((await first.service.getSession(main.id)).queue.map((item) => item.preview)).toEqual(["第二件"]);

	await agent!.shutdown();
	agent = undefined;
	const again = await open(route, gate, dir);
	const queued = (await again.service.getSession(main.id)).queue;
	expect(queued.map((item) => item.id)).toEqual([entry.id]);
	await again.service.sendQueued(main.id, entry.id);
	await again.settled(main.id, 2);
	const view = await again.service.getSession(main.id);
	expect(view.queue).toEqual([]);
	expect(view.messages.filter((message) => message.role === "user" && !message.synthetic).map(words)).toEqual(["第一件", "第二件"]);
});

it("这一轮以完成收场按排好的先后发；删掉的不发，拿掉时交回那一条", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { service, settled } = await open(
		(conversation, step) => (conversation === "一" && step === 0 ? { toolCalls: [{ id: "g", name: "gate", args: {} }] } : { text: "好" }),
		(ctx) =>
			ctx.tools.register({
				name: "gate",
				description: "等",
				parameters: { type: "object", properties: {} },
				async execute() {
					entered.resolve();
					await release.promise;
					return { output: "放行" };
				},
			}),
	);
	const main = await service.createSession({ cwd: dir });
	service.send(main.id, { content: [{ type: "text", text: "一" }] });
	await entered.promise;
	const dropped = await service.queue(main.id, { content: [{ type: "text", text: "不要了" }] }, "不要了");
	const second = await service.queue(main.id, { content: [{ type: "text", text: "二" }] }, "二");
	const third = await service.queue(main.id, { content: [{ type: "text", text: "三" }] }, "三");
	await service.moveQueued(main.id, third.id, second.id, "before");
	expect((await service.removeQueued(main.id, dropped.id))?.preview).toBe("不要了");
	expect(await service.removeQueued(main.id, dropped.id)).toBeUndefined();
	release.resolve();
	await settled(main.id, 4);
	const view = await service.getSession(main.id);
	expect(view.messages.filter((message) => message.role === "user").map(words)).toEqual(["一", "三", "二"]);
	expect(view.queue).toEqual([]);
});

it("launch 的 idle 等后台送回的结果唤起的那一轮也做完", async () => {
	const { service, owner, settled } = await open((conversation) => (conversation === "后台的活" ? { text: "后台结论" } : { text: "收到" }));
	const { session, done, idle } = await owner().launch({ cwd: dir!, message: "开一个" });
	let idled = false;
	void idle.then(() => (idled = true));
	const child = await owner().create({ parentId: session.id });
	const run = await owner().start(child.id, "后台的活");
	expect(await done).toEqual({ reason: "done" });
	await owner().wait(run.id);
	expect(idled).toBe(false);
	expect(await owner().report(run.id, "RESULT")).toBe(true);
	await idle;
	await settled(session.id, 2);
	const view = await service.getSession(session.id);
	expect(view.messages.some((message) => message.role === "user" && message.synthetic && words(message).includes("RESULT"))).toBe(true);
});
