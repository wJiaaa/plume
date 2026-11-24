import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BackgroundChannel, Plugin, SessionAccess, SessionRun, TurnCause } from "@plume/contract";
import { createAgent, type Agent } from "../src/agent.ts";
import { fakeAnthropic, type FakeModel, type FakeReply } from "../src/testing.ts";
import { promptCause, reportsCause } from "../src/session/turn-cause.ts";
import { userMessage } from "../src/session/session.ts";

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

/** 请求里最后一段回复之后的那几条（人的话、工具结果、送达、`<env>`）：它们的字、它们答的那几次调用。 */
function last(request: Record<string, unknown>): { text: string; results: string[] } {
	const messages = request.messages as Array<{ role: string; content: unknown }>;
	const from = messages.findLastIndex((message) => message.role === "assistant") + 1;
	const blocks = messages
		.slice(from)
		.flatMap(
			(message) => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content) as Array<Record<string, unknown>>,
		);
	const text = blocks.flatMap((block) => (block.type === "text" ? [String(block.text)] : [])).join("\n");
	return {
		text: text.replace(/<env>[\s\S]*?<\/env>/g, ""),
		results: blocks.flatMap((block) => (block.type === "tool_result" ? [String(block.tool_use_id)] : [])),
	};
}

/**
 * 假模型按最后一条消息里的字调工具：说到哪个工具名就调哪个，读到交回的汇报、插话时调 `probe`，只有工具结果时收场。
 * 工具 `probe` 记下这次调用看到的 `session.cause`。
 */
async function open() {
	dir = await mkdtemp(join(tmpdir(), "plume-cause-"));
	let calls = 0;
	const call = (name: string): FakeReply => ({ toolCalls: [{ id: `${name}_${++calls}`, name, args: {} }] });
	model = await fakeAnthropic((request) => {
		const { text, results } = last(request);
		if (text.includes("我插一句") || text.includes("session-report")) return call("probe");
		if (results.length > 0 && !text.trim()) return { text: "好" };
		if (text.includes("do:stream")) return { text: "写".repeat(60), stream: { chunkSize: 1, delayMs: 20 } };
		for (const name of ["probe", "slow", "spawn", "mail", "dispatch", "channel"]) if (text.includes(`do:${name}`)) return call(name);
		return { text: "好" };
	});
	const seen: Array<{ sessionId: string; cause: TurnCause | undefined }> = [];
	let sessions!: SessionAccess;
	let target = "";
	let gate = Promise.withResolvers<void>();
	const runs: SessionRun[] = [];
	const channels: BackgroundChannel[] = [];
	const plugin: Plugin = {
		name: "test.cause",
		apply(ctx) {
			sessions = ctx.sessions;
			const tool = (name: string, execute: Parameters<typeof ctx.tools.register>[0]["execute"]) =>
				ctx.tools.register({ name, description: name, parameters: { type: "object", properties: {} }, execute });
			tool("probe", async (_args, run) => {
				seen.push({ sessionId: run.sessionId, cause: run.session.cause });
				return { output: "看到了" };
			});
			tool("slow", async () => {
				await gate.promise;
				return { output: "慢的做完了" };
			});
			tool("spawn", async (_args, run) => {
				await ctx.sessions.launch({ cwd: dir, message: "子会话的事", spawnedFrom: { sessionId: run.sessionId, toolCallId: run.toolCallId, reportBack: true } });
				return { output: "开了" };
			});
			tool("mail", async (_args, run) => {
				run.letter!(target, { from: "寄信的", text: "do:probe" });
				return { output: "寄了" };
			});
			tool("dispatch", async (_args, run) => {
				const child = await ctx.sessions.create({ parentId: run.sessionId });
				runs.push(await ctx.sessions.start(child.id, "子 Agent 的事"));
				return { output: "派出去了" };
			});
			tool("channel", async (_args, run) => {
				channels.push(run.background!());
				return { output: "留着渠道" };
			});
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
			{ modelId: "fake", name: "fake", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages: true, supportsTools: true },
		],
	});
	const say = (sessionId: string, text: string) => service.send(sessionId, { content: [{ type: "text", text }] });
	const probed = (count: number) => vi.waitFor(() => expect(seen).toHaveLength(count), { timeout: 5_000, interval: 10 });
	const idle = (sessionId: string) =>
		vi.waitFor(async () => expect((await service.getSession(sessionId)).summary.running).toBe(false), { timeout: 5_000, interval: 10 });
	return {
		service,
		sessions: () => sessions,
		seen,
		say,
		probed,
		idle,
		runs,
		channels,
		setTarget: (id: string) => void (target = id),
		open: () => gate.resolve(),
		closeGate: () => void (gate = Promise.withResolvers<void>()),
	};
}

it("人说的、插件开出来的第一句、代管插件转来的：各自记下是谁引起的", async () => {
	const { service, sessions, seen, say, probed, idle } = await open();
	const mine = await service.createSession({ cwd: dir });
	say(mine.id, "人说：do:probe");
	await probed(1);
	expect(seen[0]).toEqual({ sessionId: mine.id, cause: { by: "human" } });

	const launched = await sessions().launch({ cwd: dir, message: "开出来：do:probe" });
	await probed(2);
	expect(seen[1]).toEqual({ sessionId: launched.session.id, cause: { by: "launch", plugin: "test.cause" } });

	const stewarded = await sessions().launch({ cwd: dir, message: "代管的第一句", steward: true });
	await idle(stewarded.session.id);
	await sessions().post(stewarded.session.id, "转来：do:probe");
	await probed(3);
	expect(seen[2]).toEqual({ sessionId: stewarded.session.id, cause: { by: "steward", plugin: "test.cause" } });
});

