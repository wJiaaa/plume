/**
 * 压缩经宿主走一遍：从主请求分叉（前缀核对、退回独立请求）、一轮收尾后的压缩、`/compact`、剪枝视图重开以后照发、
 * 转录里那一行压缩的收场。用产品带的内置插件和假模型，量的是线上真正发出去的请求体。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentEvent, ContextCompact, Plugin } from "@plume/contract";
import { compactionTriggerTokens } from "../../../builtin/compaction/src/budget.ts";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, type FakeReply, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string;
let workspace: string;
let model: FakeModel | undefined;
let agent: Agent | undefined;
let watching = new AbortController();

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-compaction-"));
	workspace = join(dir, "workspace");
	await mkdir(workspace);
	await writeFile(join(workspace, "hello.txt"), "hello\n");
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

/** 起（或重开）一个 agent；`replies` 给了就换一个新的假模型。 */
async function boot(plugins: Plugin[] = [], replies?: FakeReply[] | ((request: Record<string, unknown>, index: number) => FakeReply)) {
	if (replies !== undefined) model = await fakeAnthropic(replies);
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [...BUILTINS, ...plugins.map((plugin) => ({ key: plugin.name, load: async () => plugin }))],
		log: () => undefined,
	});
	const service = agent.service;
	const events: AgentEvent[] = [];
	const waiters = new Set<() => void>();
	void (async () => {
		for await (const event of service.watch({ signal: watching.signal })) {
			events.push(event);
			for (const waiter of waiters) waiter();
		}
	})();
	const until = <E extends AgentEvent>(match: (event: AgentEvent) => event is E, from = 0): Promise<E> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("等待事件超时")), 5_000);
			const check = () => {
				const found = events.slice(from).find(match);
				if (!found) return;
				clearTimeout(timer);
				waiters.delete(check);
				resolve(found);
			};
			waiters.add(check);
			check();
		});
	// 先等到这个会话跑起来，再等全部停下：订阅早于建会话，之前的事件可能晚到，单等「都没在跑」会提前放行。
	const ask = async (sessionId: string, text: string) => {
		const from = events.length;
		service.send(sessionId, { content: [{ type: "text", text }] });
		const started = await until(
			(event): event is AgentEvent => event.type === "sessions" && event.sessions.some((summary) => summary.id === sessionId && summary.running),
			from,
		);
		await until((event): event is AgentEvent => event.type === "sessions" && event.sessions.every((summary) => !summary.running), events.indexOf(started) + 1);
	};
	return { service, events, until, ask };
}

async function start(plugins: Plugin[], replies: FakeReply[] | ((request: Record<string, unknown>, index: number) => FakeReply)) {
	const booted = await boot(plugins, replies);
	await booted.service.saveProvider({
		id: "",
		name: "假模型",
		api: "anthropic-messages",
		baseUrl: model!.url,
		enabled: true,
		models: ["fake", "other"].map((modelId) => ({
			modelId,
			name: modelId,
			contextWindow: 200_000,
			maxOutputTokens: 32_000,
			supportsThinking: false,
			supportsImages: false,
			supportsTools: true,
		})),
		apiKey: "test-key",
	});
	const session = await booted.service.createSession({ cwd: workspace });
	return { ...booted, session };
}

/**
 * 一轮收尾后的那次问话里，把窗口收到「刚好越过触发线、还放得下一份分叉的摘要」：假模型报的用量是请求体长度折算的，
 * 定不准一个固定的窗口。只动 `idle` 的那次（前 `times` 次）：请求前的检查照常按 200k 量，不会先压掉。
 */
function squeezeWhenIdle(times = Number.POSITIVE_INFINITY): Plugin {
	return {
		name: "test.squeeze",
		apply(ctx) {
			ctx.hook("context.compact", async (input, next) => (input.idle && times-- > 0 ? next(squeezed(input)) : next(input)));
		},
	};
}

