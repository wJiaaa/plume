import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LetterReceipt, Message, Plugin, PluginContext, SessionAccess, ToolRun } from "@plume/contract";
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

/**
 * 测试插件的工具：`keep` 留下这次调用的 `letter`，从测试里寄。寄信口子只在调用里有效，所以带 `hold` 的调用挂着不答，
 * 直到 `release()` 或这一轮被停下。
 */
async function open(replies: FakeReply[], configure: (ctx: PluginContext) => void = () => undefined) {
	dir = await mkdtemp(join(tmpdir(), "plume-letters-"));
	model = await fakeAnthropic(replies);
	const kept: Array<ToolRun["letter"] | null> = [];
	const holds: Array<() => void> = [];
	let sessions!: SessionAccess;
	const plugin: Plugin = {
		name: "test.letters",
		apply(ctx) {
			sessions = ctx.sessions;
			ctx.tools.register({
				name: "keep",
				description: "留下寄信的口子",
				parameters: { type: "object", properties: {} },
				async execute(args, run) {
					kept.push(run.letter ?? null);
					if (run.letter && args.hold === true)
						await new Promise<void>((resolve) => {
							holds.push(resolve);
							run.signal.addEventListener("abort", () => resolve(), { once: true });
						});
					return { output: "已留下" };
				},
			});
			configure(ctx);
		},
	};
	agent = await createAgent({
		dataDir: dir,
		settingsFile: join(dir, "settings.json"),
		plugins: [{ key: plugin.name, load: async () => plugin }],
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
	const asker = await service.createSession({ cwd: dir });
	const target = await service.createSession({ cwd: dir });
	const done = async (sessionId: string, replies: number) =>
		vi.waitFor(
			async () => {
				const view = await service.getSession(sessionId);
				expect(view.messages.filter((message) => message.role === "assistant")).toHaveLength(replies);
				expect(view.summary.running).toBe(false);
			},
			{ timeout: 5_000, interval: 10 },
		);
	/** 让 `asker` 跑一轮、调一次 `keep`，拿到它的寄信口子；那次调用挂着，`release()` 才答完。 */
	const letterOf = async () => {
		const before = kept.length;
		service.send(asker.id, { content: [{ type: "text", text: "开始" }] });
		await vi.waitFor(() => expect(kept.length).toBeGreaterThan(before), { timeout: 5_000, interval: 10 });
		return kept.at(-1)!;
	};
	const release = () => holds.splice(0).forEach((resolve) => resolve());
	return { service, sessions, asker, target, done, kept, letterOf, release };
}

const words = (message: Message) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
const keepCall: FakeReply = { toolCalls: [{ id: "call_keep", name: "keep", args: { hold: true } }] };

it("寄给闲着的会话：聚合后为它开一轮，消息带 peer，开头说明不是用户的话，同样的说明只写一遍", async () => {
	const { service, asker, target, done, letterOf } = await open([keepCall, { text: "读到了" }]);
	const letter = (await letterOf())!;
	const first = letter(target.id, { from: "问的 [aaaaaa]", text: "第一问", request: true, guide: "GUIDE_REQUEST", chain: [asker.id] });
	const second = letter(target.id, { from: "问的 [aaaaaa]", text: "第二问", request: true, guide: "GUIDE_REQUEST" });
	await done(target.id, 1);
	expect(await first.read).toEqual({ status: "read", opened: true });
	expect(await second.read).toEqual({ status: "read", opened: true });
	const delivered = (await service.getSession(target.id)).messages[0]!;
	expect(delivered).toMatchObject({
		role: "user",
		synthetic: true,
		peer: [
			{ id: first.id, sessionId: asker.id, from: "问的 [aaaaaa]", text: "第一问", cwd: dir, request: true, chain: [asker.id] },
			{ id: second.id, sessionId: asker.id, text: "第二问", request: true },
		],
	});
	const text = words(delivered);
	expect(text).toContain("不是用户说的话");
	expect(text.match(/GUIDE_REQUEST/g)).toHaveLength(1);
	expect(text).toContain(`<session-message from="问的 [aaaaaa]" cwd="${dir}" reply="expected">\n第一问\n</session-message>`);
});

it("寄给忙着的会话：不另开一轮，在步骤边界读到，不算叫起这一轮", async () => {
	const { service, target, done, letterOf } = await open([keepCall, { toolCalls: [{ id: "call_gate", name: "gate", args: {} }] }, { text: "做完" }], (ctx) =>
		ctx.tools.register({
			name: "gate",
			description: "等一下",
			parameters: { type: "object", properties: {} },
			async execute() {
				await new Promise((resolve) => setTimeout(resolve, 500));
				return { output: "好了" };
			},
		}),
	);
	const letter = (await letterOf())!;
	service.send(target.id, { content: [{ type: "text", text: "做事" }] });
	await vi.waitFor(async () => expect((await service.getSession(target.id)).summary.running).toBe(true));
	const receipt = letter(target.id, { from: "问的", text: "插一句" });
	await done(target.id, 2);
	expect(await receipt.read).toEqual({ status: "read", opened: false });
	const roles = (await service.getSession(target.id)).messages.map((message) => (message.role === "user" && message.peer ? "letter" : message.role));
	expect(roles).toEqual(["user", "assistant", "toolResult", "letter", "assistant"]);
});

it("收件方的人按停：请求没读到；通知、答复留着，不叫醒它，人下一次开口时接在那句后面读到", async () => {
	const { service, target, done, letterOf } = await open([keepCall, { text: "答人" }]);
	const letter = (await letterOf())!;
	const request = letter(target.id, { from: "问的", text: "停之前的问", request: true });
	const notice = letter(target.id, { from: "问的", text: "停之前的通知" });
	const answer = letter(target.id, { from: "问的", text: "停之前的答复", answer: "replied", re: ["问过的"] });
	service.stop(target.id);
	expect(await request.read).toEqual({ status: "dropped" });
	await new Promise((resolve) => setTimeout(resolve, 600));
	const idle = await service.getSession(target.id);
	expect(idle.messages).toEqual([]);
	expect(idle.summary.running).toBe(false);

	service.send(target.id, { content: [{ type: "text", text: "人开口" }] });
	await done(target.id, 1);
	expect(await notice.read).toEqual({ status: "read", opened: false });
	expect(await answer.read).toEqual({ status: "read", opened: false });
	const messages = (await service.getSession(target.id)).messages;
	expect(messages.map((message) => (message.role === "user" && message.peer ? "letter" : message.role))).toEqual(["user", "letter", "assistant"]);
	expect(messages[1]).toMatchObject({ peer: [{ text: "停之前的通知" }, { text: "停之前的答复", answer: "replied" }] });
	expect(JSON.stringify(messages)).not.toContain("停之前的问");
});

it("停下以后寄来的照常为它开一轮，留着的信一起读到、排在前面", async () => {
	const { service, target, done, letterOf } = await open([keepCall, { text: "读到了" }]);
	const letter = (await letterOf())!;
	const kept = letter(target.id, { from: "问的", text: "停之前" });
	service.stop(target.id);
	const fresh = letter(target.id, { from: "问的", text: "停之后" });
	await done(target.id, 1);
	expect(await kept.read).toEqual({ status: "read", opened: true });
	expect(await fresh.read).toEqual({ status: "read", opened: true });
	expect((await service.getSession(target.id)).messages[0]).toMatchObject({ peer: [{ text: "停之前" }, { text: "停之后" }] });
});

it("读信的那一轮被插话打断：请求和通知都留着，接在插话后面读到", async () => {
	let first = true;
	const { service, target, done, letterOf } = await open([keepCall, { text: "答" }], (ctx) =>
		ctx.hook("prompt.submit", async (input, next) => {
			// 第一次送信时卡在钩子里，等这一轮被打断。
			if (input.synthetic && first) {
				first = false;
				await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }));
			}
			return next(input);
		}),
	);
	const letter = (await letterOf())!;
	const request = letter(target.id, { from: "问的", text: "要答的问", request: true });
	await vi.waitFor(async () => expect((await service.getSession(target.id)).summary.running).toBe(true));
	service.send(target.id, { content: [{ type: "text", text: "插话" }], interrupt: true });
	await done(target.id, 1);
	expect(await request.read).toEqual({ status: "read", opened: false });
	const messages = (await service.getSession(target.id)).messages;
	expect(messages.map((message) => (message.role === "user" && message.peer ? "letter" : message.role))).toEqual(["user", "letter", "assistant"]);
});

