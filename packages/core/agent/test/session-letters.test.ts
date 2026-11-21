import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, Message, Plugin, PluginContext, SessionAccess, ToolRun } from "@plume/contract";
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
const shape = (messages: Message[]) => messages.map((message) => (message.role === "user" && message.peer ? "letter" : message.role));
const keepCall: FakeReply = { toolCalls: [{ id: "call_keep", name: "keep", args: { hold: true } }] };

it("寄给闲着的会话：聚合后为它开一轮，消息带 peer，开头说明不是用户的话，同样的说明只写一遍", async () => {
	const { service, asker, target, done, letterOf } = await open([keepCall, { text: "读到了" }]);
	const letter = (await letterOf())!;
	const first = letter(target.id, { from: "问的 [aaaaaa]", text: "第一句", guide: "GUIDE" });
	const second = letter(target.id, { from: "问的 [aaaaaa]", text: "第二句", guide: "GUIDE" });
	expect(first.queued).toBe(false);
	expect(first.held).toBe(false);
	await done(target.id, 1);
	expect(await first.read).toEqual({ status: "read" });
	expect(await second.read).toEqual({ status: "read" });
	const delivered = (await service.getSession(target.id)).messages[0]!;
	expect(delivered).toMatchObject({
		role: "user",
		synthetic: true,
		peer: [
			{ id: first.id, sessionId: asker.id, from: "问的 [aaaaaa]", text: "第一句", cwd: dir },
			{ id: second.id, sessionId: asker.id, text: "第二句" },
		],
	});
	const text = words(delivered);
	expect(text).toContain("不是用户说的话");
	expect(text.match(/GUIDE/g)).toHaveLength(1);
	expect(text).toContain(`<session-message from="问的 [aaaaaa]" cwd="${dir}">\n第一句\n</session-message>`);
});

it("寄给忙着的会话：回执说排着，不另开一轮，在步骤边界读到", async () => {
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
	expect(receipt.queued).toBe(true);
	await done(target.id, 2);
	expect(await receipt.read).toEqual({ status: "read" });
	expect(shape((await service.getSession(target.id)).messages)).toEqual(["user", "assistant", "toolResult", "letter", "assistant"]);
});

it("收件方的人按停：攒着的信都留着、不叫醒它，人下一次开口时接在那句后面读到", async () => {
	const { service, target, done, letterOf } = await open([keepCall, { text: "答人" }]);
	const letter = (await letterOf())!;
	const before = letter(target.id, { from: "问的", text: "停之前" });
	service.stop(target.id);
	await new Promise((resolve) => setTimeout(resolve, 600));
	const idle = await service.getSession(target.id);
	expect(idle.messages).toEqual([]);
	expect(idle.summary.running).toBe(false);

	service.send(target.id, { content: [{ type: "text", text: "人开口" }] });
	await done(target.id, 1);
	expect(await before.read).toEqual({ status: "read" });
	const messages = (await service.getSession(target.id)).messages;
	expect(shape(messages)).toEqual(["user", "letter", "assistant"]);
	expect(messages[1]).toMatchObject({ peer: [{ text: "停之前" }] });
});

it("停下以后寄来的也不叫醒它：回执说留着，不显得在等后台，人开口时和停之前的一起读到、按先后排", async () => {
	const { service, target, done, letterOf } = await open([keepCall, { text: "答人" }]);
	const letter = (await letterOf())!;
	const kept = letter(target.id, { from: "问的", text: "停之前" });
	service.stop(target.id);
	const fresh = letter(target.id, { from: "问的", text: "停之后" });
	expect(fresh).toMatchObject({ queued: false, held: true });
	await new Promise((resolve) => setTimeout(resolve, 600));
	const idle = await service.getSession(target.id);
	expect(idle.messages).toEqual([]);
	expect(idle.summary.running).toBe(false);
	expect(idle.summary.background ?? false).toBe(false);

	service.send(target.id, { content: [{ type: "text", text: "人开口" }] });
	await done(target.id, 1);
	expect(await kept.read).toEqual({ status: "read" });
	expect(await fresh.read).toEqual({ status: "read" });
	expect((await service.getSession(target.id)).messages[1]).toMatchObject({ peer: [{ text: "停之前" }, { text: "停之后" }] });
});

