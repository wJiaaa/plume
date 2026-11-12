import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Message, PendingRequest, Plugin, PluginContext, PromptSubmit, ToolResultMessage, UserMessage } from "@plume/contract";
import { createAgent, type Agent, type AgentOptions } from "../src/agent.ts";
import { fakeAnthropic, type FakeModel } from "../src/testing.ts";

/**
 * 插件代管的会话（`launch({ steward: true })`）：代管插件往里转话（`post`）、替人答卡（`respond`、`answer`）。
 * 范围只到自己代管的会话；人停止代管以后都不行；钩子仍然放行不了提权。
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

const STEWARD = "test.steward";

/**
 * 假模型按最后一条消息回：工具结果回来了就收尾，否则按话里的词调工具——「请改」改动工作区（要审批），「请提权」申请提权，
 * 「请问」停下来等人给数据，「慢慢」挂着不回（一轮一直在跑），别的直接答。
 */
function route(request: Record<string, unknown>) {
	const messages = request.messages as Array<{ role: string; content: unknown }>;
	const last = JSON.stringify(messages[messages.length - 1]);
	if (last.includes("tool_result")) return { text: "好了" };
	if (last.includes("请改")) return { toolCalls: [{ id: `call_touch_${messages.length}`, name: "touch", args: {} }] };
	if (last.includes("请提权")) return { toolCalls: [{ id: `call_decide_${messages.length}`, name: "decide", args: {} }] };
	if (last.includes("请问")) return { toolCalls: [{ id: `call_question_${messages.length}`, name: "question", args: {} }] };
	return { text: "收到" };
}

/** 三个工具：改动工作区的（本体在执行前问）、自己申请提权的、停下来等人给数据的。 */
const tools: Plugin = {
	name: "test.tools",
	apply(ctx) {
		ctx.tools.register({
			name: "touch",
			description: "改点东西",
			parameters: { type: "object", properties: {} },
			mutating: true,
			execute: async () => ({ output: "touched" }),
		});
		ctx.tools.register({
			name: "decide",
			description: "要人拍板，放宽沙箱",
			parameters: { type: "object", properties: {} },
			asks: true,
			execute: async (_args, run) => ({ output: await run.ask({ kind: "decide", title: "拍板", detail: "放宽沙箱", escalation: "workspace-write" }) }),
		});
		ctx.tools.register({
			name: "question",
			description: "问人一个问题",
			parameters: { type: "object", properties: {} },
			execute: async (_args, run) => ({ output: JSON.stringify(await run.request({ kind: "question", title: "选哪个" })) }),
		});
	},
};

