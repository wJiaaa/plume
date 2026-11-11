import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AssistantMessage, Message, QueuedMessage, SessionSummary } from "@plume/contract";
import { openSessionDb, type SessionDb, SessionDbUnavailable } from "../src/session-db.ts";

let dir: string;
let path: string;
const opened: SessionDb[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-session-db-"));
	path = join(dir, "sessions", "sessions.db");
});

afterEach(async () => {
	for (const db of opened.splice(0)) db.close();
	await rm(dir, { recursive: true, force: true });
});

function open(logs: string[] = []): SessionDb {
	const db = openSessionDb(path, (message) => logs.push(message));
	opened.push(db);
	return db;
}

const summary = (id: string, updatedAt = 1): SessionSummary => ({ id, title: "", cwd: "/tmp", createdAt: 1, updatedAt, running: false });
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "fake",
	model: "fake",
	usage,
	stopReason,
	timestamp: 2,
});

function rows(sql: string, file = path): unknown[] {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return db.prepare(sql).all();
	} finally {
		db.close();
	}
}

it("追加的消息、摘要和压缩记录，关掉重开后原样读回来", () => {
	const db = open();
	db.create(summary("a", 1));
	db.create(summary("b", 5));
	const a = { ...summary("a", 10), title: "你好", running: true, background: true };
	db.append(a, user("你好"));
	db.append(a, reply([{ type: "text", text: "在" }]));
	db.saveContext("a", { compactions: [], withheld: ["call_1"] });
	db.close();

	const again = open();
	// 新的在前；存下来的没有在跑的、在等后台的；消息条数按记录现数。
	const { background: _background, ...stored } = a;
	expect(again.summaries()).toEqual([
		{ ...stored, running: false, messageCount: 2 },
		{ ...summary("b", 5), messageCount: 0 },
	]);
	expect(again.messages("a").map((message) => message.role)).toEqual(["user", "assistant"]);
	expect(again.messages("b")).toEqual([]);
	expect(again.context("a")).toEqual({ compactions: [], withheld: ["call_1"] });
	expect(again.context("b")).toBeUndefined();
});

it("删掉的会话连同消息和草稿一起没了，之后迟到的写入什么都不做", () => {
	const db = open();
	db.create(summary("a"));
	db.create(summary("b"));
	db.append(summary("a", 2), user("一"));
	db.append(summary("b", 2), user("二"));
	db.draft("a", reply([{ type: "text", text: "写到一半" }]));
	db.delete(["a"]);

	expect(db.summaries().map((entry) => entry.id)).toEqual(["b"]);
	expect(rows("SELECT session_id FROM records")).toEqual([{ session_id: "b" }]);
	expect(rows("SELECT session_id FROM drafts")).toEqual([]);
	// 停下的那一轮在删除之后还会写几条。
	db.append(summary("a", 3), reply([{ type: "text", text: "停下" }], "aborted"));
	db.saveSummary(summary("a", 4));
	db.saveContext("a", { compactions: [], withheld: [] });
	db.close();
	expect(
		open()
			.summaries()
			.map((entry) => entry.id),
	).toEqual(["b"]);
	expect(rows("SELECT session_id FROM records")).toEqual([{ session_id: "b" }]);
});

it("排着的话一个会话一行：换掉、清空删行，随会话一起删，删掉以后迟到的写入不写回来", () => {
	const db = open();
	db.create(summary("a"));
	db.create(summary("b"));
	const entry = (id: string): QueuedMessage => ({ id, preview: id, message: { content: [{ type: "text", text: id }] }, createdAt: 1 });
	db.saveQueue("a", [entry("一"), entry("二")]);
	db.saveQueue("b", [entry("三")]);
	db.saveQueue("a", [entry("二")]);
	db.close();
	const reopened = open();
	expect(Object.fromEntries(reopened.queues())).toEqual({ a: [entry("二")], b: [entry("三")] });
	reopened.saveQueue("b", []);
	reopened.delete(["a"]);
	reopened.saveQueue("a", [entry("迟到")]);
	expect(rows("SELECT session_id FROM queue")).toEqual([]);
});

