import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage, Message, SessionObservation, SessionView } from "@plume/contract";
import type { TraceObservation } from "../src/api.ts";
import { DiagnosticStore } from "../src/store.ts";
import { entriesOf, filterEntries, latestTodos } from "../src/entries.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const observation = (sessionId: string, at: number): SessionObservation => ({ sessionId, at, timestamp: at * 100, event: { type: "running", running: true } });
const usage = { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, total: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call-a", name: "bash", arguments: { command: "echo needle" } }],
	provider: "test",
	model: "fake",
	api: "anthropic-messages",
	usage,
	stopReason: "toolUse",
	timestamp: 120,
	durationMs: 20,
};
const view = (): SessionView => ({
	summary: { id: "a", title: "", cwd: "/tmp", running: false, createdAt: 0, updatedAt: 0, kind: "top" },
	messages: [
		{ role: "user", content: [{ type: "text", text: "run" }], timestamp: 100 },
		reply,
		{
			role: "toolResult",
			toolCallId: "call-a",
			toolName: "bash",
			content: [{ type: "text", text: "needle result" }],
			isError: false,
			timestamp: 180,
			startedAt: 150,
			durationMs: 30,
			details: { outputPath: "/tmp/log" },
		},
	],
	progress: {},
	startedAt: {},
	hiccups: [],
	compactions: [],
	compacting: false,
	queue: [],
	compactionRuns: [],
});

it("诊断落盘、会话隔离、撤回截断、删除和重启版本", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-diagnostics-"));
	dirs.push(dir);
	const path = join(dir, "trace.db");
	let store = new DiagnosticStore(path);
	store.append(observation("a", 1));
	store.append(observation("a", 3));
	store.append(observation("b", 3));
	const version = store.version("a");
	store.append({ ...observation("a", 2), event: { type: "rewound", sessionId: "a", count: 2, compactions: [], runs: [] } });
	expect(store.read("a").observations.map((item) => item.at)).toEqual([1]);
	expect(store.version("a")).not.toBe(version);
	store.close();
	store = new DiagnosticStore(path);
	try {
		expect(store.read("a").observations).toHaveLength(1);
		expect(store.read("b").observations).toHaveLength(1);
		expect(store.version("a")).not.toBe(version);
		store.delete("a");
		expect(store.read("a").observations).toEqual([]);
		expect(store.read("b").observations).toHaveLength(1);
		expect((await stat(path)).mode & 0o077).toBe(0);
	} finally {
		store.close();
	}
});

it("运行记录用实际时间和错误结果，搜索参数输出并按来源、状态筛选", () => {
	const session = view();
	const entries = entriesOf(session, []);
	const call = entries.find((entry) => entry.source === "tool-call")!;
	expect(call).toMatchObject({ callId: "call-a", startedAt: 150, finishedAt: 180, durationMs: 30, status: "done", output: "needle result" });
	expect(filterEntries(entries, "NEEDLE", "done", ["tool-call"])).toEqual([call]);
	expect(filterEntries(entries, "needle", "error")).toEqual([]);
	const stopped = view();
	stopped.messages.pop();
	expect(entriesOf(stopped, []).find((entry) => entry.source === "tool-call")?.status).toBe("interrupted");
	stopped.summary.running = true;
	expect(entriesOf(stopped, []).find((entry) => entry.source === "tool-call")?.status).toBe("running");
});

it("请求与响应按 id 关联，用量不再和原消息重复计数", () => {
	const observations: TraceObservation[] = [
		{
			sessionId: "a",
			at: 1,
			timestamp: 110,
			event: { type: "request", id: "r", provider: "test", model: "fake", systemPrompt: "p1", messages: 1 },
		},
		{ sessionId: "a", at: 1, timestamp: 140, event: { type: "response", id: "r", reply } },
	];
	const entries = entriesOf(view(), observations, { p1: "system" });
	const requests = entries.filter((entry) => entry.source === "request");
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({ requestId: "r", startedAt: 110, finishedAt: 140, usage });
	expect(requests[0]?.input).toBeUndefined();
	expect(entries.find((entry) => entry.source === "system")).toMatchObject({ summary: "system", detail: "system" });
});