async function open(options: Partial<Pick<AgentOptions, "approvalTimeoutMs">> = {}, extra: Plugin[] = []) {
	dir = await mkdtemp(join(tmpdir(), "plume-steward-"));
	model = await fakeAnthropic(route);
	const contexts = new Map<string, PluginContext>();
	const submitted: PromptSubmit[] = [];
	const capture = (name: string): Plugin => ({
		name,
		apply(ctx) {
			contexts.set(name, ctx);
			if (name === STEWARD)
				ctx.hook("prompt.submit", async (input, next) => {
					submitted.push(input);
					return next(input);
				});
		},
	});
	agent = await createAgent({
		...options,
		dataDir: dir,
		settingsFile: join(dir, "settings.json"),
		plugins: [tools, capture(STEWARD), capture("test.other"), ...extra].map((plugin) => ({ key: plugin.name, load: async () => plugin })),
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
	const steward = contexts.get(STEWARD)!.sessions;
	const other = contexts.get("test.other")!.sessions;
	const settledView = (id: string) =>
		vi.waitFor(
			async () => {
				const view = await service.getSession(id);
				if (view.summary.running || view.queue.length > 0) throw new Error("还在跑");
				return view;
			},
			{ timeout: 5_000, interval: 10 },
		);
	/** 开一个本插件代管的会话，等第一轮跑完、会话真闲下来。 */
	const launch = async (message = "你好") => {
		const launched = await steward.launch({ cwd: dir, message, steward: true });
		await settledView(launched.session.id);
		return launched.session.id;
	};
	const card = (id: string, match: (request: PendingRequest) => boolean = () => true) =>
		vi.waitFor(
			async () => {
				const approval = (await service.getSession(id)).approval;
				if (!approval || !match(approval)) throw new Error("还没弹卡");
				return approval;
			},
			{ timeout: 5_000, interval: 10 },
		);
	return { service, steward, other, launch, settledView, card, submitted };
}

const results = (messages: Message[]) => messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
const textOf = (message: Message | undefined) =>
	(message?.content as Array<{ type: string; text?: string }> | undefined)?.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";

it("代管会话照旧是人的顶层会话；post 闲着当场开一轮，气泡标着来处，模型读到来处说明，prompt.submit 知道不是人在输入框里发的", async () => {
	const { service, steward, launch, settledView, submitted } = await open();
	const id = await launch();
	const summary = service.listSessions().find((item) => item.id === id)!;
	expect(summary).toMatchObject({ kind: "top", steward: STEWARD });
	expect(summary.owner).toBeUndefined();

	expect(await steward.post(id, "  外面的人问：今天怎样  ")).toEqual({ started: true });
	const view = await settledView(id);
	const posted = view.messages[2] as UserMessage;
	expect(posted).toMatchObject({ role: "user", origin: "plugin", fromPlugin: STEWARD, displayText: "外面的人问：今天怎样" });
	expect(posted.synthetic).toBeUndefined();
	expect(textOf(posted)).toContain("不是用户在 Plume 的输入框里打的");
	expect(textOf(posted)).toContain("外面的人问：今天怎样");
	expect(view.messages[3]).toMatchObject({ role: "assistant" });
	// 模型读到的就是带来处说明的那段。
	expect(JSON.stringify(model!.requests.at(-1))).toContain("代管这个会话的插件");
	expect(submitted.map((input) => ({ text: input.text, launched: input.launched, steward: input.session.steward }))).toEqual([
		{ text: "你好", launched: true, steward: STEWARD },
		{ text: "外面的人问：今天怎样", launched: true, steward: STEWARD },
	]);
	// 人照样能在里面接着说。
	service.send(id, { content: [{ type: "text", text: "人接着问" }] });
	expect((await settledView(id)).messages).toHaveLength(6);
});

it("会话在跑时 post 排进队，不插进这一轮；轮到了才发", async () => {
	const { service, steward, launch, card, settledView } = await open();
	const id = await launch();
	service.send(id, { content: [{ type: "text", text: "请改一下" }] });
	await card(id);
	expect(await steward.post(id, "第二句")).toEqual({ started: false });
	const queued = (await service.getSession(id)).queue;
	expect(queued).toMatchObject([{ origin: "plugin", fromPlugin: STEWARD, preview: "第二句" }]);
	service.respond(id, (await service.getSession(id)).approval!.toolCallId, "once");
	const view = await settledView(id);
	const users = view.messages.filter((message): message is UserMessage => message.role === "user");
	expect(users.map((message) => message.displayText ?? textOf(message))).toEqual(["你好", "请改一下", "第二句"]);
	// 第二句排在这一轮的工具结果和收尾之后，不夹在中间。
	const at = view.messages.indexOf(users[2]!);
	expect(view.messages.slice(at - 2, at).map((message) => message.role)).toEqual(["toolResult", "assistant"]);
});

it("只能往自己代管的会话里转话：别的插件、人自己的会话、归档的、人停止代管以后都抛错，停止代管时排着的那几条一起拿掉", async () => {
	const { service, steward, other, launch, card } = await open();
	const id = await launch();
	await expect(other.post(id, "冒充")).rejects.toThrow(`不由插件 test.other 代管`);
	const mine = await service.createSession({ cwd: dir });
	await expect(steward.post(mine.id, "插进人的会话")).rejects.toThrow("不由插件 test.steward 代管");
	await expect(steward.post(id, "   ")).rejects.toThrow("消息不能为空");
	await expect(steward.post("nope", "x")).rejects.toThrow("没有会话 nope");
	// 不代管的 launch 开出来的会话也不行：代管只在开的时候要。
	const plain = await steward.launch({ cwd: dir, message: "普通的" });
	await plain.done;
	await expect(steward.post(plain.session.id, "x")).rejects.toThrow("不由插件 test.steward 代管");

	service.send(id, { content: [{ type: "text", text: "请改一下" }] });
	await card(id);
	await steward.post(id, "排着的");
	service.queue(id, { content: [{ type: "text", text: "人排的" }] }, "人排的");
	await vi.waitFor(async () => expect((await service.getSession(id)).queue).toHaveLength(2));
	await service.revokeSteward(id);
	expect(service.listSessions().find((item) => item.id === id)?.steward).toBeUndefined();
	expect((await service.getSession(id)).queue.map((entry) => entry.preview)).toEqual(["人排的"]);
	await expect(steward.post(id, "还想说")).rejects.toThrow("人已经停止了代管");
	// 停止代管以后连弹着的卡也答不了。
	await expect(steward.respond(id, (await service.getSession(id)).approval!.toolCallId, "once")).rejects.toThrow("人已经停止了代管");

	const archived = await launch();
	await service.setSessionArchived(archived, true);
	await expect(steward.post(archived, "x")).rejects.toThrow("已归档");
	// 分叉出来的不带代管。
	const forked = await service.forkSession(archived, 1, (await service.getSession(archived)).messages[1]!.timestamp, "分叉");
	expect(forked.steward).toBeUndefined();
});

it("代管插件替人答普通审批：放行这一次，结果记着是谁代答的，模型读到的也写明；拒绝照算", async () => {
	const { steward, other, launch, card, settledView } = await open();
	const id = await launch();
	await steward.post(id, "请改一下");
	const asked = await card(id);
	await expect(other.respond(id, asked.toolCallId, "once")).rejects.toThrow("不由插件 test.other 代管");
	expect(await steward.respond(id, "call_wrong", "once")).toBe(false);
	await expect(steward.respond(id, asked.toolCallId, "always" as "once")).rejects.toThrow("只能是 once 或 reject");
	expect(await steward.respond(id, asked.toolCallId, "once")).toBe(true);
	let [result] = results((await settledView(id)).messages);
	expect(result).toMatchObject({ toolName: "touch", isError: false, answeredBy: STEWARD });
	expect(textOf(result)).toContain("touched");
	expect(textOf(result)).toContain('relayed by the plugin "test.steward"');
	// 「以后不再问」不归插件：设置里什么都没记下。
	const stored = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as { alwaysAllow?: string[] };
	expect(stored.alwaysAllow ?? []).toEqual([]);

	await steward.post(id, "请改第二处");
	const second = await card(id, (request) => request.toolCallId !== asked.toolCallId);
	expect(await steward.respond(id, second.toolCallId, "reject")).toBe(true);
	[, result] = results((await settledView(id)).messages);
	expect(result).toMatchObject({ isError: true, answeredBy: STEWARD });
	expect(textOf(result)).toContain("rejected");
});

it("提权也能由代管插件转达；tool.approve 的层答放行照旧不算数（照样弹卡），完全访问也一样", async () => {
	const guard: Plugin = { name: "test.guard", apply: (ctx) => ctx.hook("tool.approve", async () => "once") };
	const { service, steward, launch, card, settledView } = await open({}, [guard]);
	await service.setPermissionMode("full");
	const id = await launch();
	await steward.post(id, "请提权");
	const asked = await card(id);
	expect(asked).toMatchObject({ escalation: "workspace-write" });
	expect(await steward.respond(id, asked.toolCallId, "once")).toBe(true);
	const [result] = results((await settledView(id)).messages);
	expect(result).toMatchObject({ answeredBy: STEWARD });
	expect(textOf(result)).toMatch(/^once/);
});

it("钩子仍然放行不了提权：人自己的会话里，层答放行之后照样弹卡等人", async () => {
	const guard: Plugin = { name: "test.guard", apply: (ctx) => ctx.hook("tool.approve", async () => "once") };
	const { service, card, settledView } = await open({}, [guard]);
	await service.setPermissionMode("full");
	const mine = await service.createSession({ cwd: dir });
	service.send(mine.id, { content: [{ type: "text", text: "请提权" }] });
	const asked = await card(mine.id);
	service.respond(mine.id, asked.toolCallId, "reject");
	const [result] = results((await settledView(mine.id)).messages);
	expect(textOf(result)).toBe("reject");
	expect(result?.answeredBy).toBeUndefined();
});

it("代管插件替人答等人给数据的卡：交回数据，或拒绝（不答）；respond 的 once 对它不算", async () => {
	const { steward, launch, card, settledView } = await open();
	const id = await launch();
	await steward.post(id, "请问一下");
	const asked = await card(id);
	expect(asked).toMatchObject({ type: "request", kind: "question" });
	expect(await steward.respond(id, asked.toolCallId, "once")).toBe(false);
	expect(await steward.answer(id, asked.toolCallId, { pick: "B" })).toBe(true);
	let [result] = results((await settledView(id)).messages);
	expect(result).toMatchObject({ answeredBy: STEWARD });
	expect(textOf(result)).toContain('{"answered":true,"value":{"pick":"B"}}');

	await steward.post(id, "请问第二个");
	const second = await card(id, (request) => request.toolCallId !== asked.toolCallId);
	// 审批卡的答法对等人给数据的卡不算，反过来也一样。
	expect(await steward.answer(id, "call_wrong", 1)).toBe(false);
	expect(await steward.respond(id, second.toolCallId, "reject")).toBe(true);
	[, result] = results((await settledView(id)).messages);
	expect(textOf(result)).toContain('{"answered":false,"reason":"declined"}');
	expect(result).toMatchObject({ answeredBy: STEWARD });
});

it("人和插件谁先答算谁的：人先答了插件再答不算，插件先答了人再点也不算；人答的不记代答", async () => {
	const { service, steward, launch, card, settledView } = await open();
	const id = await launch();
	await steward.post(id, "请改一下");
	const first = await card(id);
	service.respond(id, first.toolCallId, "reject");
	expect(await steward.respond(id, first.toolCallId, "once")).toBe(false);
	let [result] = results((await settledView(id)).messages);
	expect(result?.isError).toBe(true);
	expect(result?.answeredBy).toBeUndefined();
	expect(textOf(result)).not.toContain("relayed");

	await steward.post(id, "请改第二处");
	const second = await card(id, (request) => request.toolCallId !== first.toolCallId);
	expect(await steward.respond(id, second.toolCallId, "once")).toBe(true);
	service.respond(id, second.toolCallId, "reject");
	[, result] = results((await settledView(id)).messages);
	expect(result).toMatchObject({ isError: false, answeredBy: STEWARD });
});

it("卡过期了、这一轮被人停下以后，插件再答都不算", async () => {
	const { service, steward, launch, card, settledView } = await open({ approvalTimeoutMs: { permission: 150, question: 150 } });
	const id = await launch();
	await steward.post(id, "请改一下");
	const expired = await card(id);
	await settledView(id);
	expect(await steward.respond(id, expired.toolCallId, "once")).toBe(false);
	expect(results((await service.getSession(id)).messages)[0]).toMatchObject({ isError: true });

	await steward.post(id, "请问一下");
	const asked = await card(id, (request) => request.toolCallId !== expired.toolCallId);
	service.stop(id);
	await settledView(id);
	expect(await steward.answer(id, asked.toolCallId, "晚了")).toBe(false);
	expect((await service.getSession(id)).summary.stop).toEqual({ reason: "aborted" });
});

it("完全访问下插件转来的一轮照会话的设置走：改动工作区不弹卡", async () => {
	const { service, steward, launch, settledView } = await open();
	await service.setPermissionMode("full");
	const id = await launch();
	await steward.post(id, "请改一下");
	const [result] = results((await settledView(id)).messages);
	expect(result).toMatchObject({ toolName: "touch", isError: false });
	expect(result?.answeredBy).toBeUndefined();
});

it("插件停用以后，留着的 ctx 转不了话也答不了卡", async () => {
	const { service, steward, launch } = await open();
	const id = await launch();
	await service.setPluginEnabled(STEWARD, false);
	await expect(steward.post(id, "x")).rejects.toThrow("已停用");
	await expect(steward.respond(id, "call", "once")).rejects.toThrow("已停用");
	await expect(steward.answer(id, "call", 1)).rejects.toThrow("已停用");
});

it("代管会话下面的子会话（别的插件建的也算）弹的卡，代管插件也能答：审批、提权、等人给数据，都记着代答者；往子会话里转话不行", async () => {
	const { service, steward, other, launch, card, settledView } = await open();
	const id = await launch();
	// 子会话由别的插件建（像子智能体那样）：能不能答看的是父会话的代管关系，不看子会话的 owner。
	const child = await other.create({ parentId: id });
	await expect(steward.post(child.id, "往子会话里转")).rejects.toThrow("是子会话");

	void other.send(child.id, "请改一下");
	const asked = await card(child.id);
	expect(await steward.respond(child.id, "call_wrong", "once")).toBe(false);
	expect(await steward.respond(child.id, asked.toolCallId, "once")).toBe(true);
	let [result] = results((await settledView(child.id)).messages);
	expect(result).toMatchObject({ toolName: "touch", isError: false, answeredBy: STEWARD });
	expect(textOf(result)).toContain('relayed by the plugin "test.steward"');

	void other.send(child.id, "请提权");
	const escalation = await card(child.id, (request) => request.toolCallId !== asked.toolCallId);
	expect(escalation).toMatchObject({ escalation: "workspace-write" });
	expect(await steward.respond(child.id, escalation.toolCallId, "once")).toBe(true);
	[, result] = results((await settledView(child.id)).messages);
	expect(result).toMatchObject({ answeredBy: STEWARD });
	expect(textOf(result)).toMatch(/^once/);

	void other.send(child.id, "请问一下");
	const question = await card(child.id, (request) => request.type === "request");
	expect(await steward.answer(child.id, question.toolCallId, { pick: "A" })).toBe(true);
	[, , result] = results((await settledView(child.id)).messages);
	expect(result).toMatchObject({ answeredBy: STEWARD });
	expect(textOf(result)).toContain('{"answered":true,"value":{"pick":"A"}}');
	// 父会话里什么都没多出来：答的是子会话自己的卡。
	expect(results((await service.getSession(id)).messages)).toHaveLength(0);
});

it("不在代管会话下面的子会话，代管插件答不了；别的插件也答不了它不代管的会话下面的；人停止代管以后，子会话还弹着的卡只能人答", async () => {
	const { service, steward, other, launch, card, settledView } = await open();
	const mine = await service.createSession({ cwd: dir });
	const human = await other.create({ parentId: mine.id });
	void other.send(human.id, "请改一下");
	const asked = await card(human.id);
	await expect(steward.respond(human.id, asked.toolCallId, "once")).rejects.toThrow(`不由插件 ${STEWARD} 代管`);
	await expect(steward.answer(human.id, asked.toolCallId, 1)).rejects.toThrow("不能替人答它的卡");
	service.respond(human.id, asked.toolCallId, "reject");
	await settledView(human.id);

	const id = await launch();
	const child = await other.create({ parentId: id });
	void other.send(child.id, "请改一下");
	const pending = await card(child.id);
	// 子会话是 test.other 建的，可代管它父会话的不是 test.other：照样答不了。
	await expect(other.respond(child.id, pending.toolCallId, "once")).rejects.toThrow("不能替人答它的卡");
	await service.revokeSteward(id);
	await expect(steward.respond(child.id, pending.toolCallId, "once")).rejects.toThrow("人已经停止了代管");
	expect((await service.getSession(child.id)).approval?.toolCallId).toBe(pending.toolCallId);
	service.respond(child.id, pending.toolCallId, "once");
	const [result] = results((await settledView(child.id)).messages);
	expect(result).toMatchObject({ isError: false });
	expect(result?.answeredBy).toBeUndefined();
});