it("读信的那一轮被插话打断：信留着，接在插话后面读到", async () => {
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
	const receipt = letter(target.id, { from: "问的", text: "一句话" });
	await vi.waitFor(async () => expect((await service.getSession(target.id)).summary.running).toBe(true));
	service.send(target.id, { content: [{ type: "text", text: "插话" }], interrupt: true });
	await done(target.id, 1);
	expect(await receipt.read).toEqual({ status: "read" });
	expect(shape((await service.getSession(target.id)).messages)).toEqual(["user", "letter", "assistant"]);
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

it("收件方归档了：攒着的、留着的信都是 closed，归档的会话不开一轮；寄给已归档的会话抛错", async () => {
	const { service, target, letterOf } = await open([keepCall, { text: "不该出现" }]);
	const letter = (await letterOf())!;
	// 还在凑批的窗口里就归档：不该为它开一轮。
	const pending = letter(target.id, { from: "问的", text: "刚寄出" });
	await service.setSessionArchived(target.id, true);
	expect(await pending.read).toEqual({ status: "closed" });
	await new Promise((resolve) => setTimeout(resolve, 600));
	expect((await service.getSession(target.id)).messages).toEqual([]);
	expect(() => letter(target.id, { from: "问的", text: "归档以后" })).toThrow("寄不到");
});

it("寄信的会话归档了：在跑的那一轮也不能再寄", async () => {
	const { service, asker, letterOf } = await open([keepCall]);
	const letter = (await letterOf())!;
	const other = await service.createSession({ cwd: dir });
	await service.setSessionArchived(asker.id, true);
	expect(() => letter(other.id, { from: "问的", text: "归档以后" })).toThrow("已经归档");
});

it("忙着时收到的信，收件方被按停又归档：信是 closed，不一直挂着", async () => {
	const { service, target, letterOf } = await open([keepCall, { toolCalls: [{ id: "call_gate", name: "gate", args: {} }] }, { text: "不该出现" }], (ctx) =>
		ctx.tools.register({
			name: "gate",
			description: "等",
			parameters: { type: "object", properties: {} },
			async execute(_args, run) {
				await new Promise((resolve) => run.signal.addEventListener("abort", resolve, { once: true }));
				return { output: "停了" };
			},
		}),
	);
	const letter = (await letterOf())!;
	service.send(target.id, { content: [{ type: "text", text: "做事" }] });
	await vi.waitFor(async () => expect((await service.getSession(target.id)).summary.running).toBe(true));
	const receipt = letter(target.id, { from: "问的", text: "插一句" });
	expect(receipt.queued).toBe(true);
	service.stop(target.id);
	await vi.waitFor(async () => expect((await service.getSession(target.id)).summary.running).toBe(false));
	await service.setSessionArchived(target.id, true);
	expect(await receipt.read).toEqual({ status: "closed" });
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

it("接连被信叫起十轮、人一句话也没说：第十一封不叫醒，对话里提示一句；人开口后接在那句后面读到，再从头数", async () => {
	let requests = 0;
	const { service, target, done, letterOf } = await open(() => (requests++ === 0 ? keepCall : { text: "读到了" }));
	const events: AgentEvent[] = [];
	const watching = new AbortController();
	void (async () => {
		for await (const event of service.watch({ signal: watching.signal })) events.push(event);
	})();
	const letter = (await letterOf())!;
	for (let round = 1; round <= 10; round++) {
		letter(target.id, { from: "问的", text: `第 ${round} 封` });
		await done(target.id, round);
	}
	const eleventh = letter(target.id, { from: "问的", text: "第 11 封" });
	expect(eleventh).toMatchObject({ queued: false, held: true });
	await vi.waitFor(() => expect(events.some((event) => event.type === "notice" && event.sessionId === target.id && event.level === "info")).toBe(true), {
		timeout: 5_000,
		interval: 10,
	});
	expect((await service.getSession(target.id)).summary.running).toBe(false);
	expect((await service.getSession(target.id)).summary.background ?? false).toBe(false);
	// 对方接着寄：照样留着，提示不再弹第二次。
	const notices = () => events.filter((event) => event.type === "notice" && event.sessionId === target.id && event.level === "info").length;
	const twelfth = letter(target.id, { from: "问的", text: "第 12 封" });
	await vi.waitFor(async () => expect((await service.getSession(target.id)).summary.background ?? false).toBe(false), { timeout: 5_000, interval: 10 });
	await new Promise((resolve) => setTimeout(resolve, 600));
	expect(notices()).toBe(1);

	service.send(target.id, { content: [{ type: "text", text: "人开口" }] });
	await done(target.id, 11);
	expect(await eleventh.read).toEqual({ status: "read" });
	expect(await twelfth.read).toEqual({ status: "read" });
	expect(shape((await service.getSession(target.id)).messages).slice(-3)).toEqual(["user", "letter", "assistant"]);
	letter(target.id, { from: "问的", text: "人开口之后" });
	await done(target.id, 12);
	watching.abort();
	// 每封信都要等聚合的那一小会儿（四百毫秒）才开一轮，十二轮加起来超过默认的五秒。
}, 15_000);

it("本来要收场的一轮因为信接着跑也算一轮：对方总赶在它收尾前寄到，十轮以后留到人开口，不在一轮里一直接着跑", async () => {
	let requests = 0;
	let sent = 0;
	let targetId = "";
	let post: ToolRun["letter"];
	const { service, target, letterOf } = await open(
		() => (requests++ === 0 ? keepCall : { text: "读到了" }),
		(ctx) =>
			ctx.hook("step.end", async (input, next) => {
				// 收件方每一步收尾前都刚好收到一封，等过凑批的窗口，循环最后那次看收件箱时就有攒好的一批。
				if (input.sessionId === targetId && post && sent < 12) {
					sent += 1;
					post(targetId, { from: "问的", text: `第 ${sent} 封` });
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
				return next(input);
			}),
	);
	const events: AgentEvent[] = [];
	const watching = new AbortController();
	void (async () => {
		for await (const event of service.watch({ signal: watching.signal })) events.push(event);
	})();
	post = (await letterOf())!;
	targetId = target.id;
	service.send(target.id, { content: [{ type: "text", text: "人开口" }] });
	// 人开口那一句一次回复，再为十封信各接着跑一步；第十一封留着，这一轮收场。
	await vi.waitFor(async () => expect((await service.getSession(target.id)).summary.stop).toEqual({ reason: "done" }), { timeout: 15_000, interval: 20 });
	const view = await service.getSession(target.id);
	expect(view.messages.filter((message) => message.role === "assistant")).toHaveLength(11);
	expect(sent).toBe(11);
	expect(events.some((event) => event.type === "notice" && event.sessionId === target.id && event.level === "info")).toBe(true);
	const letters = view.messages.flatMap((message) => (message.role === "user" && message.peer ? message.peer : []));
	expect(letters.map((letter) => letter.text)).toEqual(Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 封`));
	watching.abort();
	// 每封等过凑批的窗口（五百毫秒），十一封加起来超过默认的五秒。
}, 20_000);