it("截断只留前几条，连同摘要、压缩记录一起写，草稿清掉；之后接着往后追加。复制出的会话带消息和压缩记录、不带花销", () => {
	const db = open();
	db.create(summary("a"));
	const a = { ...summary("a", 2), title: "你好" };
	db.append(a, user("一"));
	db.append(a, reply([{ type: "text", text: "在" }]));
	db.append(a, user("二"));
	db.draft("a", reply([{ type: "text", text: "写到一半" }]));
	db.truncate({ ...a, updatedAt: 3 }, 2, { compactions: [], withheld: ["call_1"] });
	expect(db.messages("a").map((message) => message.role)).toEqual(["user", "assistant"]);
	expect(db.context("a")).toEqual({ compactions: [], withheld: ["call_1"] });
	expect(rows("SELECT session_id FROM drafts")).toEqual([]);
	db.append(a, user("三"));
	expect(rows("SELECT seq FROM records WHERE session_id = 'a' ORDER BY seq")).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);

	db.copy({ ...summary("b", 4), title: "你好（分叉）" }, db.messages("a").slice(0, 2), { compactions: [], withheld: [] });
	expect(db.messages("b")).toEqual(db.messages("a").slice(0, 2));
	expect(db.context("b")).toEqual({ compactions: [], withheld: [] });
	expect(rows("SELECT session_id FROM spend WHERE session_id = 'b'")).toEqual([]);
	// 删掉之后迟到的截断不把它写回来。
	db.delete(["a"]);
	db.truncate(a, 0, { compactions: [], withheld: [] });
	expect(db.summaries().map((entry) => entry.id)).toEqual(["b"]);
});

