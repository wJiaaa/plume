import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { LaunchedSession, Message, PluginContext, SessionKind, SessionLaunch, SessionSummary, ToolDefinition, ToolRun, TurnCause } from "@plume/contract";
import type { SpawnSessionApi, StartedSuggestion } from "../src/api.ts";
import { checkSpawn } from "../src/check.ts";
import plugin from "../src/index.ts";
import { environmentStatus } from "../src/state.ts";

const BACKGROUND =
	"这是背景：我们在把 CLI 的参数解析换成新的库，已经定了不改对外的命令名，测试要跟着改，旧的解析代码要删干净。这一块只是整个迁移里的一步：别的会话在改文档和发版脚本，这里不要碰它们，做完在自己的分支上提交。";

it("参数校验：三种发起方式、fresh 要够长的背景、fork 不要、短名从标题取或照规矩核", () => {
	expect(checkSpawn({ initiation: "offer", title: " 清理死代码 " })).toEqual({ kind: "offer", title: "清理死代码" });
	expect(checkSpawn({ initiation: "user_asked", title: "Clean up CLI", prompt: "删掉 a.ts", background: BACKGROUND })).toEqual({
		kind: "now",
		briefing: {
			title: "Clean up CLI",
			name: "clean-up-cli",
			message: `Background (from the session that started this one):\n${BACKGROUND}\n\nTask:\n删掉 a.ts`,
		},
	});
	// 标题里取不出拉丁字母时不起名。
	expect(checkSpawn({ initiation: "user_asked", title: "清理", prompt: "p", context: "fork" })).toEqual({
		kind: "now",
		briefing: { title: "清理", message: "p", fork: true },
	});
	expect(checkSpawn({ initiation: "user_asked", title: "t", prompt: "p", background: [...BACKGROUND].slice(0, 10).join("") })).toMatchObject({
		error: expect.stringContaining("too short"),
	});
	expect(checkSpawn({ initiation: "user_asked", title: "t", prompt: "p" })).toMatchObject({ error: expect.stringContaining("background is required") });
	expect(checkSpawn({ initiation: "user_asked", title: "t", name: "Bad Name", prompt: "p", context: "fork" })).toMatchObject({
		error: expect.stringContaining("name must be"),
	});
	expect(checkSpawn({ initiation: "own_initiative", title: "t", prompt: "p", context: "fork", use_worktree: true })).toEqual({
		error: "summary is required and must be non-empty text.",
	});
	expect(checkSpawn({ initiation: "own_initiative", title: "t", summary: "s", prompt: "p", context: "fork", use_worktree: true })).toMatchObject({
		kind: "suggest",
		briefing: { worktree: true },
		summary: "s",
	});
	expect(checkSpawn({ initiation: "own_initiative", proposal_id: "c1" })).toEqual({ kind: "proposal", proposalId: "c1" });
	expect(checkSpawn({ initiation: "offer", proposal_id: "c1", prompt: "p", context: "fork" })).toEqual({
		kind: "proposal",
		proposalId: "c1",
		briefing: { message: "p", fork: true },
	});
	expect(checkSpawn({ initiation: "later" })).toMatchObject({ error: expect.stringContaining("initiation") });
	expect(checkSpawn({ initiation: "offer", title: "字".repeat(61) })).toEqual({ error: "title is 61 characters; keep it to 60." });
});

const user = (text: string, extra: Partial<Extract<Message, { role: "user" }>> = {}) =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 0, ...extra }) as Message;

