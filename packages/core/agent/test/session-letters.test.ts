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
async function open(replies: FakeReply[] | ((request: Record<string, unknown>) => FakeReply), configure: (ctx: PluginContext) => void = () => undefined) {
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
/** 会话里收到的答复（带 `answer` 的信），按收到的先后。 */
const answersOf = (messages: Message[]) =>
	messages.flatMap((message) => (message.role === "user" && message.peer ? message.peer.filter((letter) => letter.answer) : []));
const keepCall: FakeReply = { toolCalls: [{ id: "call_keep", name: "keep", args: { hold: true } }] };
const holdCall: FakeReply = { toolCalls: [{ id: "call_hold", name: "keep", args: { hold: true } }] };

it("寄给闲着的会话：聚合后为它开一轮，消息带 peer，开头说明不是用户的话，同样的说明只写一遍", async () => {
	const { service, asker, target, done, letterOf } = await open([keepCall, { text: "读到了" }]);
	const letter = (await letterOf())!;
	const first = letter(target.id, { from: "问的 [aaaaaa]", text: "第一问", request: true, guide: "GUIDE_REQUEST" });
	const second = letter(target.id, { from: "问的 [aaaaaa]", text: "第二问", request: true, guide: "GUIDE_REQUEST" });
	await done(target.id, 1);
	expect(await first.read).toEqual({ status: "read" });
	expect(await second.read).toEqual({ status: "read" });
	const delivered = (await service.getSession(target.id)).messages[0]!;
	expect(delivered).toMatchObject({
		role: "user",
		synthetic: true,
		peer: [
			{ id: first.id, sessionId: asker.id, from: "问的 [aaaaaa]", text: "第一问", cwd: dir, request: true },
			{ id: second.id, sessionId: asker.id, text: "第二问", request: true },
		],
	});
	const text = words(delivered);
	expect(text).toContain("不是用户说的话");
	expect(text.match(/GUIDE_REQUEST/g)).toHaveLength(1);
	expect(text).toContain(`<session-message from="问的 [aaaaaa]" cwd="${dir}" reply="expected">\n第一问\n</session-message>`);
});

it("寄给忙着的会话：不另开一轮，在步骤边界读到", async () => {
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
	expect(await receipt.read).toEqual({ status: "read" });
	const roles = (await service.getSession(target.id)).messages.map((message) => (message.role === "user" && message.peer ? "letter" : message.role));
	expect(roles).toEqual(["user", "assistant", "toolResult", "letter", "assistant"]);
});

it("收件方的人按停：请求没读到，本体替它答 dropped；通知留着，不叫醒它，人下一次开口时接在那句后面读到", async () => {
	const { service, asker, target, done, letterOf, release } = await open([keepCall, { text: "答人" }]);
	const letter = (await letterOf())!;
	const request = letter(target.id, { from: "问的", text: "停之前的问", request: true, recipient: "答的 [bbbbbb]" });
	const notice = letter(target.id, { from: "问的", text: "停之前的通知" });
	service.stop(target.id);
	expect(await request.read).toEqual({ status: "dropped" });
	await new Promise((resolve) => setTimeout(resolve, 600));
	const idle = await service.getSession(target.id);
	expect(idle.messages).toEqual([]);
	expect(idle.summary.running).toBe(false);
	// 发件方收到本体代写的「没读到」，插件再代答什么也不寄。
	release();
	await vi.waitFor(async () => expect(answersOf((await service.getSession(asker.id)).messages)).toHaveLength(1), { timeout: 5_000, interval: 10 });
	expect(answersOf((await service.getSession(asker.id)).messages)[0]).toMatchObject({
		sessionId: target.id,
		from: "答的 [bbbbbb]",
		answer: "dropped",
		re: ["停之前的问"],
	});
	expect(request.answer({ from: "答的", text: "插件也来代答", answer: "dropped" })).toBeUndefined();

	service.send(target.id, { content: [{ type: "text", text: "人开口" }] });
	await done(target.id, 1);
	expect(await notice.read).toEqual({ status: "read" });
	const messages = (await service.getSession(target.id)).messages;
	expect(messages.map((message) => (message.role === "user" && message.peer ? "letter" : message.role))).toEqual(["user", "letter", "assistant"]);
	expect(messages[1]).toMatchObject({ peer: [{ text: "停之前的通知" }] });
	expect(JSON.stringify(messages)).not.toContain("停之前的问");
});

it("停下以后寄来的照常为它开一轮，留着的信一起读到、排在前面", async () => {
	const { service, target, done, letterOf } = await open([keepCall, { text: "读到了" }]);
	const letter = (await letterOf())!;
	const kept = letter(target.id, { from: "问的", text: "停之前" });
	service.stop(target.id);
	const fresh = letter(target.id, { from: "问的", text: "停之后" });
	await done(target.id, 1);
	expect(await kept.read).toEqual({ status: "read" });
	expect(await fresh.read).toEqual({ status: "read" });
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
	expect(await request.read).toEqual({ status: "read" });
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

it("插件经回执替收件方答一封：只答这一封、只能一次，本体不再为它代答；没答的那封由本体代答", async () => {
	const { service, asker, target, done, letterOf, release } = await open([keepCall, { text: "读到了" }]);
	const letter = (await letterOf())!;
	const first = letter(target.id, { from: "问的 [aaaaaa]", text: "问一句", request: true, recipient: "答的 [bbbbbb]" });
	const second = letter(target.id, { from: "问的 [aaaaaa]", text: "又一句", request: true, recipient: "答的 [bbbbbb]" });
	const answer = first.answer({ from: "答的 [bbbbbb]", text: "插件替它答" });
	expect(answer?.answered).toBe(1);
	expect(first.answer({ from: "答的", text: "再来一次" })).toBeUndefined();
	await done(target.id, 1);
	release();
	await vi.waitFor(async () => expect(answersOf((await service.getSession(asker.id)).messages)).toHaveLength(2), { timeout: 5_000, interval: 10 });
	expect(answersOf((await service.getSession(asker.id)).messages)).toMatchObject([
		{ sessionId: target.id, from: "答的 [bbbbbb]", text: "插件替它答", answer: "replied", re: ["问一句"], cwd: dir },
		{ sessionId: target.id, from: "答的 [bbbbbb]", text: "读到了", answer: "unreplied", re: ["又一句"], cwd: dir },
	]);
	expect(second.answer({ from: "答的", text: "插件也来代答" })).toBeUndefined();
});

it("答复对不上任何挂着的请求时按通知送；通知的回执寄回去的也是通知", async () => {
	const { service, target, done, letterOf } = await open([keepCall, { text: "读到了" }]);
	const letter = (await letterOf())!;
	const stray = letter(target.id, { from: "问的", text: "没人问过的答复", answer: "replied", re: ["谁问的"] });
	expect(stray.answered).toBe(0);
	await done(target.id, 1);
	const delivered = (await service.getSession(target.id)).messages[0]!;
	expect(delivered).toMatchObject({ peer: [{ text: "没人问过的答复" }] });
	expect(answersOf([delivered])).toEqual([]);
	expect(words(delivered)).not.toContain("answer=");
});

it("发件方删掉了：读到请求的那一轮照常收场，不再答，回执也寄不出", async () => {
	const { service, asker, target, done, letterOf } = await open([keepCall, { text: "读到了" }]);
	const letter = (await letterOf())!;
	const receipt = letter(target.id, { from: "问的", text: "问一句", request: true });
	await service.deleteSession(asker.id);
	await done(target.id, 1);
	expect(await receipt.read).toEqual({ status: "read" });
	expect(receipt.answer({ from: "答的", text: "x" })).toBeUndefined();
});

it("收件方读到请求以后被人停下：那一轮以停下收场，本体拿它最后说的话代答，注明没做完", async () => {
	const { service, asker, target, letterOf, release } = await open([keepCall, { ...holdCall, text: "先看看" }, { text: "收到" }]);
	const letter = (await letterOf())!;
	const receipt = letter(target.id, { from: "问的", text: "要答的问", request: true, recipient: "答的" });
	expect(await receipt.read).toEqual({ status: "read" });
	await vi.waitFor(async () => expect((await service.getSession(target.id)).messages.some((message) => message.role === "assistant")).toBe(true), {
		timeout: 5_000,
		interval: 10,
	});
	service.stop(target.id);
	release();
	await vi.waitFor(async () => expect(answersOf((await service.getSession(asker.id)).messages)).toHaveLength(1), { timeout: 5_000, interval: 10 });
	const [back] = answersOf((await service.getSession(asker.id)).messages);
	expect(back).toMatchObject({ from: "答的", answer: "unreplied", re: ["要答的问"] });
	expect(back!.text).toContain("被它的人停下了");
	expect(back!.text).toContain("先看看");
});

it("收件方删掉了：读到了的、还没读到的请求都由本体答 closed，各家一封", async () => {
	// 收件方读到请求后挂在一次调用里；发件方的那次调用放开后说一句就收场。
	const { service, asker, target, kept, letterOf, release } = await open((request) =>
		JSON.stringify(request.messages).includes("读到的问") ? holdCall : JSON.stringify(request.messages).includes("call_keep") ? { text: "收到" } : keepCall,
	);
	const letter = (await letterOf())!;
	const read = letter(target.id, { from: "问的", text: "读到的问", request: true, recipient: "答的" });
	await vi.waitFor(() => expect(kept).toHaveLength(2), { timeout: 5_000, interval: 10 });
	const other = await service.createSession({ cwd: dir });
	// 还在聚合窗口里就删掉：这封没读到。
	const unread = letter(other.id, { from: "问的", text: "没读到的问", request: true, recipient: "另一个" });
	await service.deleteSession(target.id);
	await service.deleteSession(other.id);
	expect(await read.read).toEqual({ status: "read" });
	expect(await unread.read).toEqual({ status: "closed" });
	// 答复聚合好了再放开发件方，在它的下一个步骤边界读到。
	await new Promise((resolve) => setTimeout(resolve, 600));
	release();
	await vi.waitFor(async () => expect(answersOf((await service.getSession(asker.id)).messages)).toHaveLength(2), { timeout: 5_000, interval: 10 });
	expect(answersOf((await service.getSession(asker.id)).messages)).toMatchObject([
		{ sessionId: target.id, from: "答的", answer: "closed", re: ["读到的问"] },
		{ sessionId: other.id, from: "另一个", answer: "closed", re: ["没读到的问"] },
	]);
	expect(read.answer({ from: "答的", text: "x" })).toBeUndefined();
});

/** 开出来的会话在第一轮里问 `target` 一句（`request: true`），回执留给测试。`target` 调 `answer` 时自己寄一封答复回去。 */
async function launchAsking(replies: FakeReply[]) {
	let receipt: LetterReceipt | undefined;
	let replied: LetterReceipt | undefined;
	let targetId = "";
	let launchedId = "";
	const opened = await open([{ toolCalls: [{ id: "call_ask", name: "ask", args: {} }] }, { text: "问完了，等答复" }, ...replies], (ctx) => {
		ctx.tools.register({
			name: "ask",
			description: "问一句",
			parameters: { type: "object", properties: {} },
			async execute(_args, run) {
				receipt = run.letter!(targetId, { from: "新会话", text: "帮我看看", request: true, recipient: "对方 [bbbbbb]" });
				return { output: "问了" };
			},
		});
		ctx.tools.register({
			name: "answer",
			description: "自己寄答复",
			parameters: { type: "object", properties: {} },
			async execute(_args, run) {
				replied = run.letter!(launchedId, { from: "对方", text: "看好了", answer: "replied" });
				return { output: "回了" };
			},
		});
	});
	targetId = opened.target.id;
	const launched = await opened.sessions.launch({ cwd: dir, message: "去问" });
	launchedId = launched.session.id;
	expect(await launched.done).toMatchObject({ reason: "done" });
	return { ...opened, launched, receipt: () => receipt!, replied: () => replied };
}

it("收件方那一轮没答：本体拿它读到以后最后一段回复代答，答复唤起的那一轮做完 launch 的 idle 才兑现", async () => {
	const { service, target, launched, receipt } = await launchAsking([{ text: "这就看" }, { text: "收到答复" }]);
	expect(await launched.idle).toMatchObject({ stop: { reason: "done" }, reply: "收到答复" });
	const messages = (await service.getSession(launched.session.id)).messages;
	expect(answersOf(messages)).toEqual([
		expect.objectContaining({ sessionId: target.id, from: "对方 [bbbbbb]", text: "这就看", answer: "unreplied", re: ["帮我看看"], cwd: dir }),
	]);
	const back = messages.find((message) => message.role === "user" && message.peer)!;
	expect(words(back)).toContain('answer="unreplied" re="帮我看看"');
	expect(words(back)).toContain("unreplied 是对方读到请求的那一轮收场了却没答");
	// 收件方读到的请求前面说明了没答会被代答。
	expect(words((await service.getSession(target.id)).messages[0]!)).toContain("最后一段回复会原样交给发件方");
	// 插件（比如会话互通）随后也来代答：什么也不寄。
	expect(receipt().answer({ from: "对方", text: "它最后说的话", answer: "unreplied" })).toBeUndefined();
	await new Promise((resolve) => setTimeout(resolve, 600));
	expect(answersOf((await service.getSession(launched.session.id)).messages)).toHaveLength(1);
});

it("收件方自己寄来答复：本体对上那封请求、补上 re，那一轮收场时不再代答", async () => {
	// 对方那一轮调了 `answer`：在那次调用里经它的寄信口子回一封答复，不走回执。
	const { service, launched, receipt, replied } = await launchAsking([
		{ toolCalls: [{ id: "call_answer", name: "answer", args: {} }] },
		{ text: "回过去了" },
		{ text: "收到答复" },
	]);
	expect(await launched.idle).toMatchObject({ stop: { reason: "done" }, reply: "收到答复" });
	expect(replied()?.answered).toBe(1);
	expect(answersOf((await service.getSession(launched.session.id)).messages)).toEqual([
		expect.objectContaining({ text: "看好了", answer: "replied", re: ["帮我看看"] }),
	]);
	expect(receipt().answer({ from: "对方", text: "它最后说的话", answer: "unreplied" })).toBeUndefined();
});

it("收件方总不正面回答：代答叫起的那一轮接着请求的链往下数，来回到上限时寄信抛错；人开口以后从头算", async () => {
	/** 发件方每被叫起一次就再问一句；`asking` 关掉以后只说一句话收场。 */
	let asking = true;
	let targetId = "";
	const sent: string[] = [];
	const refused: string[] = [];
	const last = (request: Record<string, unknown>) => JSON.stringify((request.messages as unknown[]).at(-1));
	const { service, asker, target } = await open(
		(request) => {
			const message = last(request);
			if (message.includes("tool_result")) return { text: "等答复" };
			// 收件方：从不寄答复，那一轮收场时由本体拿这句代答。
			if (message.includes('reply=\\"expected\\"')) return { text: "我先不说" };
			// 参数每次不同，免得撞上重复调用的提醒。
			const n = sent.length + refused.length;
			return asking ? { toolCalls: [{ id: `call_ask_${n}`, name: "ask", args: { n } }] } : { text: "好" };
		},
		(ctx) =>
			ctx.tools.register({
				name: "ask",
				description: "再问一句",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					try {
						const receipt = run.letter!(targetId, { from: "问的", text: `第 ${sent.length + 1} 问`, request: true, recipient: "答的" });
						sent.push(receipt.id);
						return { output: "问了" };
					} catch (error) {
						asking = false;
						refused.push((error as Error).message);
						return { output: (error as Error).message, isError: true };
					}
				},
			}),
	);
	targetId = target.id;
	service.send(asker.id, { content: [{ type: "text", text: "开始" }] });
	await vi.waitFor(() => expect(refused).toHaveLength(1), { timeout: 30_000, interval: 20 });
	// 两边来回：发件方第 n 次问时链有 2n-1 跳、它自己经手 n 次，第 11 次超出同一个会话最多经手 10 次。
	expect(sent).toHaveLength(10);
	expect(refused[0]).toContain("往来链到 21 跳");
	const answers = answersOf((await service.getSession(asker.id)).messages);
	expect(answers).toHaveLength(10);
	expect(answers.every((letter) => letter.answer === "unreplied")).toBe(true);

	// 被拦下的那一轮收场以后人再开口。
	await vi.waitFor(async () => expect((await service.getSession(asker.id)).summary.running).toBe(false), { timeout: 5_000, interval: 20 });
	asking = true;
	service.send(asker.id, { content: [{ type: "text", text: "再问一次" }] });
	await vi.waitFor(() => expect(sent).toHaveLength(11), { timeout: 5_000, interval: 20 });
	asking = false;
	expect(refused).toHaveLength(1);
}, 40_000);