function squeezed(input: ContextCompact): ContextCompact {
	const used = input.usage.tokens;
	let window = used;
	while (compactionTriggerTokens(window + 500) < used) window += 500;
	// 触发线在 used 以下，窗口比 used 多出一份摘要回复再加分叉指令的位置。
	window = Math.max(window, used + 9500);
	while (compactionTriggerTokens(window) >= used) window -= 100;
	return { ...input, model: { ...input.model, contextWindow: window } };
}

const sentText = (request: Record<string, unknown> | undefined) => JSON.stringify(request?.messages ?? []);
/** 去掉协议放的缓存断点：它跟着最后一条消息挪，不算内容。 */
const withoutBreakpoints = (value: unknown) => JSON.parse(JSON.stringify(value), (key, item) => (key === "cache_control" ? undefined : item)) as unknown;
const longText = (mark: string) => `${mark} ${"需要记住的背景说明。".repeat(3500)}`;
const read = (id: string) => ({ id, name: "read", args: { path: "hello.txt" } });

it("一轮收尾、缓存还热时从主请求分叉压缩：系统提示词、工具原样，上一次的消息打头，末尾一条指令", async () => {
	const { service, session, ask } = await start(
		[squeezeWhenIdle()],
		[{ toolCalls: [read("c1")] }, { text: "一" }, { toolCalls: [read("c2")] }, { text: "二" }, { text: "FORK_SUMMARY" }, { text: "三" }],
	);
	await ask(session.id, longText("第一件"));
	await ask(session.id, longText("第二件"));
	// 收尾的压缩占着会话，压完才放开；放开后 `idle` 才等到。
	expect(model!.requests).toHaveLength(5);
	const [main, fork] = [model!.requests[3]!, model!.requests[4]!];
	for (const field of ["model", "tools", "system", "thinking", "max_tokens", "metadata"]) expect(fork[field], field).toEqual(main[field]);
	const mainMessages = main.messages as unknown[];
	const forkMessages = fork.messages as unknown[];
	expect(forkMessages.length).toBeGreaterThan(mainMessages.length);
	mainMessages.forEach((message, index) => expect(withoutBreakpoints(forkMessages[index]), `messages[${index}]`).toEqual(withoutBreakpoints(message)));
	expect(JSON.stringify(forkMessages.at(-1))).toMatch(/Do not call any tools/);
	expect(JSON.stringify(forkMessages.at(-1))).toMatch(/Treat the conversation above/);

	const view = await service.getSession(session.id);
	expect(view.compactionRuns).toMatchObject([{ status: "done", code: "done", via: "fork", idle: true, at: 8 }]);
	expect(view.summary.running).toBe(false);
	expect(view.summary.stop).toEqual({ reason: "done" });

	await ask(session.id, "继续");
	expect(sentText(model!.requests[5])).toContain("<session-summary>\\nFORK_SUMMARY");
});

it("前缀对不上的分叉不发出去，摘要改走独立请求", async () => {
	let turn = 0;
	// 每次组请求都改写开头那条：上一次发出去的不再是这一次的前缀（分叉沿用上一次的系统提示词，改它拦不住）。
	const drift: Plugin = {
		name: "test.drift",
		apply(ctx) {
			ctx.hook("model.context", async (input, next) =>
				next({ ...input, messages: [{ role: "user", content: [{ type: "text", text: `第 ${++turn} 次组请求` }], timestamp: 0 }, ...input.messages] }),
			);
		},
	};
	const replies: FakeReply[] = [{ toolCalls: [read("c1")] }, { text: "一" }, { toolCalls: [read("c2")] }, { text: "二" }];
	const { service, session, ask } = await start([squeezeWhenIdle(), drift], (request, index) => {
		if (JSON.stringify(request.system ?? "").includes("handover summaries")) return { text: "INDEPENDENT_SUMMARY" };
		return replies[index] ?? { text: "三" };
	});
	await ask(session.id, longText("第一件"));
	await ask(session.id, longText("第二件"));

	const after = model!.requests.slice(4);
	expect(after.length).toBeGreaterThan(0);
	for (const body of after) {
		expect(body.tools).toBeUndefined();
		expect(JSON.stringify(body.system)).toContain("handover summaries");
	}
	expect((await service.getSession(session.id)).compactionRuns).toMatchObject([{ status: "done", via: "independent", idle: true }]);
});