it("结构版本不对的库报出路径和原因，不重建也不动它", () => {
	open().create(summary("a"));
	opened.pop()?.close();
	const raw = new DatabaseSync(path);
	raw.exec("PRAGMA user_version = 99");
	raw.close();

	let thrown: unknown;
	try {
		open();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(SessionDbUnavailable);
	expect((thrown as SessionDbUnavailable).path).toBe(path);
	expect((thrown as Error).message).toContain(path);
	expect((thrown as SessionDbUnavailable).reason).toContain("结构版本是 99");
	expect(rows("SELECT id FROM sessions")).toEqual([{ id: "a" }]);
});

it("流到一半进程没了：下次打开时已经收到的文字和思考作为停下的回复写进会话，写了一半的工具调用不要", async () => {
	const writer = open();
	writer.create(summary("a", 1));
	writer.append(summary("a", 2), user("写点东西"));
	writer.draft("a", reply([{ type: "thinking", thinking: "想" }]));
	writer.draft(
		"a",
		reply([
			{ type: "thinking", thinking: "想一想" },
			{ type: "text", text: "第一" },
		]),
	);
	writer.draft(
		"a",
		reply([
			{ type: "thinking", thinking: "想一想" },
			{ type: "text", text: "第一段" },
			{ type: "toolCall", id: "c", name: "read", arguments: {} },
		]),
	);
	// 第一段字立刻写，后面的按节流攒一批再写。
	expect(rows("SELECT n FROM draft_chunks")).toHaveLength(1);
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(rows("SELECT n FROM draft_chunks")).toHaveLength(2);

	// 不关上一个连接，直接再开一个：就像进程没来得及收尾。
	const reader = open();
	const messages = reader.messages("a");
	expect(messages).toHaveLength(2);
	expect(messages[1]).toMatchObject({
		role: "assistant",
		stopReason: "aborted",
		content: [
			{ type: "thinking", thinking: "想一想" },
			{ type: "text", text: "第一段" },
		],
	});
	// 会话的时间是草稿最后写入的时刻，不是打开的时刻，但也不会往回退。
	const updatedAt = reader.summaries()[0]?.updatedAt ?? 0;
	expect(updatedAt).toBeGreaterThan(2);
	expect(updatedAt).toBeLessThanOrEqual(Date.now());
	// 恢复出的回复只有文字，光看转录像说完了：这一轮记成被中断，界面才给「继续」。
	expect(reader.summaries()[0]?.stop).toEqual({ reason: "interrupted" });
	expect(rows("SELECT session_id FROM drafts")).toEqual([]);
});

it("重试从头写、块比上一次少时进程没了：恢复的只有这一次写出的，上一次多出来的块不混进来", async () => {
	const writer = open();
	writer.create(summary("a", 1));
	writer.append(summary("a", 2), user("写点东西"));
	writer.draft(
		"a",
		reply([
			{ type: "thinking", thinking: "第一次的思考" },
			{ type: "text", text: "第一次写出的正文" },
			{ type: "text", text: "后来换成工具调用的那段" },
		]),
	);
	// 断线重试：适配器清空内容从头再来，这次第三块是工具调用。
	writer.draft("a", reply([]));
	writer.draft(
		"a",
		reply([
			{ type: "thinking", thinking: "重" },
			{ type: "toolCall", id: "c", name: "read", arguments: {} },
		]),
	);
	writer.draft(
		"a",
		reply([
			{ type: "thinking", thinking: "重来" },
			{ type: "toolCall", id: "c", name: "read", arguments: {} },
			{ type: "toolCall", id: "d", name: "read", arguments: {} },
		]),
	);
	await new Promise((resolve) => setTimeout(resolve, 150));

	const reader = open();
	expect(reader.messages("a")[1]).toMatchObject({ stopReason: "aborted", content: [{ type: "thinking", thinking: "重来" }] });
	expect((reader.messages("a")[1] as AssistantMessage).content).toHaveLength(1);
});

it("整块重写的草稿按最新的恢复；写进会话、或者丢掉的草稿不再恢复", () => {
	const writer = open();
	for (const id of ["a", "b", "c"]) writer.create(summary(id));
	writer.draft("a", reply([{ type: "text", text: "旧的开头很长很长" }]));
	writer.draft("a", reply([{ type: "text", text: "新的" }]));
	writer.draft("a", undefined);

	writer.draft("b", reply([{ type: "text", text: "答完了" }]));
	writer.draft("b", undefined);
	writer.append(summary("b", 2), reply([{ type: "text", text: "答完了" }]));

	writer.draft("c", reply([{ type: "text", text: "没写进会话" }]));
	writer.draft("c", undefined);
	writer.dropDraft("c");

	const reader = open();
	expect(reader.messages("a")).toMatchObject([{ stopReason: "aborted", content: [{ type: "text", text: "新的" }] }]);
	expect(reader.messages("b")).toMatchObject([{ stopReason: "stop", content: [{ type: "text", text: "答完了" }] }]);
	expect(reader.messages("c")).toEqual([]);
});

it("每次计费的回复记一行花销，按小时、供应商、模型合起来；删会话不动它", () => {
	const db = open();
	db.create(summary("a"));
	const at = new Date(2026, 10, 5, 14, 30).getTime();
	const billed = (output: number, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
		...reply([{ type: "text", text: "答" }]),
		timestamp: at,
		usage: {
			input: 100,
			output,
			cacheRead: 50,
			cacheWrite: 10,
			total: 160 + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5, source: "manual" },
		},
		...extra,
	});
	db.append(summary("a", 2), billed(20, { durationMs: 1_500, sseDurationMs: 1_000 }));
	// 太快的不算速度，但照样算请求和首字。
	db.append(summary("a", 3), billed(30, { durationMs: 300, sseDurationMs: 50 }));
	// 一个 token 都没有：还没发出去就失败了，不算一次请求。
	db.append(summary("a", 4), reply([{ type: "text", text: "" }], "error"));
	// 不在会话消息里的调用（插件的一次性调用）没有会话；没配价格的不算免费。
	db.spend(null, billed(5, { usage: { ...usage, input: 7, output: 5, total: 12 } }));
	db.delete(["a"]);

	expect(db.usage()).toMatchObject([
		{
			hour: "2026-11-05 14",
			provider: "fake",
			model: "fake",
			requests: 3,
			input: 207,
			output: 55,
			cacheRead: 100,
			cacheWrite: 20,
			cost: 1,
			unpriced: 1,
			timed: 1,
			timedOutput: 20,
			streamMs: 1_000,
			firstTokens: 2,
			firstTokenMs: 750,
		},
	]);
});