it("收件方删掉了：攒着的信是 closed；钩子拦下送达时是 dropped", async () => {
	let block = false;
	const { service, target, letterOf } = await open([keepCall], (ctx) =>
		ctx.hook("prompt.submit", async (input, next) => (block && input.synthetic ? { block: true, reason: "拦下" } : next(input))),
	);
	const letter = (await letterOf())!;
	const closed = letter(target.id, { from: "问的", text: "删之前" });
	await service.deleteSession(target.id);
	expect(await closed.read).toEqual({ status: "closed" });

	const other = await service.createSession({ cwd: dir });
	block = true;
	expect(await letter(other.id, { from: "问的", text: "被拦" }).read).toEqual({ status: "dropped" });
	expect((await service.getSession(other.id)).messages).toEqual([]);
});

it("只在顶层会话之间：子会话拿不到，寄给子会话、自己、不存在的会话抛错，空信抛错", async () => {
	// 子会话里那次 `keep` 没有寄信口子，不挂着。
	const { sessions, asker, target, kept, letterOf } = await open([keepCall, keepCall, { text: "子会话做完" }]);
	const letter = (await letterOf())!;
	const child = await sessions.create({ parentId: target.id });
	expect(() => letter(child.id, { from: "问的", text: "x" })).toThrow();
	expect(() => letter(asker.id, { from: "问的", text: "x" })).toThrow();
	expect(() => letter("nobody", { from: "问的", text: "x" })).toThrow();
	expect(() => letter(target.id, { from: "问的", text: "  " })).toThrow();
	await sessions.send(child.id, "子任务");
	expect(kept.at(-1)).toBeNull();
});