it("分叉的回复调了工具：丢掉，改走独立请求", async () => {
	const replies: FakeReply[] = [{ toolCalls: [read("c1")] }, { text: "一" }, { toolCalls: [read("c2")] }, { text: "二" }, { toolCalls: [read("c3")] }];
	const { service, session, ask } = await start([squeezeWhenIdle()], (request, index) => {
		if (JSON.stringify(request.system ?? "").includes("handover summaries")) return { text: "INDEPENDENT_SUMMARY" };
		return replies[index] ?? { text: "三" };
	});
	await ask(session.id, longText("第一件"));
	await ask(session.id, longText("第二件"));

	expect(model!.requests[4]?.tools).toBeDefined();
	for (const body of model!.requests.slice(5)) expect(body.tools).toBeUndefined();
	const view = await service.getSession(session.id);
	expect(view.compactionRuns).toMatchObject([{ status: "done", via: "independent" }]);
	// 分叉回复里的工具调用不进会话。按调用的 id 比，不在整段 JSON 里找 "c3"：随机的供应商 id（`p-c389e538`）也会含它。
	const callIds = view.messages.flatMap((message) =>
		message.role === "assistant" ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) : [],
	);
	expect(callIds).toEqual(["c1", "c2"]);
});

it("/compact：带着说明从主请求分叉写摘要，转录里一行 /compact 和它的结果；太短、正在跑时说清楚", async () => {
	const replies: FakeReply[] = [
		{ toolCalls: [read("c1")] },
		{ text: "一" },
		{ toolCalls: [read("c2")] },
		{ text: "二" },
		{ text: "MANUAL_SUMMARY" },
		// 摘要过的原文经 recall 从会话里读回来。
		{ toolCalls: [{ id: "r1", name: "recall", args: { query: "读一下" } }] },
		{ text: "三" },
	];
	const { service, session, ask, until } = await start([], replies);
	const short = await service.createSession({ cwd: workspace });

	// 还没有消息的对话：太短。
	expect(await service.expandCommand("plume.compaction", "compact", "", { sessionId: short.id })).toEqual({ handled: true });
	await until(
		(event): event is AgentEvent => event.type === "compaction" && event.sessionId === short.id && event.runs.some((run) => run.status !== "running"),
	);
	expect((await service.getSession(short.id)).compactionRuns).toMatchObject([{ input: "/compact", status: "skipped", code: "too-short" }]);

	// 摘要比要收起的原文还长时不压（已经够紧凑）：前面得有一段长的过去。
	await ask(session.id, longText("读一下"));
	await ask(session.id, longText("再读一下"));
	const from = model!.requests.length;
	expect(await service.expandCommand("plume.compaction", "compact", "保留决策", { sessionId: session.id })).toEqual({ handled: true });
	await until((event): event is AgentEvent => event.type === "compaction" && event.sessionId === session.id && event.runs.some((run) => run.status === "done"));

	const fork = model!.requests[from]!;
	expect(fork.tools).toEqual(model!.requests[from - 1]!.tools);
	expect(JSON.stringify((fork.messages as unknown[]).at(-1))).toContain("User-requested summary focus");
	expect(JSON.stringify((fork.messages as unknown[]).at(-1))).toContain("保留决策");
	const view = await service.getSession(session.id);
	expect(view.compactionRuns).toMatchObject([{ input: "/compact 保留决策", status: "done", code: "done", via: "fork", before: 8 }]);
	expect(view.compactions).toHaveLength(1);
	// 压缩不替人说话：会话里一条消息也没多。
	expect(view.messages).toHaveLength(8);

	await ask(session.id, "接着做");
	expect(sentText(model!.requests.at(-2))).toContain("<session-summary>\\nMANUAL_SUMMARY");
	const recalled = (await service.getSession(session.id)).messages.find((message) => message.role === "toolResult" && message.toolName === "recall");
	expect(JSON.stringify(recalled?.content)).toMatch(/--- message 0 · user · .*读一下 需要记住的背景说明/);
});

