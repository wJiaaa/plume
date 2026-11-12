import { expect, it } from "vitest";
import type {
	LaunchedIdle,
	LaunchedSession,
	Message,
	PluginContext,
	SessionKind,
	SessionLaunch,
	SessionSummary,
	ToolDefinition,
	ToolRun,
	TurnStop,
} from "@plume/contract";
import type { SpawnSessionApi } from "../src/api.ts";
import { checkSuggestion } from "../src/check.ts";
import { Followers } from "../src/follow.ts";
import plugin from "../src/index.ts";
import { reportText, suggested } from "../src/prompt.ts";

it("参数校验：三项要有字、按码位数长度，report_back 只能是布尔", () => {
	expect(checkSuggestion({ title: " 清理死代码 ", summary: "顺手看到的", prompt: "删掉 a.ts 里没人用的函数" })).toEqual({
		kind: "session_suggestion",
		title: "清理死代码",
		summary: "顺手看到的",
		prompt: "删掉 a.ts 里没人用的函数",
	});
	expect(checkSuggestion({ title: "t", summary: "s", prompt: "p", report_back: true })).toMatchObject({ reportBack: true });
	expect(checkSuggestion({ title: "t", summary: "s", prompt: "p", report_back: false })).not.toHaveProperty("reportBack");
	expect(checkSuggestion({ summary: "s", prompt: "p" })).toEqual({ error: "title is required and must be non-empty text." });
	expect(checkSuggestion({ title: "字".repeat(61), summary: "s", prompt: "p" })).toEqual({ error: "title is 61 characters; keep it to 60." });
	expect(checkSuggestion({ title: "😀".repeat(60), summary: "s", prompt: "p" })).not.toHaveProperty("error");
	expect(checkSuggestion({ title: "t", summary: "s", prompt: "p", report_back: "yes" })).toEqual({ error: "report_back must be true or false." });
	expect(checkSuggestion({ title: "t", summary: "s", prompt: "p", edits_in_parallel: true })).toMatchObject({ worktree: true });
	expect(checkSuggestion({ title: "t", summary: "s", prompt: "p", edits_in_parallel: false })).not.toHaveProperty("worktree");
	expect(checkSuggestion({ title: "t", summary: "s", prompt: "p", edits_in_parallel: 1 })).toEqual({ error: "edits_in_parallel must be true or false." });
});