it("主请求记下各部分 token、计时、轮次和工具，并和同一会话上一次主请求比缓存", () => {
	const db = open();
	db.create(summary("a"));
	const at = new Date(2026, 10, 5, 9, 10).getTime();
	const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
	const zero = { system: 0, instructions: 0, skills: 0, toolDefs: 0, user: 0, injected: 0, assistant: 0, toolResults: 0 };
	const note = { parts: { ...zero, system: 3, user: 1 }, turns: 0, tools: 0, toolErrors: 0, toolMs: 0 };
	const billed = (
		tokens: { input: number; cacheRead?: number; cacheWrite?: number },
		extra: Partial<AssistantMessage> = {},
		priced = true,
	): AssistantMessage => ({
		...reply([{ type: "text", text: "答" }]),
		timestamp: at,
		usage: {
			...usage,
			cacheRead: 0,
			cacheWrite: 0,
			...tokens,
			output: 100,
			cost: { ...usage.cost, total: 0.1, ...(priced ? { source: "manual" as const, rates } : {}) },
		},
		...extra,
	});
	// 第一次：没得比。输出按思考块和正文的字数分，计时里思考截在生成以内。
	db.append(
		summary("a"),
		billed(
			{ input: 0, cacheWrite: 10_000 },
			{
				content: [
					{ type: "thinking", thinking: "x".repeat(300), durationMs: 900 },
					{ type: "text", text: "y".repeat(100) },
				],
				durationMs: 2_000,
				sseDurationMs: 600,
			},
		),
		{ ...note, turns: 1 },
	);
	// 工具定义变了：上一次的 1 万 token 本该读到缓存，按实付单价比缓存读单价多花。
	db.append(summary("a"), billed({ input: 3_000, cacheWrite: 9_000 }, { prefix: { segments: 4, change: { segment: "tools", before: 10, after: 12 } } }), {
		...note,
		tools: 2,
		toolErrors: 1,
		toolMs: 500,
	});
	// 压缩之后变短了：期望前缀按这一次的长度算；没记费率的只报 token。
	db.append(summary("a"), billed({ input: 5_000 }, {}, false), { ...note, boundary: "compaction" });
	// 读到了大半，差的不到一个缓存块：当作命中。
	db.append(summary("a"), billed({ input: 500, cacheRead: 5_000 }, { prefix: { segments: 6 } }), note);
	// 不是主请求（插件的一次性调用、分叉）：只记花销。
	db.spend("a", billed({ input: 50_000 }));
	const [bucket] = db.usage();

	expect(bucket).toMatchObject({
		requests: 5,
		sessions: ["a"],
		turns: 1,
		tools: 2,
		toolErrors: 1,
		toolMs: 500,
		timedReplies: 1,
		modelMs: 2_000,
		generateMs: 600,
		thinkingMs: 600,
		cacheMiss: { tokens: 15_000, unpriced: 5_000, byCause: { tools: 10_000, compaction: 5_000 } },
	});
	expect(bucket!.cacheMiss.cost).toBeCloseTo(((3_000 * 3 + 9_000 * 3.75 - 12_000 * 0.3) / 1e6) * (10_000 / 12_000));
	// 各部分加起来是主请求账单上的数：输入按估的 3:1 分；输出只有第一次有思考，按字数 3:1 分（ASCII 四个字符一个 token）。
	const input = 10_000 + 12_000 + 5_000 + 5_500;
	expect(bucket!.parts.system).toBeCloseTo(input * 0.75);
	expect(bucket!.parts.user).toBeCloseTo(input * 0.25);
	expect(bucket!.parts.outputThinking).toBeCloseTo(75);
	expect(bucket!.parts.outputThinking + bucket!.parts.outputReply).toBeCloseTo(400);
});