it("只接受成功工具结果中有效的最新计划", () => {
	const session = view();
	session.messages.push({
		role: "toolResult",
		toolCallId: "todo",
		toolName: "todo_write",
		content: [],
		isError: false,
		timestamp: 200,
		details: {
			kind: "todo",
			todos: [
				{ content: "test", status: "in_progress" },
				{ content: 3, status: "other" },
			],
		},
	});
	expect(latestTodos(session.messages)).toEqual([{ content: "test", status: "in_progress" }]);
});

it("不重复存图片像素，不丢工具参数中的 data 字段", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-diagnostics-"));
	dirs.push(dir);
	const store = new DiagnosticStore(join(dir, "trace.db"));
	try {
		store.append({
			sessionId: "a",
			at: 1,
			timestamp: 1,
			event: {
				type: "request",
				id: "r",
				provider: "test",
				model: "fake",
				systemPrompt: "",
				tools: [],
				messages: [
					{ role: "user", timestamp: 1, content: [{ type: "image", data: "pixels", mimeType: "image/png", media: "image.png" }] },
					{ ...reply, content: [{ type: "toolCall", id: "c", name: "send", arguments: { data: "keep this" } }] },
				],
			},
		});
		const stored = JSON.stringify(store.request("a", "r"));
		expect(stored).not.toContain("pixels");
		expect(stored).toContain("image.png");
		expect(stored).toContain("keep this");
	} finally {
		store.close();
	}
});

it("请求按内容去重落盘：历史只存一份，列表只给条数，详情拼回原样，撤回和删除清掉用不到的内容", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-diagnostics-"));
	dirs.push(dir);
	const path = join(dir, "trace.db");
	const store = new DiagnosticStore(path);
	const history: Message[] = Array.from({ length: 40 }, (_, index) => ({
		role: "user",
		content: [{ type: "text", text: `第 ${index} 句 ${"x".repeat(2000)}` }],
		timestamp: index,
	}));
	const tools = [{ name: "read", description: "读文件", parameters: { type: "object", properties: {} } }];
	const request = (id: string, at: number): SessionObservation => ({
		sessionId: "a",
		at,
		timestamp: at,
		event: { type: "request", id, provider: "test", model: "fake", systemPrompt: "system", messages: history.slice(0, at), tools },
	});
	const parts = () => {
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			return Number(db.prepare("SELECT count(*) AS n FROM parts").get()?.n);
		} finally {
			db.close();
		}
	};
	try {
		for (let at = 1; at <= history.length; at++) store.append(request(`r${at}`, at));
		// 40 条消息加系统提示词和工具表各一份，不是每次请求一整份。
		expect(parts()).toBe(history.length + 2);
		const { observations, prompts } = store.read("a");
		const listed = observations.map((item) => item.event);
		expect(listed[9]).toMatchObject({ type: "request", id: "r10", messages: 10 });
		expect(JSON.stringify(observations)).not.toContain("xxxx");
		expect(Object.values(prompts)).toEqual(["system"]);
		expect(store.request("a", "r10")).toEqual({ systemPrompt: "system", tools, messages: history.slice(0, 10) });
		store.append({ sessionId: "a", at: 10, timestamp: 100, event: { type: "rewound", sessionId: "a", count: 10, compactions: [], runs: [] } });
		expect(store.request("a", "r10")).toBeUndefined();
		expect(store.request("a", "r9")).toEqual({ systemPrompt: "system", tools, messages: history.slice(0, 9) });
		expect(parts()).toBe(9 + 2);
		store.delete("a");
		expect(parts()).toBe(0);
	} finally {
		store.close();
	}
});