it("结果告诉模型什么都还没开始；交回那段带着标签、转义标题，没回复时说一句", () => {
	expect(suggested("清理", true)).toContain("Nothing has started");
	expect(suggested("清理", true)).toContain("do not wait for it");
	expect(suggested("清理", false)).not.toContain("delivered here");
	const text = reportText({ sessionId: "s1", title: 'a "b" <c>', status: "failed", reply: "" });
	expect(text).toContain('<session_result id="s1" title="a &quot;b&quot; &lt;c&gt;" status="failed">');
	expect(text).toContain("（它没有留下回复。）");
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

function launched(id: string) {
	const done = deferred<TurnStop>();
	const idle = deferred<LaunchedIdle>();
	const reports: Array<{ text: string; status: string }> = [];
	const session: LaunchedSession = {
		session: { id } as LaunchedSession["session"],
		done: done.promise,
		idle: idle.promise,
		reportBack(text, status) {
			reports.push({ text, status });
			return true;
		},
	};
	return { session, done, idle, reports };
}

function followers() {
	return new Followers({ title: async () => "起好的标题", warn: () => undefined });
}

const finished = { stop: { reason: "done" }, reply: "做完了" } as const;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("交回：等第一轮结束、再等闲下来，送最后那一轮的话，收场按最后那一轮算", async () => {
	const list = followers();
	const one = launched("s1");
	list.follow(one.session, { title: "建议的标题", reportBack: true });
	expect(list.get("s1")).toMatchObject({ firstTurn: true });
	one.done.resolve({ reason: "done" });
	await tick();
	expect(list.get("s1")?.firstTurn).toBe(false);
	expect(one.reports).toEqual([]);
	// 闲下来之前，送回的结果又叫起了一轮，出错收场。
	one.idle.resolve({ stop: { reason: "error", error: "x" }, reply: "最后的结论" });
	await tick();
	expect(one.reports).toHaveLength(1);
	expect(one.reports[0]!.status).toBe("failed");
	expect(one.reports[0]!.text).toContain("最后的结论");
	expect(one.reports[0]!.text).toContain('title="起好的标题"');
});

it("不交：没要求的、被人停下的、会话删掉了的；第一轮结束以后改不了主意", async () => {
	const list = followers();
	const off = launched("off");
	list.follow(off.session, { title: "t", reportBack: false });
	// 第一轮还在跑时打开：照交。
	expect(list.set("off", true)).toBe(true);
	off.done.resolve({ reason: "done" });
	off.idle.resolve(finished);
	await tick();
	expect(off.reports).toHaveLength(1);
	expect(list.set("off", false)).toBe(false);

	const stopped = launched("stopped");
	list.follow(stopped.session, { title: "t", reportBack: true });
	stopped.done.resolve({ reason: "aborted" });
	stopped.idle.resolve({ stop: { reason: "aborted" }, reply: "" });
	await tick();
	expect(stopped.reports).toEqual([]);

	const turnedOff = launched("turned-off");
	list.follow(turnedOff.session, { title: "t", reportBack: true });
	list.set("turned-off", false);
	turnedOff.done.resolve({ reason: "done" });
	turnedOff.idle.resolve(finished);
	await tick();
	expect(turnedOff.reports).toEqual([]);

	const deleted = launched("deleted");
	list.follow(deleted.session, { title: "t", reportBack: true });
	deleted.done.resolve({ reason: "done" });
	await tick();
	list.deleted("deleted");
	deleted.idle.resolve(finished);
	await tick();
	expect(deleted.reports).toEqual([]);
});

/** 只给「开始」用到的那几样：会话列表和记录、launch、服务 session.worktree、serve。 */
function startable(options: { project?: string; cwd?: string; launch: (launch: SessionLaunch) => Promise<LaunchedSession> }) {
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
	const details = { kind: "session_suggestion", title: "拆出去", summary: "s", prompt: "去做", worktree: true };
	const events: string[] = [];
	let api: SpawnSessionApi | undefined;
	const ctx = {
		name: plugin.name,
		locale: () => "zh-CN",
		log: { info() {}, warn() {}, error() {} },
		hook() {},
		tools: { register() {} },
		sessions: {
			list: async () => [parent],
			get: async (id: string) => (id === parent.id ? parent : undefined),
			messages: async () => [{ role: "toolResult", toolCallId: "c1", isError: false, details } as unknown as Message],
			observe() {},
			onDeleted() {},
			launch: async (launch: SessionLaunch) => {
				events.push(`launch ${launch.spawnedFrom?.sessionId}/${launch.spawnedFrom?.toolCallId}`);
				return options.launch(launch);
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
	return { api: api!, events };
}

it("开始：工作树开关开着时先登记再开，开不成撤销，开成了不撤；不在项目里的对话不给开关、也不登记", async () => {
	const ok = startable({ project: "proj", launch: async () => launched("s2").session });
	expect(await ok.api.offersWorktree("p1")).toBe(true);
	expect(await ok.api.start("p1", "c1", { reportBack: false, worktree: true })).toBe("s2");
	expect(ok.events).toEqual(["request p1/c1", "launch p1/c1"]);

	const off = startable({ project: "proj", launch: async () => launched("s3").session });
	await off.api.start("p1", "c1", { reportBack: false, worktree: false });
	expect(off.events).toEqual(["launch p1/c1"]);

	const broken = startable({
		project: "proj",
		launch: async () => {
			throw new Error("开不了");
		},
	});
	await expect(broken.api.start("p1", "c1", { reportBack: false, worktree: true })).rejects.toThrow("开不了");
	expect(broken.events).toEqual(["request p1/c1", "launch p1/c1", "undo p1/c1"]);

	const chat = startable({ launch: async () => launched("s4").session });
	expect(await chat.api.offersWorktree("p1")).toBe(false);
	await chat.api.start("p1", "c1", { reportBack: false, worktree: true });
	expect(chat.events).toEqual(["launch p1/c1"]);

	// 界面还没问到能不能开就点了「开始」，交来的是开关的起始值：能不能开由这边现问，不是仓库的项目不登记。
	const plain = startable({ project: "proj", cwd: "/plain", launch: async () => launched("s5").session });
	await plain.api.start("p1", "c1", { reportBack: false, worktree: true });
	expect(plain.events).toEqual(["launch p1/c1"]);
});

it("开始：卡片上选了模型和思考档位才交给 launch，没动过就不给、用默认的", async () => {
	const given: SessionLaunch[] = [];
	const record = async (launch: SessionLaunch) => (given.push(launch), launched(`s${given.length}`).session);
	await startable({ launch: record }).api.start("p1", "c1", { reportBack: false, worktree: false });
	await startable({ launch: record }).api.start("p1", "c1", { reportBack: false, worktree: false, model: "p/strong", thinking: "high" });
	expect(given[0]).not.toHaveProperty("model");
	expect(given[0]).not.toHaveProperty("thinking");
	expect(given[1]).toMatchObject({ model: "p/strong", thinking: "high", message: "去做", title: "拆出去" });
});

/** 注册下来的 `archive_session`。 */
function archiveTool() {
	const tools: ToolDefinition[] = [];
	const ctx = {
		name: plugin.name,
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
