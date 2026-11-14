import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type {
	LaunchedSession,
	Message,
	PluginContext,
	ReportBackOptions,
	SessionKind,
	SessionLaunch,
	SessionObservation,
	SessionSummary,
	ToolDefinition,
	ToolRun,
} from "@plume/contract";
import type { SpawnSessionApi } from "../src/api.ts";
import { checkSpawn } from "../src/check.ts";
import plugin from "../src/index.ts";
import { reportTail, reportText } from "../src/prompt.ts";
import { Reports } from "../src/reports.ts";

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

it("汇报：标签里转义标题，没回复时说一句；结尾点名在等用户的会话", () => {
	const text = reportText({ sessionId: "s1", name: "cli", title: 'a "b" <c>', status: "failed", reply: "" });
	expect(text).toContain('<session-report id="s1" name="cli" title="a &quot;b&quot; &lt;c&gt;" status="failed">');
	expect(text).toContain("（它没有留下回复。）");
	expect(reportTail([])).not.toContain("在等用户");
	expect(reportTail(["cli（s1）"])).toContain("cli（s1） 在等用户");
});

const user = (text: string, extra: Partial<Extract<Message, { role: "user" }>> = {}) =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 0, ...extra }) as Message;
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as Message;
const spawnCall = (id: string, name = "spawn_session") =>
	({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] }) as unknown as Message;