it("单会话另存只带自己的摘要、压缩记录、消息、草稿和费用，不带子会话或已删会话的账", async () => {
	const db = open();
	const selected = { ...summary("a", 10), title: "导出的会话", archived: true };
	for (const item of [selected, summary("b"), { ...summary("child"), parentId: "a" }, summary("deleted")]) db.create(item);
	const billed = { ...reply([{ type: "text", text: "答" }]), usage: { ...usage, input: 3, output: 2, total: 5 } };
	for (const id of ["a", "b", "child", "deleted"]) {
		db.append({ ...summary(id), ...(id === "a" ? selected : {}) }, user(`消息 ${id}`));
		db.spend(id, billed);
	}
	db.spend(null, billed);
	db.delete(["deleted"]);
	const context = { compactions: [{ at: 3, keptFrom: 0, keptStamp: 1, count: 4, summary: "摘要", head: [], before: 4, after: 2 }], withheld: ["c1"] };
	db.saveContext("a", context);
	const copy = join(dir, "one.db");
	await writeFile(copy, "上一次导出");
	for (const id of ["a", "b", "child"]) {
		db.draft(id, reply([{ type: "text", text: `开头 ${id}` }]));
		db.draft(id, reply([{ type: "text", text: `开头 ${id}，还没到定时落盘的尾巴` }]));
	}
	const before = rows("SELECT * FROM sessions ORDER BY id");
	const records = rows("SELECT * FROM records ORDER BY id");
	const spend = rows("SELECT * FROM spend ORDER BY id");
	db.exportSession("a", copy);

	expect(rows("SELECT * FROM sessions", copy)).toEqual(before.filter((row) => (row as { id: string }).id === "a"));
	for (const table of ["records", "drafts", "draft_chunks", "spend"]) {
		expect(rows(`SELECT DISTINCT session_id FROM ${table}`, copy)).toEqual([{ session_id: "a" }]);
		expect(rows(`SELECT * FROM ${table} WHERE session_id = 'a'`, copy)).toEqual(rows(`SELECT * FROM ${table} WHERE session_id = 'a'`));
	}
	expect(rows("PRAGMA user_version", copy)).toEqual(rows("PRAGMA user_version"));
	expect(rows("PRAGMA integrity_check", copy)).toEqual([{ integrity_check: "ok" }]);
	expect(rows("PRAGMA foreign_key_check", copy)).toEqual([]);
	expect(rows("SELECT * FROM sessions ORDER BY id")).toEqual(before);
	expect(rows("SELECT * FROM records ORDER BY id")).toEqual(records);
	expect(rows("SELECT * FROM spend ORDER BY id")).toEqual(spend);
	expect(rows("SELECT n FROM draft_chunks WHERE session_id = 'a'")).toHaveLength(2);
	expect(rows("SELECT n FROM draft_chunks WHERE session_id = 'b'")).toHaveLength(1);
	expect((await readdir(dir)).sort()).toEqual(["one.db", "sessions"]);

	// 只有副本恢复成停止的回复；源会话仍在写，之后追加的消息不会跑进这份快照。
	const exported = openSessionDb(copy, () => {});
	opened.push(exported);
	expect(exported.context("a")).toEqual(context);
	expect(exported.messages("a")).toMatchObject([user("消息 a"), { stopReason: "aborted", content: [{ type: "text", text: "开头 a，还没到定时落盘的尾巴" }] }]);
	expect(db.messages("a")).toEqual([user("消息 a")]);
	db.append(selected, user("导出后"));
	expect(exported.messages("a")).toHaveLength(2);
});

it("找不到会话或替换目标失败时保留原来的目标，清掉自己的全部临时产物", async () => {
	const db = open();
	db.create(summary("a"));
	const target = join(dir, "keep.db");
	await writeFile(target, "不要覆盖");
	expect(() => db.exportSession("missing", target)).toThrow("Session not found");
	expect(await readFile(target, "utf8")).toBe("不要覆盖");
	const folder = join(dir, "folder.db");
	await mkdir(folder);
	await writeFile(join(folder, "keep"), "不要删除");
	expect(() => db.exportSession("a", folder)).toThrow();
	expect(await readFile(join(folder, "keep"), "utf8")).toBe("不要删除");
	expect((await readdir(dir)).sort()).toEqual(["folder.db", "keep.db", "sessions"]);
	expect(db.summaries()).toEqual([{ ...summary("a"), messageCount: 0 }]);
});

it("复制途中出错不覆盖目标，也不留下临时库或日志", async () => {
	const db = open();
	db.create(summary("a"));
	db.append(summary("a", 2), user("保留源消息"));
	const target = join(dir, "keep.db");
	await writeFile(target, "上一次导出");
	const raw = new DatabaseSync(path);
	try {
		// 让 INSERT SELECT 在副本建表、复制摘要之后失败。
		raw.exec("ALTER TABLE records ADD COLUMN unexpected TEXT");
		expect(() => db.exportSession("a", target)).toThrow();
		expect(await readFile(target, "utf8")).toBe("上一次导出");
		expect((await readdir(dir)).sort()).toEqual(["keep.db", "sessions"]);
		expect(db.messages("a")).toEqual([user("保留源消息")]);
	} finally {
		raw.exec("ALTER TABLE records DROP COLUMN unexpected");
		raw.close();
	}
});