it("代答：从收件方寄回发件方，只能用一次；发件方不在了就寄不出", async () => {
	const { service, asker, target, done, letterOf, release } = await open([keepCall, { text: "读到了" }, { text: "留好了" }, { text: "收到答复" }]);
	const letter = (await letterOf())!;
	const receipt = letter(target.id, { from: "问的 [aaaaaa]", text: "问一句", request: true });
	const later = letter(target.id, { from: "问的", text: "又一句" });
	await done(target.id, 1);
	// 发件方答完那次调用、闲下来，代答才为它开一轮。
	release();
	await done(asker.id, 2);
	const answer = receipt.answer({ from: "答的 [bbbbbb]", text: "它最后说的话", answer: "unreplied", re: ["问一句"] });
	expect(answer).toBeDefined();
	expect(receipt.answer({ from: "答的", text: "再来一次" })).toBeUndefined();
	await done(asker.id, 3);
	expect(await answer!.read).toEqual({ status: "read", opened: true });
	const back = (await service.getSession(asker.id)).messages.at(-2)!;
	expect(back).toMatchObject({ synthetic: true, peer: [{ sessionId: target.id, from: "答的 [bbbbbb]", answer: "unreplied", re: ["问一句"], cwd: dir }] });
	expect(words(back)).toContain('answer="unreplied" re="问一句"');

	await service.deleteSession(asker.id);
	expect(later.answer({ from: "答的", text: "x" })).toBeUndefined();
});

/** 开出来的会话在第一轮里问 `target` 一句（`request: true`），回执留给测试。`target` 调 `answer` 时自己寄一封答复回去。 */
async function launchAsking(replies: FakeReply[], targetReplies = 1) {
	let receipt: LetterReceipt | undefined;
	let targetId = "";
	let launchedId = "";
	const opened = await open([{ toolCalls: [{ id: "call_ask", name: "ask", args: {} }] }, { text: "问完了，等答复" }, ...replies], (ctx) => {
		ctx.tools.register({
			name: "ask",
			description: "问一句",
			parameters: { type: "object", properties: {} },
			async execute(_args, run) {
				receipt = run.letter!(targetId, { from: "新会话", text: "帮我看看", request: true });
				return { output: "问了" };
			},
		});
		ctx.tools.register({
			name: "answer",
			description: "自己寄答复",
			parameters: { type: "object", properties: {} },
			async execute(_args, run) {
				run.letter!(launchedId, { from: "对方", text: "看好了", answer: "replied" });
				return { output: "回了" };
			},
		});
	});
	targetId = opened.target.id;
	const launched = await opened.sessions.launch({ cwd: dir, message: "去问" });
	launchedId = launched.session.id;
	let idle = false;
	void launched.idle.then(() => (idle = true));
	expect(await launched.done).toMatchObject({ reason: "done" });
	// 对方读到请求、跑完那一轮；这时开出来的会话早就闲着了，问出去的却还没答复。
	await opened.done(targetId, targetReplies);
	await new Promise((resolve) => setTimeout(resolve, 600));
	return { ...opened, launched, receipt: receipt!, idle: () => idle };
}

it("开出来的会话问出去还没答复时不算做完：答复送到、为它跑完那一轮，launch 的 idle 才兑现", async () => {
	const { service, launched, receipt, idle } = await launchAsking([{ text: "这就看" }, { text: "收到答复" }]);
	expect(idle()).toBe(false);
	receipt.answer({ from: "对方", text: "看好了", answer: "replied", re: ["帮我看看"] });
	await launched.idle;
	const replies = (await service.getSession(launched.session.id)).messages.filter((message) => message.role === "assistant").map(words);
	expect(replies).toEqual(["", "问完了，等答复", "收到答复"]);
});

it("对方读到以后自己寄来答复也算答了", async () => {
	// 对方那一轮调了 `answer`：在那次调用里经它的寄信口子回一封答复，不走回执。
	const { launched } = await launchAsking([{ toolCalls: [{ id: "call_answer", name: "answer", args: {} }] }, { text: "回过去了" }, { text: "收到答复" }], 2);
	expect(await launched.idle).toMatchObject({ stop: { reason: "done" }, reply: "收到答复" });
});

it("问的对方删掉了：不再等答复", async () => {
	const { service, target, launched, idle } = await launchAsking([{ text: "这就看" }]);
	expect(idle()).toBe(false);
	await service.deleteSession(target.id);
	await launched.idle;
});

it("寄请求的插件停用了：没人再代答，不再等", async () => {
	const { service, launched, idle } = await launchAsking([{ text: "这就看" }]);
	expect(idle()).toBe(false);
	await service.setPluginEnabled("test.letters", false);
	await launched.idle;
});
