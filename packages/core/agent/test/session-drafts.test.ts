import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AssistantMessage, Plugin, PluginContext, SessionObservation } from "@plume/contract";
import { createAgent, type Agent, type AgentOptions } from "../src/agent.ts";
import { fakeAnthropic, type FakeModel, type FakeReply } from "../src/testing.ts";

/**
 * `ctx.sessions.observe(listener, { drafts: true })`：正在写的回复按请求推给订了的观察者，作废按请求说出来；没订的监听器照旧。
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

type Event = SessionObservation["event"];

/** 一个能放行的闸：假模型停在半路等它。 */
function gate() {
	let open!: () => void;
	const until = new Promise<void>((resolve) => (open = resolve));
	return { until, open };
}

const textOf = (message: AssistantMessage | undefined) => (message?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

/** 插件 `test.im` 订了草稿，`test.plain` 没订、只用原来的 `observe(listener)`，`test.other` 订了草稿但和这些会话无关。 */
async function open(replies: FakeReply[] | ((request: Record<string, unknown>, index: number) => FakeReply), options: Pick<AgentOptions, "retryPolicy"> = {}) {
	dir = await mkdtemp(join(tmpdir(), "plume-drafts-"));
	model = await fakeAnthropic(replies);
	const contexts = new Map<string, PluginContext>();
	const seen = new Map<string, SessionObservation[]>();
	const watcher = (name: string, drafts: boolean, extra: (ctx: PluginContext) => void = () => undefined): Plugin => ({
		name,
		apply(ctx) {
			contexts.set(name, ctx);
			seen.set(name, []);
			const listener = (observation: SessionObservation) => void seen.get(name)!.push(observation);
			if (drafts) ctx.sessions.observe(listener, { drafts: true });
			else ctx.sessions.observe(listener);
			extra(ctx);
		},
	});
	agent = await createAgent({
		...options,
		dataDir: dir,
		settingsFile: join(dir, "settings.json"),
		plugins: [
			watcher("test.im", true, (ctx) =>
				// 先登记的观察者抛错，不拦着同一个插件后登记的和别的插件的。
				ctx.sessions.observe(
					() => {
						throw new Error("坏掉的观察者");
					},
					{ drafts: true },
				),
			),
			watcher("test.plain", false),
			watcher("test.other", true),
		].map((plugin) => ({ key: plugin.name, load: async () => plugin })),
		log: () => undefined,
	});
	await agent.service.saveProvider({
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
	/** 这个插件收到的、这个会话的事件，按到达的先后。 */
	const events = (plugin: string, sessionId: string): Event[] =>
		seen
			.get(plugin)!
			.filter((observation) => observation.sessionId === sessionId)
			.map((observation) => observation.event);
	const drafts = (plugin: string, sessionId: string) =>
		events(plugin, sessionId).filter((event): event is Extract<Event, { type: "draft" }> => event.type === "draft");
	return { service: agent.service, ctx: (name: string) => contexts.get(name)!, events, drafts, seen };
}

/** 只留和回复有关的事件，写成好比较的样子。 */
const outline = (events: Event[]) =>
	events.flatMap((event) =>
		event.type === "request"
			? [`request ${event.id}`]
			: event.type === "draft"
				? [`draft ${event.id} ${event.draft ? "snapshot" : "void"}`]
				: event.type === "response"
					? [`response ${event.id}`]
					: event.type === "turnEnd"
						? [`turnEnd ${event.stop.reason}`]
						: [],
	);

/** 连续相同的几行并成一行：快照推几次跟节流有关，不比次数。 */
const squeeze = (lines: string[]) => lines.filter((line, index) => line !== lines[index - 1]);

it("第一段写完、后面还在生成时就推给订了草稿的插件，早于 response 和 send 返回；快照、正文块结束和最终回复按请求 id 对得上", async () => {
	const hold = gate();
	const first = "第一段讲完了。\n\n";
	const full = `${first}第二段在停顿之后才写。`;
	const { ctx, events, drafts } = await open([{ text: full, pause: { at: first.length, until: hold.until } }]);
	const im = ctx("test.im").sessions;
	const session = await im.create({ cwd: dir });
	let returned = false;
	const sent = im.send(session.id, "说两段").then((stop) => {
		returned = true;
		return stop;
	});

	// 模型停在第一段后面：插件已经拿到含第一段的快照，response 还没来，send 也没返回。
	await vi.waitFor(() => expect(textOf(drafts("test.im", session.id).at(-1)?.draft)).toBe(first), { timeout: 3_000, interval: 5 });
	expect(events("test.im", session.id).some((event) => event.type === "response")).toBe(false);
	expect(returned).toBe(false);

	hold.open();
	expect(await sent).toEqual({ reason: "done" });

	const seen = events("test.im", session.id);
	const request = seen.find((event) => event.type === "request")!;
	const response = seen.find((event): event is Extract<Event, { type: "response" }> => event.type === "response")!;
	expect(response.id).toBe(request.id);
	expect(squeeze(outline(seen))).toEqual([`request ${request.id}`, `draft ${request.id} snapshot`, `response ${request.id}`, "turnEnd done"]);
	// 每份快照都是整条（不是增量），一份比一份长，都是最终回复的开头；正文块写完的那份带 ended，最终回复不带。
	const texts = drafts("test.im", session.id).map((event) => textOf(event.draft));
	for (const [index, text] of texts.entries()) {
		expect(full.startsWith(text)).toBe(true);
		if (index > 0) expect(text.length).toBeGreaterThanOrEqual(texts[index - 1]!.length);
	}
	const last = drafts("test.im", session.id).at(-1)!.draft!;
	expect(textOf(last)).toBe(full);
	expect(last.content[0]).toMatchObject({ type: "text", ended: true });
	expect(textOf(response.reply)).toBe(full);
	expect(response.reply.content[0]).not.toHaveProperty("ended");
	// 已经发出去的第一段，收尾时按长度从 response 里扣掉就是还没发的。
	expect(textOf(response.reply).slice(first.length)).toBe("第二段在停顿之后才写。");
});

it("没订草稿的监听器照旧只收原来那些事件；订了草稿但和会话无关的插件收不到；没声明 all 也收得到自己建的会话的草稿", async () => {
	const { ctx, events, seen } = await open([{ text: "好的。" }]);
	const session = await ctx("test.im").sessions.create({ cwd: dir });
	await ctx("test.im").sessions.send(session.id, "问一句");
	const human = await agent!.service.createSession({ cwd: dir });
	agent!.service.send(human.id, { content: [{ type: "text", text: "人自己问" }] });
	await vi.waitFor(async () => expect((await agent!.service.getSession(human.id)).summary.stop).toEqual({ reason: "done" }));

	expect(events("test.im", session.id).some((event) => event.type === "draft")).toBe(true);
	// 订了草稿的插件看不到人的会话（没声明 all），也看不到别的插件建的会话。
	expect(seen.get("test.im")!.some((observation) => observation.sessionId === human.id)).toBe(false);
	expect(seen.get("test.other")!).toEqual([]);
	// test.plain 自己建一个会话：收得到 request、response、turnEnd，收不到 draft。
	const plain = await ctx("test.plain").sessions.create({ cwd: dir });
	await ctx("test.plain").sessions.send(plain.id, "问一句");
	const types = events("test.plain", plain.id).map((event) => event.type);
	expect(types).toEqual(expect.arrayContaining(["request", "response", "turnEnd"]));
	expect(types).not.toContain("draft");
	// 草稿里没有供应商配置和 key。
	expect(JSON.stringify(seen.get("test.im"))).not.toContain("private-test-key");
});

it("两个会话同时生成：草稿各归各的会话、各有自己的请求 id，不串", async () => {
	const holds = { 甲: gate(), 乙: gate() };
	const { ctx, drafts, events } = await open((request) => {
		const name = JSON.stringify(request.messages).includes("甲") ? "甲" : "乙";
		const first = `${name}的第一段。\n\n`;
		return { text: `${first}${name}的第二段。`, pause: { at: first.length, until: holds[name].until } };
	});
	const im = ctx("test.im").sessions;
	const a = await im.create({ cwd: dir });
	const b = await im.create({ cwd: dir });
	const sentA = im.send(a.id, "甲");
	const sentB = im.send(b.id, "乙");
	await vi.waitFor(() => {
		expect(textOf(drafts("test.im", a.id).at(-1)?.draft)).toBe("甲的第一段。\n\n");
		expect(textOf(drafts("test.im", b.id).at(-1)?.draft)).toBe("乙的第一段。\n\n");
	});
	holds.乙.open();
	await sentB;
	holds.甲.open();
	await sentA;

	for (const [session, name, other] of [
		[a, "甲", "乙"],
		[b, "乙", "甲"],
	] as const) {
		const ids = new Set(events("test.im", session.id).flatMap((event) => ("id" in event ? [event.id] : [])));
		expect(ids.size).toBe(1);
		for (const event of drafts("test.im", session.id)) expect(textOf(event.draft)).not.toContain(other);
		const response = events("test.im", session.id).find((event) => event.type === "response");
		expect(response?.type === "response" && textOf(response.reply)).toBe(`${name}的第一段。\n\n${name}的第二段。`);
	}
	const idOf = (sessionId: string) => drafts("test.im", sessionId)[0]!.id;
	expect(idOf(a.id)).not.toBe(idOf(b.id));
});

it("连接断在半路重试：同一个 id 先作废、再从空的重新推，最终回复是重写的那条", async () => {
	const { ctx, drafts, events } = await open([{ text: "断掉之前写的一段。\n\n", cut: true }, { text: "重新写的一段。" }], {
		retryPolicy: {
			network: { retries: 2, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
			upstream: { retries: 2, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
		},
	});
	const im = ctx("test.im").sessions;
	const session = await im.create({ cwd: dir });
	expect(await im.send(session.id, "说一段")).toEqual({ reason: "done" });

	const seen = events("test.im", session.id);
	const id = seen.find((event) => event.type === "request")!.id;
	expect(squeeze(outline(seen))).toEqual([
		`request ${id}`,
		`draft ${id} snapshot`,
		`draft ${id} void`,
		`draft ${id} snapshot`,
		`response ${id}`,
		"turnEnd done",
	]);
	const all = drafts("test.im", session.id);
	const voided = all.findIndex((event) => !event.draft);
	expect(all.slice(0, voided).some((event) => textOf(event.draft).includes("断掉之前"))).toBe(true);
	expect(all.slice(voided + 1).every((event) => !textOf(event.draft).includes("断掉之前"))).toBe(true);
	const response = seen.find((event) => event.type === "response");
	expect(response?.type === "response" && textOf(response.reply)).toBe("重新写的一段。");
});

it("写到一半被停下：停下的回复照样以 response 给出、写进会话，不作废；一轮以 aborted 收场", async () => {
	const { ctx, drafts, events } = await open([{ text: "写到一半。\n\n", hang: true }]);
	const im = ctx("test.im").sessions;
	const session = await im.create({ cwd: dir });
	const sent = im.send(session.id, "说一段");
	await vi.waitFor(() => expect(textOf(drafts("test.im", session.id).at(-1)?.draft)).toBe("写到一半。\n\n"));
	im.stop(session.id);
	expect(await sent).toEqual({ reason: "aborted" });

	const seen = events("test.im", session.id);
	const id = seen.find((event) => event.type === "request")!.id;
	expect(squeeze(outline(seen))).toEqual([`request ${id}`, `draft ${id} snapshot`, `response ${id}`, "turnEnd aborted"]);
	const response = seen.find((event) => event.type === "response");
	expect(response?.type === "response" && response.reply.stopReason).toBe("aborted");
	const stored = (await im.messages(session.id)).at(-1);
	expect(stored?.role === "assistant" && textOf(stored)).toBe("写到一半。\n\n");
});

it("断线后不再重试、以出错收场：出错的回复照样以 response 给出，草稿不作废，一轮以 error 收场", async () => {
	const { ctx, events } = await open([{ text: "只写出这一截。", cut: true }], {
		retryPolicy: {
			network: { retries: 0, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
			upstream: { retries: 0, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
		},
	});
	const im = ctx("test.im").sessions;
	const session = await im.create({ cwd: dir });
	const stop = await im.send(session.id, "说一段");
	expect(stop.reason).toBe("error");

	const seen = events("test.im", session.id);
	const id = seen.find((event) => event.type === "request")!.id;
	expect(squeeze(outline(seen))).toEqual([`request ${id}`, `draft ${id} snapshot`, `response ${id}`, "turnEnd error"]);
	const response = seen.find((event) => event.type === "response");
	expect(response?.type === "response" && response.reply.stopReason).toBe("error");
});

it("插件停用后不再收到草稿", async () => {
	const hold = gate();
	const { ctx, service, drafts } = await open([{ text: "第一段。\n\n第二段。", pause: { at: 6, until: hold.until } }, { text: "又一句。" }]);
	const im = ctx("test.im").sessions;
	const session = await im.create({ cwd: dir });
	const sent = im.send(session.id, "说两段");
	await vi.waitFor(() => expect(drafts("test.im", session.id).length).toBeGreaterThan(0));
	await service.setPluginEnabled("test.im", false);
	const count = drafts("test.im", session.id).length;
	hold.open();
	await sent.catch(() => undefined);
	expect(drafts("test.im", session.id).length).toBe(count);
});