it("草稿落盘失败不能把缺尾巴的副本当成成功，也不覆盖目标", async () => {
	const db = open();
	const target = join(dir, "keep.db");
	await writeFile(target, "不要覆盖");
	db.create(summary("a"));
	db.draft("a", reply([{ type: "text", text: "开头" }]));
	db.draft("a", reply([{ type: "text", text: "开头和尾巴" }]));
	const raw = new DatabaseSync(path);
	try {
		raw.exec("CREATE TRIGGER reject_draft BEFORE INSERT ON draft_chunks BEGIN SELECT RAISE(FAIL, 'draft failed'); END");
		expect(() => db.exportSession("a", target)).toThrow("Could not flush session draft");
		expect(await readFile(target, "utf8")).toBe("不要覆盖");
		expect((await readdir(dir)).sort()).toEqual(["keep.db", "sessions"]);
	} finally {
		raw.exec("DROP TRIGGER reject_draft");
		raw.close();
	}
	db.exportSession("a", join(dir, "retry.db"));
	expect(rows("SELECT n FROM draft_chunks WHERE session_id = 'a'")).toHaveLength(2);
});

it("拒绝源库、sidecar、相对别名、符号链接和硬链接目标，源库仍能继续写", async () => {
	const db = open();
	db.create(summary("a"));
	const alias = join(dir, "alias.db");
	const hard = join(dir, "hard.db");
	const folder = join(dir, "linked");
	await symlink(path, alias);
	await link(path, hard);
	await symlink(join(dir, "sessions"), folder);
	for (const target of [
		path,
		relative(process.cwd(), path),
		join(dir, "sessions", "..", "sessions", "sessions.db"),
		alias,
		hard,
		join(folder, "sessions.db"),
		...["-wal", "-shm", "-journal"].map((suffix) => `${path}${suffix}`),
	]) {
		expect(() => db.exportSession("a", target)).toThrow(/不能覆盖|Cannot overwrite/);
	}
	db.append(summary("a", 2), user("还能写"));
	expect(db.messages("a")).toEqual([user("还能写")]);
	expect(rows("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
});

it("量得出每条会话的记录多大，能把整个库另存一份", () => {
	const db = open();
	db.create(summary("a"));
	db.create(summary("b"));
	db.append(summary("a", 2), user("你好"));
	expect(db.sizes().get("a")).toBeGreaterThan(0);
	expect(db.sizes().has("b")).toBe(false);

	const copy = join(dir, "export.db");
	db.exportTo(copy);
	const exported = new DatabaseSync(copy, { readOnly: true });
	try {
		expect(exported.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "a" }, { id: "b" }]);
	} finally {
		exported.close();
	}
});

it("悬停统计把实际轮步、回复输入和花销分开，撤回不减账本，分叉不重复计费", () => {
	const db = open();
	db.create(summary("a"));
	const paid = {
		...reply([{ type: "text", text: "答" }]),
		usage: { ...usage, input: 10, output: 2, cacheRead: 8, cacheWrite: 3, cost: { ...usage.cost, total: 0.5, source: "manual" as const } },
	};
	db.append(summary("a"), user("问"));
	db.append(summary("a"), paid);
	db.append(summary("a"), { role: "user", content: [{ type: "text", text: "继续" }], timestamp: 2, synthetic: true });
	db.spend("a", paid);
	expect(db.stats("a")).toMatchObject({
		turns: 1,
		steps: 1,
		usage: { input: 20, output: 4, cacheRead: 16, cacheWrite: 6, cost: 1 },
		replyUsage: { input: 10, cacheRead: 8, cacheWrite: 3 },
	});
	db.copy(summary("fork"), [user("问"), paid], { compactions: [], withheld: [] });
	expect(db.stats("fork")).toMatchObject({ turns: 1, steps: 1, usage: { cost: 0, input: 0 } });
	db.truncate(summary("a"), 0, { compactions: [], withheld: [] });
	expect(db.stats("a")).toMatchObject({ turns: 0, steps: 0, usage: { cost: 1 } });
});