/** 带 spawn_session 的插件：会话列表、记录、launch、服务 session.worktree、serve、注册下来的工具。 */
async function plugged(options: {
	project?: string;
	cwd?: string;
	createdAt?: number;
	messages?: Message[];
	launch?: (launch: SessionLaunch) => Promise<LaunchedSession>;
	sessions?: SessionSummary[];
}) {
	const parent = {
		id: "p1",
		title: "",
		cwd: options.cwd ?? "/repo",
		...(options.project ? { project: options.project } : {}),
		createdAt: options.createdAt ?? 0,
		updatedAt: 0,
		running: false,
		kind: "top",
	} as SessionSummary;
	const details = { kind: "session_suggestion", title: "拆出去", summary: "s", message: "去做", worktree: true, expiresAt: Date.now() + 60_000 };
	const messages = options.messages ?? [{ role: "toolResult", toolCallId: "c1", toolName: "spawn_session", isError: false, details } as unknown as Message];
	const events: string[] = [];
	const tools: ToolDefinition[] = [];
	const launched: SessionLaunch[] = [];
	const hooks: Record<string, (input: unknown, next: (input: unknown) => unknown) => unknown> = {};
	let api: SpawnSessionApi | undefined;
	const ctx = {
		name: plugin.name,
		dataDir: mkdtempSync(join(tmpdir(), "spawn-session-")),
		settings: async (defaults: object) => {
			let value = defaults;
			return { get: () => value, set: async (patch: object) => (value = { ...value, ...patch }), onChange: () => () => {} };
		},
		locale: () => "zh-CN",
		log: { info() {}, warn() {}, error() {} },
		hook: (name: string, fn: (typeof hooks)[string]) => void (hooks[name] = fn),
		tools: { register: (tool: ToolDefinition) => void tools.push(tool) },
		sessions: {
			list: async () => [parent, ...(options.sessions ?? [])],
			get: async (id: string) => (id === parent.id ? parent : undefined),
			messages: async () => messages,
			launch: async (launch: SessionLaunch) => {
				events.push(`launch ${launch.spawnedFrom?.sessionId}/${launch.spawnedFrom?.toolCallId}`);
				launched.push(launch);
				return options.launch ? options.launch(launch) : started(`s${launched.length}`);
			},
		},
		use: () => ({
			available: async (cwd: string) => cwd === "/repo",
			requestFor(origin: { sessionId: string; toolCallId: string }) {
				events.push(`request ${origin.sessionId}/${origin.toolCallId}`);
				return () => void events.push(`undo ${origin.sessionId}/${origin.toolCallId}`);
			},
		}),
		serve: (served: SpawnSessionApi) => void (api = served),
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	const tool = (name: string) => tools.find((one) => one.name === name)!;
	return { api: api!, events, launched, messages, tool, hooks };
}

function started(id: string): LaunchedSession {
	return { session: { id } as SessionSummary, done: new Promise(() => {}), idle: new Promise(() => {}) };
}

it("开始：工作树开关开着时先登记再开，开不成撤销，开成了不撤；不在项目里的对话不给开关、也不登记", async () => {
	const ok = await plugged({ project: "proj" });
	expect(await ok.api.offersWorktree("p1")).toBe(true);
	expect(await ok.api.start("p1", "c1", { worktree: true })).toBe("s1");
	expect(ok.events).toEqual(["request p1/c1", "launch p1/c1"]);

	const off = await plugged({ project: "proj" });
	await off.api.start("p1", "c1", { worktree: false });
	expect(off.events).toEqual(["launch p1/c1"]);

	const broken = await plugged({
		project: "proj",
		launch: async () => {
			throw new Error("开不了");
		},
	});
	await expect(broken.api.start("p1", "c1", { worktree: true })).rejects.toThrow("开不了");
	expect(broken.events).toEqual(["request p1/c1", "launch p1/c1", "undo p1/c1"]);

	const chat = await plugged({});
	expect(await chat.api.offersWorktree("p1")).toBe(false);
	await chat.api.start("p1", "c1", { worktree: true });
	expect(chat.events).toEqual(["launch p1/c1"]);

	// 界面还没问到能不能开就点了「开始」，交来的是开关的起始值：能不能开由这边现问，不是仓库的项目不登记。
	const plain = await plugged({ project: "proj", cwd: "/plain" });
	await plain.api.start("p1", "c1", { worktree: true });
	expect(plain.events).toEqual(["launch p1/c1"]);
});

it("开始：卡片上选了模型和思考档位才交给 launch；过期的、撤回的不开", async () => {
	const one = await plugged({});
	await one.api.start("p1", "c1", { worktree: false });
	await (await plugged({})).api.start("p1", "c1", { worktree: false, model: "p/strong", thinking: "high" });
	expect(one.launched[0]).not.toHaveProperty("model");
	expect(one.launched[0]).toMatchObject({ message: "去做", title: "拆出去", spawnedFrom: { sessionId: "p1", toolCallId: "c1", reportBack: true } });
	const strong = await plugged({});
	await strong.api.start("p1", "c1", { worktree: false, model: "p/strong", thinking: "high" });
	expect(strong.launched[0]).toMatchObject({ model: "p/strong", thinking: "high" });

	const old = { kind: "session_suggestion", title: "t", summary: "s", message: "m", expiresAt: Date.now() - 1 };
	const expired = await plugged({ messages: [{ role: "toolResult", toolCallId: "c1", toolName: "spawn_session", details: old } as unknown as Message] });
	await expect(expired.api.start("p1", "c1", { worktree: false })).rejects.toThrow("过期");

	const fresh = { ...old, expiresAt: Date.now() + 60_000 };
	const withdrawn = await plugged({
		messages: [
			{ role: "toolResult", toolCallId: "c1", toolName: "spawn_session", details: fresh },
			{ role: "toolResult", toolCallId: "d1", toolName: "dismiss_task", details: { kind: "session_dismissed", proposalId: "c1" } },
		] as unknown as Message[],
	});
	await expect(withdrawn.api.start("p1", "c1", { worktree: false })).rejects.toThrow("撤回");
});

/** 一次调用；这一轮缺省是人说的话引起的（`cause`），`null` 是还没有（重启后还没跑过一轮）。 */
function run(sessionId: string, toolCallId: string, answer?: unknown, calls: ToolRun["calls"] = [], cause: TurnCause | null = { by: "human" }) {
	return {
		sessionId,
		toolCallId,
		session: { id: sessionId, kind: "top", ...(cause ? { cause } : {}) },
		calls,
		request: async () => (answer === undefined ? { answered: false, reason: "declined" } : { answered: true, value: answer }),
	} as unknown as ToolRun;
}

it("spawn_session：offer 等人选，选新会话再带 proposal_id 补简报开出来；以后不再问的不再弹", async () => {
	const messages: Message[] = [user("顺便把 CLI 清理一下")];
	const { tool, launched } = await plugged({ messages });
	const spawn = tool("spawn_session");
	const offered = await spawn.execute({ initiation: "offer", title: "清理 CLI" }, run("p1", "o1", { choice: "new", model: "p/strong", thinking: "high" }));
	expect(offered).toMatchObject({ details: { kind: "session_offer", choice: "new", model: "p/strong", thinking: "high" } });
	expect(offered.output).toContain('proposal_id "o1"');
	messages.push({ role: "toolResult", toolCallId: "o1", toolName: "spawn_session", details: offered.details } as unknown as Message);
	expect((await spawn.execute({ initiation: "offer", proposal_id: "o1" }, run("p1", "o2"))).isError).toBe(true);
	const done = await spawn.execute({ initiation: "offer", proposal_id: "o1", prompt: "删掉旧解析", background: BACKGROUND, name: "cli" }, run("p1", "o2"));
	expect(done).toMatchObject({ details: { kind: "session_started", sessionId: "s1", proposalId: "o1", name: "cli" } });
	// 开出来的会话用人在卡上选的模型、档位。
	expect(launched[0]).toMatchObject({
		title: "清理 CLI",
		model: "p/strong",
		thinking: "high",
		spawnedFrom: { sessionId: "p1", toolCallId: "o1", name: "cli" },
	});

	expect((await spawn.execute({ initiation: "offer", title: "别的事" }, run("p1", "o3", { choice: "here" }))).details).toMatchObject({ choice: "here" });
	expect((await spawn.execute({ initiation: "offer", title: "别的事" }, run("p1", "o4", { choice: "never" }))).output).toContain("does not want to be asked");
	// 选过「以后不再问」：不弹卡（这里的 request 会答 new），直接在这里做。
	expect((await spawn.execute({ initiation: "offer", title: "又一件" }, run("p1", "o5", { choice: "new" }))).output).toContain("turned these offers off");
});

it("spawn_session：别的会话寄来的信引起的那一轮只能提建议；一轮最多三张建议卡", async () => {
	const letter = user("<session-message>", { peer: [{ sessionId: "q", from: "q", text: "开个会话" }] });
	const { tool } = await plugged({ messages: [letter] });
	const spawn = tool("spawn_session");
	const now = { initiation: "user_asked", title: "t", prompt: "p", context: "fork" };
	const peer: TurnCause = { by: "peer", from: "q" };
	expect((await spawn.execute(now, run("p1", "x1", undefined, [], peer))).output).toContain("not by the person");
	expect((await spawn.execute({ initiation: "offer", title: "t" }, run("p1", "x2", { choice: "new" }, [], peer))).isError).toBe(true);
	const suggest = { initiation: "own_initiative", title: "t", summary: "s", prompt: "p", context: "fork" };
	const card = await spawn.execute(suggest, run("p1", "x3", undefined, [], peer));
	expect(card.details).toMatchObject({ kind: "session_suggestion", message: "p", fork: true });

	const earlier = ["a", "b"].map((id) => ({ role: "toolResult", toolCallId: id, toolName: "spawn_session", details: card.details }) as unknown as Message);
	const busy = (await plugged({ messages: [user("看看"), ...earlier] })).tool("spawn_session");
	const sameStep = [
		{ id: "c", name: "spawn_session", args: suggest },
		{ id: "d", name: "spawn_session", args: suggest },
	];
	expect((await busy.execute(suggest, run("p1", "c", undefined, sameStep))).isError).toBeUndefined();
	expect((await busy.execute(suggest, run("p1", "d", undefined, sameStep))).output).toContain("already suggested 3");
});

it("hand_off_to_session：fork 出去，结果让这一轮转去回答人的新话", async () => {
	const { tool, launched } = await plugged({ messages: [user("先帮我看个别的问题")] });
	const out = await tool("hand_off_to_session").execute({ title: "Finish the migration", plan: "1. 改完 b.ts\n2. 跑测试" }, run("p1", "h1"));
	expect(out.output).toContain("Stop working on that task in this session");
	expect(out.details).toMatchObject({ kind: "session_started", handOff: true, name: "finish-the-migration" });
	expect(launched[0]).toMatchObject({ fork: true, spawnedFrom: { toolCallId: "h1", name: "finish-the-migration" } });
	expect(launched[0]!.message).toContain("1. 改完 b.ts");
});

it("dismiss_task：撤回还没开的建议；开过的告诉模型跳过", async () => {
	const ok = await plugged({});
	expect(await ok.tool("dismiss_task").execute({ proposal_id: "c1" }, run("p1", "d1"))).toMatchObject({
		details: { kind: "session_dismissed", proposalId: "c1" },
	});
	const begun = await plugged({ sessions: [{ id: "s9", spawnedFrom: { sessionId: "p1", toolCallId: "c1", name: "cli" } } as SessionSummary] });
	expect((await begun.tool("dismiss_task").execute({ proposal_id: "c1" }, run("p1", "d1"))).output).toBe("Already started as cli (s9).");
});

/** 注册下来的 `archive_session`。 */
async function archiveTool() {
	const tools: ToolDefinition[] = [];
	const ctx = {
		name: plugin.name,
		dataDir: tmpdir(),
		locale: () => "zh-CN",
		log: { info() {}, warn() {}, error() {} },
		hook() {},
		tools: { register: (tool: ToolDefinition) => void tools.push(tool) },
		sessions: { messages: async () => [], observe() {}, onDeleted() {} },
		use: () => ({}),
		settings: async (defaults: object) => ({ get: () => defaults, set: async () => defaults, onChange: () => () => {} }),
		serve() {},
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	return tools.find((tool) => tool.name === "archive_session")!;
}

it("archive_session：交给本体等这一轮收场再归档、这一轮停在这里；reason 可以不给，给了要像话；子会话、插件的独立会话里拒绝", async () => {
	const tool = await archiveTool();
	const kinds: Record<string, SessionKind> = { main: "top", child: "child", ops: "standalone" };
	let asked = 0;
	const run = (sessionId: string, offered = true) =>
		({ sessionId, session: { id: sessionId, kind: kinds[sessionId] }, ...(offered ? { archiveAfterTurn: () => void asked++ } : {}) }) as unknown as ToolRun;

	const done = await tool.execute({ reason: " 修好了 " }, run("main"));
	expect(done).toMatchObject({ terminate: "done", details: { kind: "session_archive", reason: "修好了" } });
	expect(done.isError).toBeUndefined();
	expect(done.output).toContain("archived as soon as this turn ends");
	expect(asked).toBe(1);
	expect((await tool.execute({}, run("main"))).details).toEqual({ kind: "session_archive" });
	expect(asked).toBe(2);

	expect(await tool.execute({ reason: "" }, run("main"))).toEqual({ output: "reason is required and must be non-empty text.", isError: true });
	expect(await tool.execute({ reason: "字".repeat(201) }, run("main"))).toEqual({ output: "reason is 201 characters; keep it to 200.", isError: true });
	const refused = { output: "Only the conversation itself can archive itself; a sub-agent or plugin-owned session cannot.", isError: true };
	expect(await tool.execute({}, run("child"))).toEqual(refused);
	expect(await tool.execute({}, run("ops"))).toEqual(refused);
	expect(await tool.execute({}, run("main", false))).toEqual(refused);
	expect(asked).toBe(2);
});

it("spawn_session：offer 没人选（点了不答、到时没人答）标成没人答，不当成选了在这里做", async () => {
	const { tool } = await plugged({ messages: [user("顺便把 CLI 清理一下")] });
	const unanswered = await tool("spawn_session").execute({ initiation: "offer", title: "清理 CLI" }, run("p1", "o1"));
	expect(unanswered).toMatchObject({ isError: true, details: { unanswered: "declined" } });
	expect(unanswered.output).toContain("did not choose");
});

it("spawn_session：带 proposal_id 开时短名照规矩核，没给就从标题里取", async () => {
	const messages: Message[] = [
		user("顺便把 CLI 清理一下"),
		{
			role: "toolResult",
			toolCallId: "o1",
			toolName: "spawn_session",
			details: { kind: "session_offer", title: "Clean CLI", choice: "new" },
		} as unknown as Message,
	];
	const { tool, launched } = await plugged({ messages });
	const spawn = tool("spawn_session");
	const brief = { initiation: "offer", proposal_id: "o1", prompt: "删掉旧解析", background: BACKGROUND };
	expect((await spawn.execute({ ...brief, name: "Bad Name" }, run("p1", "o2"))).output).toContain("name must be");
	expect(launched).toHaveLength(0);
	await spawn.execute(brief, run("p1", "o3"));
	expect(launched[0]).toMatchObject({ spawnedFrom: { toolCallId: "o1", name: "clean-cli" } });
	// 卡上没动过模型、档位：不给，用默认的。
	expect(launched[0]).not.toHaveProperty("model");
	expect(launched[0]).not.toHaveProperty("thinking");
});

it("fork、移交开出的会话带过来的建议卡在这里开不了：复制来的记录早于这个会话建成", async () => {
	const details = { kind: "session_suggestion", title: "拆出去", summary: "s", message: "去做", expiresAt: Date.now() + 60_000 };
	const copied = { role: "toolResult", toolCallId: "c1", toolName: "spawn_session", isError: false, details, timestamp: 1_000 } as unknown as Message;
	const forked = await plugged({ createdAt: 2_000, messages: [copied] });
	await expect(forked.api.start("p1", "c1", { worktree: false })).rejects.toThrow("原对话");
	expect(forked.launched).toHaveLength(0);
	const own = await plugged({ createdAt: 500, messages: [copied] });
	await own.api.start("p1", "c1", { worktree: false });
	expect(own.launched).toHaveLength(1);
});

it("started：列全部派生顶层关联会话（含直接开、计划、移交、分叉），停止/完成/出错/归档都保留，排除子会话与独立会话，按创建时间排序", async () => {
	const sessions: SessionSummary[] = [
		{
			id: "s-fork",
			title: "手动分叉",
			cwd: "/repo",
			createdAt: 300,
			updatedAt: 350,
			running: false,
			kind: "top",
			forkedFrom: { sessionId: "p1" },
			stop: { reason: "aborted" },
		},
		{
			id: "s-plan",
			title: "执行计划",
			cwd: "/repo",
			createdAt: 100,
			updatedAt: 500,
			running: false,
			kind: "top",
			spawnedFrom: { sessionId: "p1", toolCallId: "plan_call" },
			stop: { reason: "done" },
		},
		{
			id: "s-direct",
			title: "直接开出",
			cwd: "/repo",
			createdAt: 200,
			updatedAt: 250,
			running: true,
			kind: "top",
			spawnedFrom: { sessionId: "p1" },
		},
		{
			id: "s-archived",
			title: "已归档的关联会话",
			cwd: "/repo",
			createdAt: 400,
			updatedAt: 410,
			running: false,
			archived: true,
			kind: "top",
			spawnedFrom: { sessionId: "p1", toolCallId: "c1" },
			stop: { reason: "done" },
		},
		// 排除：子智能体/侧边聊天、独立会话、别的父会话派生的。
		{
			id: "s-child",
			title: "子智能体",
			cwd: "/repo",
			createdAt: 50,
			updatedAt: 60,
			running: true,
			kind: "child",
			parentId: "p1",
			spawnedFrom: { sessionId: "p1" },
		},
		{
			id: "s-standalone",
			title: "独立会话",
			cwd: "/repo",
			createdAt: 60,
			updatedAt: 70,
			running: false,
			kind: "standalone",
			spawnedFrom: { sessionId: "p1" },
		},
		{
			id: "s-other",
			title: "别处开出的",
			cwd: "/repo",
			createdAt: 80,
			updatedAt: 90,
			running: true,
			kind: "top",
			spawnedFrom: { sessionId: "p2", toolCallId: "x" },
		},
	];
	const { api } = await plugged({ sessions });
	expect(await api.started("p1")).toEqual([
		{ callId: "plan_call", sessionId: "s-plan", title: "执行计划", createdAt: 100, running: false, stopReason: "done" },
		{ sessionId: "s-direct", title: "直接开出", createdAt: 200, running: true },
		{ sessionId: "s-fork", title: "手动分叉", createdAt: 300, running: false, stopReason: "aborted" },
		{ callId: "c1", sessionId: "s-archived", title: "已归档的关联会话", createdAt: 400, running: false, stopReason: "done", archived: true },
	]);
});

it("environmentStatus：按会话状态给出持久展示态，停止、完成、出错、归档都不丢", () => {
	const base: StartedSuggestion = { sessionId: "s1", title: "t", createdAt: 10, running: false };
	expect(environmentStatus({ ...base, running: true }, undefined)).toBe("running");
	expect(environmentStatus({ ...base, background: true }, undefined)).toBe("running");
	expect(environmentStatus({ ...base, running: true }, "waiting")).toBe("waiting");
	expect(environmentStatus({ ...base, stopReason: "aborted" }, undefined)).toBe("stopped");
	expect(environmentStatus({ ...base, stopReason: "done" }, undefined)).toBe("done");
	expect(environmentStatus({ ...base, stopReason: "error" }, undefined)).toBe("failed");
	expect(environmentStatus({ ...base, stopReason: "max_turns" }, undefined)).toBe("failed");
	expect(environmentStatus({ ...base, stopReason: "stalled" }, undefined)).toBe("failed");
	expect(environmentStatus({ ...base, stopReason: "done", archived: true }, undefined)).toBe("archived");
	expect(environmentStatus(base, undefined)).toBe("started");
});

it("只有人说的话引起的那一轮能开、能移交：开出来的第一轮、代管插件转来的、运行时叫起的、重启后还没跑过一轮的都不行", async () => {
	const { tool } = await plugged({ messages: [user("去做")] });
	const spawn = tool("spawn_session");
	const handOff = tool("hand_off_to_session");
	const now = { initiation: "user_asked", title: "t", prompt: "p", context: "fork" };
	expect((await spawn.execute(now, run("p1", "x1"))).isError).toBeUndefined();
	const others: Array<TurnCause | null> = [{ by: "launch", plugin: "test.plan" }, { by: "steward", plugin: "test.ops" }, { by: "runtime" }, null];
	for (const cause of others) {
		expect((await spawn.execute(now, run("s1", "y1", undefined, [], cause))).output).toContain("not by the person");
		expect((await handOff.execute({ title: "t", plan: "p" }, run("s1", "y2", undefined, [], cause))).output).toContain("not by the person");
	}
});

it("系统提示词：要每轮交回来处的会话（不管是哪个插件开的）多一节说明来处和汇报；不交回的（只记来处、只记那张卡）、侧栏外的不加", async () => {
	const { hooks } = await plugged({});
	const sections = async (session: Record<string, unknown>) => {
		let seen: { sections: Array<{ id: string; text: string }> } | undefined;
		await hooks["model.context"]!(
			{ sessionId: "s", session: { id: "s", kind: "top", ...session }, sections: [], tools: [] },
			(input) => (seen = input as typeof seen),
		);
		return seen!.sections;
	};
	const plan = await sections({ spawnedFrom: { sessionId: "p1", toolCallId: "plan_call", reportBack: true } });
	expect(plan.map((section) => section.id)).toEqual(["spawnedSession"]);
	expect(plan[0]!.text).toContain("Session p1 started you");
	expect(plan[0]!.text).toContain("is reported to that session");
	expect(await sections({ spawnedFrom: { sessionId: "p1" } })).toEqual([]);
	expect(await sections({ spawnedFrom: { sessionId: "p1", toolCallId: "card", callIn: "side" } })).toEqual([]);
	const side = await sections({ spawnedFrom: { sessionId: "p1", toolCallId: "card", callIn: "side", reportBack: true } });
	expect(side[0]!.text).toContain("Session side, a sub-session of session p1, started you");
	expect(await sections({ kind: "child", spawnedFrom: { sessionId: "p1", toolCallId: "c", reportBack: true } })).toEqual([]);
});