it("/compact 撞上正在跑的一轮：不压，话写在输入框上面", async () => {
	const { service, session, until } = await start([], [{ text: "写着", hang: true }]);
	service.send(session.id, { content: [{ type: "text", text: "写篇长文" }] });
	await until((event): event is AgentEvent => event.type === "draft" && event.draft !== undefined);
	await expect(service.expandCommand("plume.compaction", "compact", "", { sessionId: session.id })).rejects.toThrow("对话正在进行中");
	service.stop(session.id);
});

it("压缩剪过的工具结果记在会话库里：下一轮、重开应用以后都照剪过的那份发", async () => {
	const big: Plugin = {
		name: "test.big",
		apply(ctx) {
			ctx.tools.register({
				name: "big",
				description: "Return a lot of text",
				parameters: { type: "object", properties: { n: { type: "number" } } },
				execute: async (args) => ({ output: `${String(args.n)}`.repeat(30_000) }),
			});
		},
	};
	const calls = [1, 2, 3, 4].map((n) => ({ id: `b${n}`, name: "big", args: { n } }));
	// 只在第一轮收尾时收窄窗口：之后的几轮照常，不再压。
	const { service, session, ask } = await start([big, squeezeWhenIdle(1)], [{ toolCalls: calls }, { text: "找到了" }, { text: "好" }, { text: "又好" }]);
	await ask(session.id, "找一下");
	// 剪掉四个大结果就够了：不要摘要，只记下剪过的样子。
	expect(model!.requests).toHaveLength(2);
	expect((await service.getSession(session.id)).compactionRuns).toEqual([]);
	const stored = JSON.parse(
		new DatabaseSync(join(dir, "data/sessions/sessions.db"), { readOnly: true }).prepare("SELECT context FROM sessions WHERE id = ?").get(session.id)
			?.context as string,
	) as { views?: Record<string, string[]> };
	expect(Object.keys(stored.views ?? {}).sort()).toEqual(["b1", "b2", "b3", "b4"]);

	await ask(session.id, "然后呢");
	const results = (request: Record<string, unknown> | undefined) =>
		withoutBreakpoints(
			((request?.messages ?? []) as Array<{ content: unknown }>)
				.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
				.filter((block: { type?: string }) => block.type === "tool_result"),
		);
	const before = results(model!.requests[2]);
	expect(JSON.stringify(before)).toContain("characters omitted by Plume to fit the context window");
	expect(JSON.stringify(before)).toContain("artifact://");
	// 会话里存的仍是原文。
	const view = await service.getSession(session.id);
	expect(view.messages.filter((message) => message.role === "toolResult").every((message) => JSON.stringify(message.content).length > 30_000)).toBe(true);

	await agent!.shutdown();
	watching.abort();
	watching = new AbortController();
	const reopened = await boot([big, squeezeWhenIdle(0)]);
	await reopened.ask(session.id, "再来");
	expect(results(model!.requests[3])).toEqual(before);
});

it("重开以后还标着「进行中」的那一行压缩说成被中断，上一次的边界不动", async () => {
	const { service, session, ask } = await start([], [{ text: "好" }]);
	await ask(session.id, "你好");
	await agent!.shutdown();
	agent = undefined;
	const db = new DatabaseSync(join(dir, "data/sessions/sessions.db"));
	const run = { id: "r1", at: 2, startedAt: 1, status: "running", phase: "retrying", retries: 2 };
	db.prepare("UPDATE sessions SET context = ? WHERE id = ?").run(JSON.stringify({ compactions: [], withheld: [], runs: [run] }), session.id);
	db.close();
	watching.abort();
	watching = new AbortController();
	const reopened = await boot();
	const view = await reopened.service.getSession(session.id);
	expect(view.compactionRuns).toEqual([{ ...run, status: "cancelled", code: "cancelled" }]);
	expect(view.compactions).toEqual([]);
	void service;
});
