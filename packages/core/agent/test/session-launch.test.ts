import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Plugin, PluginContext, SessionAccess, ToolRun } from "@plume/contract";
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
	return { service, sessions: () => sessions };
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

it("项目、模型、标题、来处都能带上；第一轮出错时 done 交回原因", async () => {
	const { service, sessions } = await open([{ status: 401 }]);
	const project = await service.createProject("仓库", dir);
	const source = await service.createSession({ cwd: dir });
	const { session, done } = await sessions().launch({
		project: project.id,
		message: "按计划做",
		model: (await sessions().models()).find((entry) => entry.name === "other")!.id,
		title: "  执行 计划  ",
		spawnedFrom: { sessionId: source.id, toolCallId: "call_plan" },
	});
	expect(session).toMatchObject({ project: project.id, cwd: dir, title: "执行 计划", spawnedFrom: { sessionId: source.id, toolCallId: "call_plan" } });
	expect(session.model).toMatch(/\/other$/);
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

it("只开新的：目录、项目、模型、来处不对都抛错，不开出半个会话", async () => {
	const { service, sessions } = await open([{ text: "x" }]);
	const before = service.listSessions().length;
	await expect(sessions().launch({ cwd: dir, message: "  " })).rejects.toThrow("消息不能为空");
	await expect(sessions().launch({ cwd: "relative/dir", message: "做" })).rejects.toThrow("不是已有目录的绝对路径");
	await expect(sessions().launch({ cwd: join(dir, "missing"), message: "做" })).rejects.toThrow("不是已有目录的绝对路径");
	await expect(sessions().launch({ project: "nope", message: "做" })).rejects.toThrow();
	await expect(sessions().launch({ cwd: dir, message: "做", model: "nope/none" })).rejects.toThrow();
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

/** 来处会话里先有一次本插件工具（`suggest`）的调用 `call_1`：交回只认这样的来处。 */
async function withSuggestion(replies: FakeReply[]) {
	const opened = await open([{ toolCalls: [{ id: "call_1", name: "suggest", args: {} }] }, { text: "建议好了" }, ...replies], (ctx) =>
		ctx.tools.register({ name: "suggest", description: "提建议", parameters: { type: "object", properties: {} }, execute: async () => ({ output: "好" }) }),
	);
	const source = await opened.service.createSession({ cwd: dir });
	opened.service.send(source.id, { content: [{ type: "text", text: "看看" }] });
	await vi.waitFor(async () => expect((await opened.service.getSession(source.id)).summary.stop).toEqual({ reason: "done" }), { timeout: 5_000, interval: 10 });
	return { ...opened, source };
}

it("reportBack 把结果交回开出它的会话：画成「来自新会话」的送达，叫起那个会话一轮，只交一次", async () => {
	const { service, sessions, source } = await withSuggestion([{ text: "新会话做完了" }, { text: "收到交回的结果" }]);
	const launched = await sessions().launch({ cwd: dir, message: "去做", title: "清理死代码", spawnedFrom: { sessionId: source.id, toolCallId: "call_1" } });
	expect(await launched.idle).toEqual({ stop: { reason: "done" }, reply: "新会话做完了" });
	// 人按停过的会话也为交回开一轮：这是一件新的事。
	service.stop(source.id);
	expect(launched.reportBack("它说：做完了", "failed")).toBe(true);
	expect(launched.reportBack("再交一次", "done")).toBe(false);
	await vi.waitFor(
		async () => {
			const view = await service.getSession(source.id);
			expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant", "user", "assistant"]);
			expect(view.summary.running).toBe(false);
		},
		{ timeout: 5_000, interval: 10 },
	);
	const delivered = (await service.getSession(source.id)).messages[4];
	expect(delivered).toMatchObject({
		role: "user",
		synthetic: true,
		delivery: [{ id: launched.session.id, kind: "session", agent: "", description: "清理死代码", status: "failed" }],
	});
	const words = JSON.stringify(delivered?.content);
	expect(words).toContain("不是用户说的话");
	expect(words).toContain("它说：做完了");
});

it("reportBack 只认本插件工具的调用当来处：填别的会话、别的调用 id 抛错，停用以后也抛错", async () => {
	const { service, sessions, source } = await withSuggestion([{ text: "a" }, { text: "b" }]);
	const other = await service.createSession({ cwd: dir });
	const forged = await sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: other.id, toolCallId: "call_1" } });
	await forged.idle;
	expect(() => forged.reportBack("结果", "done")).toThrow("不是本插件的工具");
	const legit = await sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: source.id, toolCallId: "call_1" } });
	await legit.idle;
	await service.setPluginEnabled("test.launcher", false);
	expect(() => legit.reportBack("结果", "done")).toThrow("已停用");
	expect((await service.getSession(other.id)).messages).toEqual([]);
});

it("reportBack 不送：没有来处、来处归档了或删了，空话和不认识的 status 抛错", async () => {
	const { service, sessions } = await open([{ text: "a" }, { text: "b" }, { text: "c" }]);
	const plain = await sessions().launch({ cwd: dir, message: "做" });
	await plain.done;
	expect(plain.reportBack("结果", "done")).toBe(false);

	const archived = await service.createSession({ cwd: dir });
	const fromArchived = await sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: archived.id } });
	await fromArchived.done;
	await sessions().setArchived(archived.id, true);
	expect(() => fromArchived.reportBack("  ", "done")).toThrow("消息不能为空");
	expect(() => fromArchived.reportBack("结果", "aborted" as "done")).toThrow("done 或 failed");
	expect(fromArchived.reportBack("结果", "done")).toBe(false);

	const deleted = await service.createSession({ cwd: dir });
	const fromDeleted = await sessions().launch({ cwd: dir, message: "做", spawnedFrom: { sessionId: deleted.id } });
	await fromDeleted.done;
	await service.deleteSession(deleted.id);
	expect(fromDeleted.reportBack("结果", "done")).toBe(false);
	expect((await service.getSession(archived.id)).messages).toEqual([]);
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