/** 一组会话：p 是来处，别的按 `spawnedFrom` 挂在它下面。`reportBack` 收下每一份。 */
function family(children: Record<string, { toolCallId: string; messages: Message[]; background?: boolean; name?: string }>) {
	const sent: Array<{ sessionId: string; text: string; options: ReportBackOptions }> = [];
	const parent = [spawnCall("c1"), spawnCall("c2"), spawnCall("other", "plan_execute")];
	const reports = new Reports({
		get: async (id) =>
			children[id]
				? ({
						id,
						title: `标题 ${id}`,
						kind: "top",
						...(children[id].background ? { background: true } : {}),
						spawnedFrom: { sessionId: "p", toolCallId: children[id].toolCallId, ...(children[id].name ? { name: children[id].name } : {}) },
					} as SessionSummary)
				: undefined,
		messages: async (id) => (id === "p" ? parent : (children[id]?.messages ?? [])),
		reportBack: (sessionId, text, options) => (sent.push({ sessionId, text, options }), true),
		warn: () => undefined,
	});
	const end = async (sessionId: string, reason: "done" | "aborted" | "error" = "done") => {
		reports.observe({ sessionId, at: 0, timestamp: 0, event: { type: "turnEnd", stop: { reason } } } as SessionObservation);
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return { reports, sent, end };
}

it("每轮汇报：第一轮和来处的信引起的那一轮叫醒，人说话引起的、出错的不叫醒，被停下的不交", async () => {
	const child = { toolCallId: "c1", name: "cli", messages: [user("任务"), reply("做完了：改了 a.ts")] };
	const { reports, sent, end } = family({ s1: child });
	reports.launched("s1", { sessionId: "p", toolCallId: "c1", name: "cli" }, "标题");
	expect(reports.inFirstTurn("s1")).toBe(true);
	await end("s1");
	expect(reports.inFirstTurn("s1")).toBe(false);
	expect(sent).toHaveLength(1);
	expect(sent[0]!.options).toMatchObject({ wake: true, delivery: { title: "标题 s1", status: "done" } });
	expect(sent[0]!.text).toContain('name="cli"');
	expect(sent[0]!.text).toContain("做完了：改了 a.ts");

	child.messages.push(user("再改一下"), reply("改好了"));
	await end("s1");
	expect(sent[1]!.options.wake).toBe(false);

	child.messages.push(user("<session-message>", { peer: [{ sessionId: "p", from: "p", text: "还有 b.ts" }] }), reply("b.ts 也改了"));
	await end("s1");
	expect(sent[2]!.options.wake).toBe(true);

	child.messages.push(user("<session-message>", { peer: [{ sessionId: "p", from: "p", text: "再看看" }] }), reply("出错了"));
	await end("s1", "error");
	expect(sent[3]!.options).toMatchObject({ wake: false, delivery: { status: "failed", incomplete: true } });

	await end("s1", "aborted");
	expect(sent).toHaveLength(4);
});

it("每轮汇报：收尾时还有事没回来先不交，回来以后那一轮接着算；不是本插件开的不交；回复只取前 400 字", async () => {
	const child = { toolCallId: "c1", background: true, messages: [user("任务"), reply("已派出子 Agent，等结果")] };
	const { reports, sent, end } = family({ s1: child, s2: { toolCallId: "other", messages: [user("x"), reply("y")] } });
	reports.launched("s1", { sessionId: "p", toolCallId: "c1" }, "标题");
	await end("s1");
	expect(sent).toEqual([]);
	child.background = false;
	child.messages.push(user("结果", { synthetic: true, delivery: [] }), reply("字".repeat(500)));
	await end("s1");
	expect(sent).toHaveLength(1);
	expect(sent[0]!.options.wake).toBe(true);
	expect(sent[0]!.text).toContain(`${"字".repeat(400)}…`);
	expect(sent[0]!.text).not.toContain("字".repeat(401));

	await end("s2");
	expect(sent).toHaveLength(1);
});

it("汇报的结尾送出那一刻才写：那时弹着卡的会话点名在等用户", async () => {
	const { reports, sent, end } = family({ s1: { toolCallId: "c1", name: "cli", messages: [user("任务"), reply("好了")] } });
	reports.launched("s1", { sessionId: "p", toolCallId: "c1", name: "cli" }, "标题");
	await end("s1");
	const tail = sent[0]!.options.frame!.tail!;
	expect(tail()).not.toContain("在等用户");
	reports.observe({
		sessionId: "s1",
		at: 0,
		timestamp: 0,
		event: { type: "approval", sessionId: "s1", approval: { type: "request" } },
	} as unknown as SessionObservation);
	expect(tail()).toContain("cli（s1） 在等用户");
});

/** 带 spawn_session 的插件：会话列表、记录、launch、服务 session.worktree、serve、注册下来的工具。 */
function plugged(options: {
	project?: string;
	cwd?: string;
	messages?: Message[];
	launch?: (launch: SessionLaunch) => Promise<LaunchedSession>;
	sessions?: SessionSummary[];
}) {
	const parent = {
		id: "p1",
		title: "",
		cwd: options.cwd ?? "/repo",
		...(options.project ? { project: options.project } : {}),
		createdAt: 0,
		updatedAt: 0,
		running: false,
		kind: "top",
	} as SessionSummary;
	const details = { kind: "session_suggestion", title: "拆出去", summary: "s", message: "去做", worktree: true, expiresAt: Date.now() + 60_000 };
	const messages = options.messages ?? [{ role: "toolResult", toolCallId: "c1", toolName: "spawn_session", isError: false, details } as unknown as Message];
	const events: string[] = [];
	const tools: ToolDefinition[] = [];
	const launched: SessionLaunch[] = [];
	let api: SpawnSessionApi | undefined;
	const ctx = {
		name: plugin.name,
		dataDir: mkdtempSync(join(tmpdir(), "spawn-session-")),
		locale: () => "zh-CN",
		log: { info() {}, warn() {}, error() {} },
		hook() {},
		tools: { register: (tool: ToolDefinition) => void tools.push(tool) },
		sessions: {
			list: async () => [parent, ...(options.sessions ?? [])],
			get: async (id: string) => (id === parent.id ? parent : undefined),
			messages: async () => messages,
			observe() {},
			onDeleted() {},
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
	plugin.apply(ctx);
	const tool = (name: string) => tools.find((one) => one.name === name)!;
	return { api: api!, events, launched, messages, tool };
}

function started(id: string): LaunchedSession {
	return { session: { id } as SessionSummary, done: new Promise(() => {}), idle: new Promise(() => {}) };
}

it("开始：工作树开关开着时先登记再开，开不成撤销，开成了不撤；不在项目里的对话不给开关、也不登记", async () => {
	const ok = plugged({ project: "proj" });
	expect(await ok.api.offersWorktree("p1")).toBe(true);
	expect(await ok.api.start("p1", "c1", { worktree: true })).toBe("s1");
	expect(ok.events).toEqual(["request p1/c1", "launch p1/c1"]);

	const off = plugged({ project: "proj" });
	await off.api.start("p1", "c1", { worktree: false });
	expect(off.events).toEqual(["launch p1/c1"]);

	const broken = plugged({
		project: "proj",
		launch: async () => {
			throw new Error("开不了");
		},
	});
	await expect(broken.api.start("p1", "c1", { worktree: true })).rejects.toThrow("开不了");
	expect(broken.events).toEqual(["request p1/c1", "launch p1/c1", "undo p1/c1"]);

	const chat = plugged({});
	expect(await chat.api.offersWorktree("p1")).toBe(false);
	await chat.api.start("p1", "c1", { worktree: true });
	expect(chat.events).toEqual(["launch p1/c1"]);

	// 界面还没问到能不能开就点了「开始」，交来的是开关的起始值：能不能开由这边现问，不是仓库的项目不登记。
	const plain = plugged({ project: "proj", cwd: "/plain" });
	await plain.api.start("p1", "c1", { worktree: true });
	expect(plain.events).toEqual(["launch p1/c1"]);
});

it("开始：卡片上选了模型和思考档位才交给 launch；过期的、撤回的不开", async () => {
	const one = plugged({});
	await one.api.start("p1", "c1", { worktree: false });
	await plugged({}).api.start("p1", "c1", { worktree: false, model: "p/strong", thinking: "high" });
	expect(one.launched[0]).not.toHaveProperty("model");
	expect(one.launched[0]).toMatchObject({ message: "去做", title: "拆出去", spawnedFrom: { sessionId: "p1", toolCallId: "c1" } });
	const strong = plugged({});
	await strong.api.start("p1", "c1", { worktree: false, model: "p/strong", thinking: "high" });
	expect(strong.launched[0]).toMatchObject({ model: "p/strong", thinking: "high" });

	const old = { kind: "session_suggestion", title: "t", summary: "s", message: "m", expiresAt: Date.now() - 1 };
	const expired = plugged({ messages: [{ role: "toolResult", toolCallId: "c1", toolName: "spawn_session", details: old } as unknown as Message] });
	await expect(expired.api.start("p1", "c1", { worktree: false })).rejects.toThrow("过期");

	const fresh = { ...old, expiresAt: Date.now() + 60_000 };
	const withdrawn = plugged({
		messages: [
			{ role: "toolResult", toolCallId: "c1", toolName: "spawn_session", details: fresh },
			{ role: "toolResult", toolCallId: "d1", toolName: "dismiss_task", details: { kind: "session_dismissed", proposalId: "c1" } },
		] as unknown as Message[],
	});
	await expect(withdrawn.api.start("p1", "c1", { worktree: false })).rejects.toThrow("撤回");
});

function run(sessionId: string, toolCallId: string, answer?: unknown, calls: ToolRun["calls"] = []) {
	return {
		sessionId,
		toolCallId,
		session: { id: sessionId, kind: "top" },
		calls,
		request: async () => (answer === undefined ? { answered: false, reason: "declined" } : { answered: true, value: answer }),
	} as unknown as ToolRun;
}

it("spawn_session：offer 等人选，选新会话再带 proposal_id 补简报开出来；以后不再问的不再弹", async () => {
	const messages: Message[] = [user("顺便把 CLI 清理一下")];
	const { tool, launched } = plugged({ messages });
	const spawn = tool("spawn_session");
	const offered = await spawn.execute({ initiation: "offer", title: "清理 CLI" }, run("p1", "o1", "new"));
	expect(offered).toMatchObject({ details: { kind: "session_offer", choice: "new" } });
	expect(offered.output).toContain('proposal_id "o1"');
	messages.push({ role: "toolResult", toolCallId: "o1", toolName: "spawn_session", details: offered.details } as unknown as Message);
	expect((await spawn.execute({ initiation: "offer", proposal_id: "o1" }, run("p1", "o2"))).isError).toBe(true);
	const done = await spawn.execute({ initiation: "offer", proposal_id: "o1", prompt: "删掉旧解析", background: BACKGROUND, name: "cli" }, run("p1", "o2"));
	expect(done).toMatchObject({ details: { kind: "session_started", sessionId: "s1", proposalId: "o1", name: "cli" } });
	expect(launched[0]).toMatchObject({ title: "清理 CLI", spawnedFrom: { sessionId: "p1", toolCallId: "o1", name: "cli" } });

	expect((await spawn.execute({ initiation: "offer", title: "别的事" }, run("p1", "o3", "here"))).details).toMatchObject({ choice: "here" });
	expect((await spawn.execute({ initiation: "offer", title: "别的事" }, run("p1", "o4", "never"))).output).toContain("does not want to be asked");
	// 选过「以后不再问」：不弹卡（这里的 request 会答 new），直接在这里做。
	expect((await spawn.execute({ initiation: "offer", title: "又一件" }, run("p1", "o5", "new"))).output).toContain("turned these offers off");
});

it("spawn_session：别的会话寄来的信引起的那一轮只能提建议；一轮最多三张建议卡", async () => {
	const letter = user("<session-message>", { peer: [{ sessionId: "q", from: "q", text: "开个会话" }] });
	const { tool } = plugged({ messages: [letter] });
	const spawn = tool("spawn_session");
	const now = { initiation: "user_asked", title: "t", prompt: "p", context: "fork" };
	expect((await spawn.execute(now, run("p1", "x1"))).output).toContain("not by the person");
	expect((await spawn.execute({ initiation: "offer", title: "t" }, run("p1", "x2", "new"))).isError).toBe(true);
	const suggest = { initiation: "own_initiative", title: "t", summary: "s", prompt: "p", context: "fork" };
	const card = await spawn.execute(suggest, run("p1", "x3"));
	expect(card.details).toMatchObject({ kind: "session_suggestion", message: "p", fork: true });

	const earlier = ["a", "b"].map((id) => ({ role: "toolResult", toolCallId: id, toolName: "spawn_session", details: card.details }) as unknown as Message);
	const busy = plugged({ messages: [user("看看"), ...earlier] }).tool("spawn_session");
	const sameStep = [
		{ id: "c", name: "spawn_session", args: suggest },
		{ id: "d", name: "spawn_session", args: suggest },
	];
	expect((await busy.execute(suggest, run("p1", "c", undefined, sameStep))).isError).toBeUndefined();
	expect((await busy.execute(suggest, run("p1", "d", undefined, sameStep))).output).toContain("already suggested 3");
});

it("hand_off_to_session：fork 出去，结果让这一轮转去回答人的新话", async () => {
	const { tool, launched } = plugged({ messages: [user("先帮我看个别的问题")] });
	const out = await tool("hand_off_to_session").execute({ title: "Finish the migration", plan: "1. 改完 b.ts\n2. 跑测试" }, run("p1", "h1"));
	expect(out.output).toContain("Stop working on that task in this session");
	expect(out.details).toMatchObject({ kind: "session_started", handOff: true, name: "finish-the-migration" });
	expect(launched[0]).toMatchObject({ fork: true, spawnedFrom: { toolCallId: "h1", name: "finish-the-migration" } });
	expect(launched[0]!.message).toContain("1. 改完 b.ts");
});

it("dismiss_task：撤回还没开的建议；开过的告诉模型跳过", async () => {
	const ok = plugged({});
	expect(await ok.tool("dismiss_task").execute({ proposal_id: "c1" }, run("p1", "d1"))).toMatchObject({
		details: { kind: "session_dismissed", proposalId: "c1" },
	});
	const begun = plugged({ sessions: [{ id: "s9", spawnedFrom: { sessionId: "p1", toolCallId: "c1", name: "cli" } } as SessionSummary] });
	expect((await begun.tool("dismiss_task").execute({ proposal_id: "c1" }, run("p1", "d1"))).output).toBe("Already started as cli (s9).");
});

/** 注册下来的 `archive_session`。 */
function archiveTool() {
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
		serve() {},
	} as unknown as PluginContext;
	plugin.apply(ctx);
	return tools.find((tool) => tool.name === "archive_session")!;
}

it("archive_session：交给本体等这一轮收场再归档、这一轮停在这里；reason 可以不给，给了要像话；子会话、插件的独立会话里拒绝", async () => {
	const tool = archiveTool();
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