it("别的会话的信叫起的、开出去的会话交回叫起的：记着是哪个会话", async () => {
	const { service, seen, say, probed, setTarget } = await open();
	const asker = await service.createSession({ cwd: dir });
	const target = await service.createSession({ cwd: dir });
	setTarget(target.id);
	say(asker.id, "do:mail");
	await probed(1);
	expect(seen[0]).toEqual({ sessionId: target.id, cause: { by: "peer", from: asker.id } });

	const origin = await service.createSession({ cwd: dir });
	say(origin.id, "do:spawn");
	await probed(2);
	const child = service.listSessions().find((summary) => summary.spawnedFrom?.sessionId === origin.id)!;
	expect(seen[1]).toEqual({ sessionId: origin.id, cause: { by: "report", from: child.id } });
});

it("自己派出去的事回来叫起的一轮沿用派它的那一轮；收尾时没在等的渠道送来的算运行时的事", async () => {
	const { service, sessions, seen, say, probed, idle, runs, channels } = await open();
	const mine = await service.createSession({ cwd: dir });
	say(mine.id, "do:dispatch");
	await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 5_000, interval: 10 });
	await sessions().wait(runs[0]!.id);
	await idle(mine.id);
	await sessions().report(runs[0]!.id, "子 Agent 回来了：do:probe");
	await probed(1);
	expect(seen[0]).toEqual({ sessionId: mine.id, cause: { by: "human" } });

	const other = await service.createSession({ cwd: dir });
	say(other.id, "do:channel");
	await vi.waitFor(() => expect(channels).toHaveLength(1), { timeout: 5_000, interval: 10 });
	await idle(other.id);
	channels[0]!.report("监视到了：do:probe");
	await probed(2);
	expect(seen[1]).toEqual({ sessionId: other.id, cause: { by: "runtime" } });
});

it("一轮中途人插话：这一轮从那时起算人的，之后的调用看到的是新的", async () => {
	const { service, sessions, seen, probed, open: release } = await open();
	const launched = await sessions().launch({ cwd: dir, message: "开出来：do:slow" });
	await vi.waitFor(async () => expect((await service.getSession(launched.session.id)).summary.running).toBe(true), { timeout: 5_000, interval: 10 });
	service.send(launched.session.id, { content: [{ type: "text", text: "我插一句" }], steer: true });
	release();
	await probed(1);
	expect(seen[0]).toEqual({ sessionId: launched.session.id, cause: { by: "human" } });
});

it("人插话和一封信一起在收尾时读进：这一轮仍算人的", async () => {
	const { service, sessions, seen, say, probed, idle, setTarget } = await open();
	const launched = await sessions().launch({ cwd: dir, message: "开出来：do:stream" });
	await vi.waitFor(async () => expect((await service.getSession(launched.session.id)).summary.running).toBe(true), { timeout: 5_000, interval: 10 });
	setTarget(launched.session.id);
	const asker = await service.createSession({ cwd: dir });
	say(asker.id, "do:mail");
	await idle(asker.id);
	service.send(launched.session.id, { content: [{ type: "text", text: "我插一句" }], steer: true });
	await probed(1);
	expect(seen[0]).toEqual({ sessionId: launched.session.id, cause: { by: "human" } });
});

it("怎么算：界面的「继续」、侧边聊天交来的算人；子会话、独立会话里的都算运行时；送达里信先于交回、交回先于自己的事", () => {
	const none = { has: () => false };
	const top = { kind: "top" as const, launchedBy: undefined };
	const words = [{ type: "text" as const, text: "x" }];
	expect(promptCause(userMessage({ content: words, synthetic: true }), top, none)).toEqual({ by: "human" });
	expect(promptCause({ ...userMessage({ content: words }), origin: "child" as const }, top, none)).toEqual({ by: "human" });
	expect(promptCause(userMessage({ content: words }), { kind: "child", launchedBy: undefined }, none)).toEqual({ by: "runtime" });
	expect(promptCause(userMessage({ content: words }), { kind: "standalone", launchedBy: undefined }, none)).toEqual({ by: "runtime" });
	const letter = { letter: { peer: { sessionId: "a", from: "a", text: "x" }, settle() {} }, valid: () => true };
	const report = { text: "r", delivery: { id: "d", plugin: "p", title: "t", status: "done" as const, sessionId: "c" }, valid: () => true };
	const own = { text: "o", valid: () => true };
	const previous: TurnCause = { by: "launch", plugin: "p" };
	expect(reportsCause([own, report, letter], previous, true)).toEqual({ by: "peer", from: "a" });
	expect(reportsCause([own, report], previous, true)).toEqual({ by: "report", from: "c" });
	expect(reportsCause([own], previous, true)).toEqual(previous);
	expect(reportsCause([own], previous, false)).toEqual({ by: "runtime" });
	expect(reportsCause([own], undefined, true)).toEqual({ by: "runtime" });
});
