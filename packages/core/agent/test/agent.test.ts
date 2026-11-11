import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent, Message, Plugin, PluginContext } from "@plume/contract";
import { type Agent, type AgentOptions, createAgent } from "../src/index.ts";
import { type FakeModel, type FakeReply, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string;
let workspace: string;
let model: FakeModel | undefined;
let agent: Agent | undefined;
const watching = new AbortController();

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-agent-"));
	workspace = join(dir, "workspace");
	await mkdir(workspace);
	await writeFile(join(workspace, "hello.txt"), "hello\n");
});

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	agent = undefined;
	model = undefined;
	await rm(dir, { recursive: true, force: true });
});

/** 直接查会话库：断言落盘的是什么，不经 agent。 */
function storedRows<T>(sql: string, ...params: string[]): T[] {
	const db = new DatabaseSync(join(dir, "data/sessions/sessions.db"), { readOnly: true });
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}

/** 起一个 agent，配好假模型，建会话，返回事件流和一个等待某个事件的函数。 */
async function start(
	replies: FakeReply[] | ((request: Record<string, unknown>, index: number) => FakeReply),
	plugins: Plugin[] = [],
	{ contextWindow = 200_000, ...options }: Pick<AgentOptions, "retryPolicy" | "approvalTimeoutMs"> & { contextWindow?: number } = {},
) {
	model = await fakeAnthropic(replies);
	agent = await createAgent({
		...options,
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [...BUILTINS, ...plugins.map((plugin) => ({ key: plugin.name, load: async () => plugin }))],
		log: () => undefined,
	});
	const service = agent.service;
	const providerId = await service.saveProvider({
		id: "",
		name: "假模型",
		api: "anthropic-messages",
		baseUrl: model.url,
		enabled: true,
		models: ["fake", "other"].map((modelId) => ({
			modelId,
			name: modelId,
			contextWindow,
			maxOutputTokens: 32_000,
			supportsThinking: false,
			supportsImages: false,
			supportsTools: true,
		})),
		apiKey: "test-key",
	});
	const session = await service.createSession({ cwd: workspace });
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
	const idle = () => until((event): event is AgentEvent => event.type === "sessions" && event.sessions.every((summary) => !summary.running), events.length);
	return { service, session, providerId, events, until, idle };
}

it("重命名校验、广播和落盘；不改活动时间，后续消息和重启不覆盖人工标题", async () => {
	let access!: PluginContext["sessions"];
	const plugin: Plugin = {
		name: "test.title-race",
		apply: (ctx) => {
			access = ctx.sessions;
		},
	};
	const { service, session, until, idle } = await start([{ text: "收到" }], [plugin]);
	await access.setTitle(session.id, "自动标题", { automatic: true });
	expect((await service.getSession(session.id)).summary.title).toBe("自动标题");
	const updatedAt = session.updatedAt;
	await service.renameSession(session.id, "  整理发布说明  ");
	// 总结先发出、结果后回来：宿主在真正写入时保护人工标题。
	await access.setTitle(session.id, "迟到的自动标题", { automatic: true });
	const changed = await until(
		(event): event is Extract<AgentEvent, { type: "sessions" }> => event.type === "sessions" && event.sessions.some((item) => item.title === "整理发布说明"),
	);
	expect(changed.sessions.find((item) => item.id === session.id)).toMatchObject({ title: "整理发布说明", updatedAt });
	expect((await service.getSession(session.id)).summary.title).toBe("整理发布说明");
	await expect(service.renameSession(session.id, " \n\t ")).rejects.toThrow("会话标题不能为空");
	await expect(service.renameSession(session.id, null as unknown as string)).rejects.toThrow("会话标题不能为空");
	await expect(service.renameSession("missing", "标题")).rejects.toThrow("没有会话");
	expect((await service.getSession(session.id)).summary).toMatchObject({ title: "整理发布说明", updatedAt });
	service.send(session.id, { content: [{ type: "text", text: "第一句不应覆盖人工标题" }] });
	await idle();
	expect((await service.getSession(session.id)).summary.title).toBe("整理发布说明");
	await agent!.shutdown();
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [{ key: plugin.name, load: async () => plugin }],
		log: () => undefined,
	});
	await access.setTitle(session.id, "重启后的自动标题", { automatic: true });
	expect((await agent.service.getSession(session.id)).summary).toMatchObject({ title: "整理发布说明", titleEdited: true });
	// 不带 automatic 的公开接口仍然是显式改名，保留既有插件契约。
	await access.setTitle(session.id, "插件显式设置");
	expect((await agent.service.getSession(session.id)).summary.title).toBe("插件显式设置");
});

it("置顶和未读广播、落盘且不改活动时间；归档和重启保留，取消后也持久化", async () => {
	const { service, session, until } = await start([]);
	const updatedAt = session.updatedAt;
	await service.setSessionPinned(session.id, true);
	await service.setSessionUnread(session.id, true);
	await until(
		(event): event is Extract<AgentEvent, { type: "sessions" }> =>
			event.type === "sessions" && event.sessions.some((item) => item.id === session.id && item.pinned && item.unread),
	);
	await service.setSessionArchived(session.id, true);
	await agent!.shutdown();
	agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "model.json"), plugins: [], log: () => undefined });
	expect((await agent.service.getSession(session.id)).summary).toMatchObject({ pinned: true, unread: true, archived: true, updatedAt });
	await agent.service.setSessionArchived(session.id, false);
	expect(agent.service.listSessions()[0]).toMatchObject({ pinned: true, unread: true, updatedAt });
	await agent.service.setSessionPinned(session.id, false);
	await agent.service.setSessionUnread(session.id, false);
	const [row] = storedRows<{ summary: string }>("SELECT summary FROM sessions WHERE id = ?", session.id);
	expect(JSON.parse(row!.summary)).toMatchObject({ updatedAt });
	expect(JSON.parse(row!.summary)).not.toHaveProperty("pinned");
	expect(JSON.parse(row!.summary)).not.toHaveProperty("unread");
	await expect(agent.service.setSessionPinned("missing", true)).rejects.toThrow("没有会话");
	await expect(agent.service.setSessionUnread("missing", true)).rejects.toThrow("没有会话");
});

it("移动项目切换目录且保留身份、消息和状态；移出保留目录，主会话或子会话运行时拒绝", async () => {
	let access!: PluginContext["sessions"];
	const plugin: Plugin = {
		name: "test.move",
		apply: (ctx) => {
			access = ctx.sessions;
		},
	};
	const { service, session, idle } = await start([{ text: "主会话回复" }, { text: "子会话回复" }], [plugin]);
	const destination = join(dir, "destination");
	await mkdir(destination);
	const project = await service.createProject("目标项目", destination);
	const child = await access.create({ parentId: session.id, title: "子会话" });
	await service.setSessionPinned(session.id, true);
	await service.setSessionUnread(session.id, true);
	service.send(session.id, { content: [{ type: "text", text: "保留这条消息" }] });
	await expect(service.moveSessionProject(session.id, project.id)).rejects.toThrow("正在运行");
	await idle();
	const updatedAt = service.listSessions().find((item) => item.id === session.id)!.updatedAt;
	const childTurn = access.send(child.id, "检查子会话");
	await expect(service.moveSessionProject(session.id, project.id)).rejects.toThrow("正在运行");
	await childTurn;
	await service.moveSessionProject(session.id, project.id);
	const moved = await service.getSession(session.id);
	expect(moved.summary).toMatchObject({ id: session.id, project: project.id, cwd: destination, pinned: true, unread: true, updatedAt });
	expect(moved.messages).toHaveLength(2);
	expect((await service.getSession(child.id)).summary).toMatchObject({ project: project.id, cwd: destination });
	await expect(service.moveSessionProject(session.id, "missing")).rejects.toThrow("没有项目");
	await agent!.shutdown();
	agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "model.json"), plugins: [], log: () => undefined });
	expect((await agent.service.getSession(session.id)).summary).toMatchObject({ project: project.id, cwd: destination, updatedAt });
	await agent.service.moveSessionProject(session.id, undefined);
	const removed = (await agent.service.getSession(session.id)).summary;
	expect(removed.project).toBeUndefined();
	expect(removed.cwd).toBe(destination);
	expect((await agent.service.getSession(child.id)).summary.project).toBeUndefined();
	expect(agent.service.listSessions()).toHaveLength(2);
});

it("单会话导出服务只取目标记录；Markdown 不泄露供应商配置，拒绝覆盖源库和相对路径", async () => {
	const { service, session, idle } = await start([{ text: "只属于选中会话的回答" }]);
	service.send(session.id, { content: [{ type: "text", text: "选中会话的问题" }] });
	await idle();
	const other = await service.createSession({ cwd: workspace });
	await service.renameSession(other.id, "不要导出另一个会话");
	const database = join(dir, "exports", "one.db");
	await service.exportSession(session.id, database, "database");
	const db = new DatabaseSync(database, { readOnly: true });
	try {
		expect(
			db
				.prepare("SELECT id FROM sessions")
				.all()
				.map((row) => row.id),
		).toEqual([session.id]);
		expect(db.prepare("SELECT COUNT(*) AS n FROM records").get()?.n).toBe(2);
	} finally {
		db.close();
	}
	const markdown = join(dir, "exports", "one.md");
	await service.exportSession(session.id, markdown, "markdown");
	const content = await readFile(markdown, "utf8");
	expect(content).toContain("选中会话的问题");
	expect(content).toContain("只属于选中会话的回答");
	expect(content).not.toContain("不要导出另一个会话");
	expect(content).not.toContain("test-key");
	await expect(service.exportSession(session.id, "relative.md", "markdown")).rejects.toThrow("完整路径");
	await expect(service.exportSession("missing", markdown, "markdown")).rejects.toThrow("没有会话");
	await expect(service.exportSession(session.id, join(dir, "data/sessions/sessions.db"), "markdown")).rejects.toThrow("不能覆盖");
	await expect(service.exportSession(session.id, join(dir, "data/sessions/sessions.db-wal"), "markdown")).rejects.toThrow("不能覆盖");
	const alias = join(dir, "source.md");
	await symlink(join(dir, "data/sessions/sessions.db"), alias);
	await expect(service.exportSession(session.id, alias, "markdown")).rejects.toThrow("不能覆盖");
	expect((await service.getSession(session.id)).messages).toHaveLength(2);
});

const edit = { id: "call_edit", name: "edit", args: { path: "hello.txt", old_string: "hello", new_string: "hi" } };
/** edit 之前要读过：没读过的文件改不了。 */
const readHello = { id: "call_read_hello", name: "read", args: { path: "hello.txt" } };

it("一轮完整的循环：model.context 改上下文、插件工具带 details、edit 经审批后执行", async () => {
	const notes: Plugin = {
		name: "test.notes",
		apply(ctx) {
			ctx.hook("model.context", async (input, next) => next({ ...input, sections: [...input.sections, { id: "notes", text: "NOTES_HINT" }] }));
			ctx.tools.register({
				name: "note",
				description: "记一条笔记",
				parameters: { type: "object", properties: { text: { type: "string" } } },
				execute: async (args) => ({ output: "记下了", details: { text: args.text, marker: "ONLY_IN_DETAILS" } }),
			});
		},
	};
	const { service, session, until, idle } = await start(
		[{ text: "我来改。", toolCalls: [{ id: "call_note", name: "note", args: { text: "买菜" } }, readHello, edit] }, { text: "改好了" }],
		[notes],
	);

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "把 hello 改成 hi" }] });
	const asked = await until((event): event is Extract<AgentEvent, { type: "approval" }> => event.type === "approval" && event.approval !== undefined);
	expect(asked.approval).toMatchObject({
		toolCallId: "call_edit",
		tool: "edit",
		kind: "edit",
		title: "Edit hello.txt",
		subject: await realpath(join(workspace, "hello.txt")),
	});
	// 卡片上是这次改动的 diff。
	expect(asked.approval?.detail).toContain("-hello");
	expect(asked.approval?.detail).toContain("+hi");
	service.respond(session.id, "call_edit", "once");
	await done;

	expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hi\n");
	const [first, second] = model?.requests ?? [];
	expect(JSON.stringify(first?.system)).toContain("NOTES_HINT");
	expect((first?.tools as Array<{ name: string }> | undefined)?.map((tool) => tool.name)).toEqual([
		"read",
		"write",
		"edit",
		"ls",
		"glob",
		"grep",
		"bash",
		"bash_output",
		"monitor",
		"schedule_wakeup",
		"cron_create",
		"cron_list",
		"cron_delete",
		"ask_user",
		"recall",
		"note",
	]);
	expect(JSON.stringify(second?.messages)).toContain("Edited hello.txt: 1 replacement");
	// details 只存进会话，不发给模型。
	expect(JSON.stringify(second)).not.toContain("ONLY_IN_DETAILS");

	const view = await service.getSession(session.id);
	const note = view.messages.find((message) => message.role === "toolResult" && message.toolCallId === "call_note");
	expect(note).toMatchObject({ details: { text: "买菜", marker: "ONLY_IN_DETAILS" }, isError: false });
	// 跑过的调用记下开始时刻和耗时，使用统计按它算工具耗时。
	expect(note).toMatchObject({ startedAt: expect.any(Number), durationMs: expect.any(Number) });
	// 会话落盘了。
	const stored = storedRows("SELECT body FROM records WHERE session_id = ?", session.id);
	expect(stored).toHaveLength(view.messages.length);
	expect(
		service
			.listPlugins()
			.filter((plugin) => !plugin.builtin)
			.map(({ name, state }) => [name, state]),
	).toEqual([["test.notes", "active"]]);
});

it("上下文分段：发请求前没有，发过以后按那次请求分段、总数是回复报的用量", async () => {
	const { service, session, idle } = await start([{ text: "好" }]);
	expect(await service.contextBreakdown(session.id)).toBeNull();

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	await done;

	const last = (await service.getSession(session.id)).messages.at(-1);
	if (last?.role !== "assistant") throw new Error("没有回复");
	const breakdown = await service.contextBreakdown(session.id);
	expect(breakdown).toMatchObject({
		limit: 200_000,
		measured: true,
		used: last.usage.input + last.usage.cacheRead + last.usage.cacheWrite + last.usage.output,
	});
	expect(breakdown?.segments.map((segment) => segment.key).sort()).toEqual(["messages", "systemPrompt", "tools"]);
	expect(breakdown?.segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(breakdown?.used);
	expect(breakdown?.memoryFiles).toEqual([]);
});

it("上下文分段：项目指令和项目记忆按插件标的文件列出来源", async () => {
	await writeFile(join(workspace, "AGENTS.md"), "用 pnpm。\n".repeat(200));
	const memory: Plugin = {
		name: "test.memory-files",
		apply(ctx) {
			ctx.hook("model.context", (input, next) => {
				const text = "<project_memory>\n- 记下的\n</project_memory>";
				return next({ ...input, sections: [...input.sections, { id: "projectMemory", text, files: [{ path: "/data/learned.md", chars: text.length }] }] });
			});
		},
	};
	const { service, session, idle } = await start([{ text: "好" }], [memory]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	await done;

	const breakdown = await service.contextBreakdown(session.id);
	expect(breakdown?.memoryFiles.map((file) => file.path)).toEqual([join(workspace, "AGENTS.md"), "/data/learned.md"]);
	const tokensOf = (key: string) => breakdown?.segments.find((segment) => segment.key === key)?.tokens ?? 0;
	const [instructions, learned] = breakdown?.memoryFiles ?? [];
	expect(instructions?.tokens).toBeGreaterThan(0);
	expect(instructions?.tokens).toBeLessThanOrEqual(tokensOf("projectInstructions"));
	expect(learned?.tokens).toBe(tokensOf("projectMemory"));
});

it("记忆文件在会话目录外也能在文件面板里只读打开，只限这个会话最近一次请求标出的那几个", async () => {
	const memoryDir = join(dir, "plugin-memory");
	await mkdir(memoryDir);
	const learned = join(memoryDir, "learned.md");
	await writeFile(learned, "- 记下的\n");
	await writeFile(join(memoryDir, "other.md"), "没标出来\n");
	const memory: Plugin = {
		name: "test.memory-source",
		apply(ctx) {
			ctx.hook("model.context", (input, next) => {
				const text = "<project_memory>\n- 记下的\n</project_memory>";
				return next({ ...input, sections: [...input.sections, { id: "projectMemory", text, files: [{ path: learned, chars: text.length }] }] });
			});
		},
	};
	const { service, session, idle } = await start([{ text: "好" }], [memory]);
	// 还没发过请求：没有记忆文件，目录外的照样不读。
	expect(await service.readFile(session.id, learned)).toBeNull();
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	await done;

	expect(await service.readFile(session.id, learned)).toMatchObject({ text: "- 记下的\n" });
	expect(await service.readFile(session.id, join(memoryDir, "other.md"))).toBeNull();
	await expect(service.listDirectory(session.id, memoryDir)).rejects.toThrow();
	// 别的会话没发过这次请求，读不到。
	const other = await service.createSession({ cwd: workspace });
	expect(await service.readFile(other.id, learned)).toBeNull();
});

it("用户拒绝时不执行，外层预先放行时不问", async () => {
	const allowRead: Plugin = {
		name: "test.allow-bash",
		apply(ctx) {
			ctx.hook("tool.execute", (input, next) => next(input.call.name === "bash" ? { ...input, approved: "测试放行" } : input), { order: -10 });
		},
	};
	const bash = { id: "call_bash", name: "bash", args: { command: "cat hello.txt" } };
	const { service, session, events, until, idle } = await start([{ toolCalls: [bash, readHello, edit] }, { text: "好" }], [allowRead]);

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "看一下再改" }] });
	await until((event): event is AgentEvent => event.type === "approval" && event.approval !== undefined);
	service.respond(session.id, "call_edit", "reject");
	await done;

	const approvals = events.filter((event) => event.type === "approval" && event.approval !== undefined);
	expect(approvals).toHaveLength(1);
	expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hello\n");
	const results = (await service.getSession(session.id)).messages.filter((message) => message.role === "toolResult");
	expect(results.map((result) => [result.toolCallId, result.isError, result.content[0]?.type === "text" ? result.content[0].text : ""])).toEqual([
		["call_bash", false, expect.stringMatching(/hello[\s\S]*\[Executed with read; use that tool directly next time\.\]$/)],
		["call_read_hello", false, expect.stringContaining("hello")],
		["call_edit", true, expect.stringContaining("The user rejected this edit.")],
	]);
});

it("插件工具的结果可以带图，跟在文字后面交给模型；格式不对的判失败", async () => {
	const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const shots: Plugin = {
		name: "test.shots",
		apply(ctx) {
			ctx.tools.register({
				name: "shot",
				description: "截一张图",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ output: "截好了", images: [{ data: pixel, mimeType: "image/png" }] }),
			});
			ctx.tools.register({
				name: "bad_shot",
				description: "截坏的图",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ output: "截好了", images: [{ data: `data:image/png;base64,${pixel}`, mimeType: "image/png" }] }) as never,
			});
		},
	};
	const { service, session, idle } = await start(
		[
			{
				toolCalls: [
					{ id: "call_shot", name: "shot", args: {} },
					{ id: "call_bad", name: "bad_shot", args: {} },
				],
			},
			{ text: "看到了" },
		],
		[shots],
	);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "截一张" }] });
	await done;
	const messages = (await service.getSession(session.id)).messages;
	const results = messages.filter((message) => message.role === "toolResult");
	const shot = results.find((message) => message.toolCallId === "call_shot");
	expect(shot?.content).toEqual([
		{ type: "text", text: "截好了" },
		{ type: "image", data: pixel, mimeType: "image/png" },
	]);
	// 测试用的模型不看图：图到了请求那一层，换成了说明。
	expect(JSON.stringify(model?.requests[1]?.messages)).toContain("image omitted");
	const bad = results.find((message) => message.toolCallId === "call_bad");
	expect(bad?.isError).toBe(true);
	expect(bad?.content).toHaveLength(1);
});

it("tool.execute 出错转成错误结果继续；model.context 出错结束这一轮并提示", async () => {
	const broken: Plugin = {
		name: "test.broken",
		apply(ctx) {
			ctx.hook("tool.execute", async () => {
				throw new Error("层坏了");
			});
		},
	};
	const first = await start([{ toolCalls: [{ id: "call_read", name: "read", args: { path: "hello.txt" } }] }, { text: "好" }], [broken]);
	let done = first.idle();
	first.service.send(first.session.id, { content: [{ type: "text", text: "读一下" }] });
	await done;
	const result = (await first.service.getSession(first.session.id)).messages.find((message) => message.role === "toolResult");
	expect(result?.isError).toBe(true);
	expect(JSON.stringify(result?.content)).toContain("插件 test.broken 在 tool.execute 出错：层坏了");
	expect(model?.requests).toHaveLength(2);

	await agent?.shutdown();
	await model?.close();
	const contextBroken: Plugin = {
		name: "test.context-broken",
		apply(ctx) {
			ctx.hook("model.context", async () => {
				throw new Error("上下文坏了");
			});
		},
	};
	const second = await start([{ text: "不该到这里" }], [contextBroken]);
	done = second.idle();
	second.service.send(second.session.id, { content: [{ type: "text", text: "你好" }] });
	const notice = await second.until((event): event is Extract<AgentEvent, { type: "notice" }> => event.type === "notice");
	await done;
	expect(notice.text).toContain("插件 test.context-broken 在 model.context 出错：上下文坏了");
	expect(model?.requests).toHaveLength(0);
});

it("会话选的模型用在下一轮并记在会话上；没选时用默认模型", async () => {
	const { service, session, providerId, idle } = await start([{ text: "好" }]);
	const send = async (text: string) => {
		const done = idle();
		service.send(session.id, { content: [{ type: "text", text }] });
		await done;
	};

	await send("第一轮");
	await service.setSessionModel(session.id, `${providerId}/other`);
	expect(service.listSessions()[0]?.model).toBe(`${providerId}/other`);
	await send("第二轮");
	await service.setSessionModel(session.id, undefined);
	await send("第三轮");

	expect(model?.requests.map((request) => request.model)).toEqual(["fake", "other", "fake"]);
	await expect(service.setSessionModel(session.id, `${providerId}/missing`)).rejects.toThrow("没有可用的模型");
});

it("保存供应商时 key 留空不改已存的 key，默认模型跟着可用的模型走", async () => {
	const { service, providerId } = await start([{ text: "好" }]);
	const [provider] = (await service.getSettings()).providers;
	if (!provider) throw new Error("应该有一个供应商");
	expect(provider.hasKey).toBe(true);

	await service.saveProvider({ ...provider, name: "改个名" });
	await service.setDefaultModel(`${providerId}/other`);
	let settings = await service.getSettings();
	expect(settings.providers[0]).toMatchObject({ name: "改个名", hasKey: true });
	expect(settings.defaultModel).toBe(`${providerId}/other`);

	// 默认模型从供应商里删掉后，落到第一个可用的模型。
	await service.saveProvider({ ...provider, models: provider.models.filter((entry) => entry.modelId !== "other") });
	settings = await service.getSettings();
	expect(settings.defaultModel).toBe(`${providerId}/fake`);

	await service.deleteProvider(providerId);
	settings = await service.getSettings();
	expect(settings).toMatchObject({
		providers: [],
		favoriteModels: [],
		permissionMode: "auto",
		personalization: { customInstructions: "", tone: "friendly" },
		thinking: "medium",
	});
	expect(settings.defaultModel).toBeUndefined();
});

it("系统提示词：个性化、项目指令进对应的段，日期跟在用户消息后面", async () => {
	await writeFile(join(workspace, "AGENTS.md"), "PROJECT_RULE");
	const { service, session, idle } = await start([{ text: "好" }]);
	await service.setPersonalization({ tone: "concise", customInstructions: "GLOBAL_RULE" });
	expect((await service.getSettings()).personalization).toEqual({ customInstructions: "GLOBAL_RULE", tone: "concise" });
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	await done;
	const [first] = model?.requests ?? [];
	const system = JSON.stringify(first?.system);
	expect(system).toContain("You are Plume");
	expect(system).toContain("Tone and Style: Be extremely concise");
	expect(system).toContain("GLOBAL_RULE");
	expect(system).toContain("PROJECT_RULE");
	expect(system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	expect(JSON.stringify(first?.messages)).toMatch(/<env>\\n今天是 \d{4}-\d{2}-\d{2}。/);
	await expect(service.setPersonalization({ tone: "loud" as never })).rejects.toThrow();
});

it("callPlugin 把调用交给插件经 serve 开的方法：异步迭代器原样交回，signal 是调用方的", async () => {
	const plugin: Plugin = {
		name: "test.panel",
		apply(ctx) {
			ctx.serve({
				async *count(to: number, call: { signal: AbortSignal }) {
					for (let n = 1; n <= to && !call.signal.aborted; n++) yield n;
				},
			});
		},
	};
	const { service } = await start([], [plugin]);
	const caller = new AbortController();
	const stream = (await service.callPlugin("test.panel", "count", [3], { signal: caller.signal })) as AsyncIterable<number>;
	const seen: number[] = [];
	for await (const n of stream) {
		seen.push(n);
		if (n === 2) caller.abort();
	}
	expect(seen).toEqual([1, 2]);
	await expect(service.callPlugin("test.panel", "missing", [], { signal: caller.signal })).rejects.toThrow(/没有方法 missing/);
});

it("插件的 ctx.model.complete 用默认模型、不带工具、不进会话，只回字", async () => {
	let complete: ((systemPrompt: string, prompt: string) => Promise<string>) | undefined;
	const plugin: Plugin = {
		name: "test.complete",
		apply(ctx) {
			complete = (systemPrompt, prompt) => ctx.model.complete({ systemPrompt, prompt, maxTokens: 50 });
		},
	};
	const { service } = await start([{ text: "修好了登录" }], [plugin]);
	expect(await complete?.("写提交说明", "diff --git a b")).toBe("修好了登录");
	const request = model?.requests[0];
	expect(request).toMatchObject({ model: "fake", max_tokens: 50, messages: [{ role: "user" }] });
	expect(JSON.stringify(request?.system)).toContain("写提交说明");
	expect(request?.tools ?? []).toEqual([]);
	expect(service.listSessions().every((summary) => summary.title === "")).toBe(true);
});

it("ctx.model.complete 可以点名模型；点名的模型不在目录里时报错，不换成默认模型", async () => {
	let ctx: PluginContext | undefined;
	const plugin: Plugin = { name: "test.complete", apply: (context) => void (ctx = context) };
	await start([{ text: "好" }], [plugin]);
	const [listed] = (await ctx?.sessions.models()) ?? [];
	expect(await ctx?.model.complete({ systemPrompt: "s", prompt: "p", model: listed?.id })).toBe("好");
	await expect(ctx?.model.complete({ systemPrompt: "s", prompt: "p", model: "gone/model" })).rejects.toThrow("gone/model");
	expect(model?.requests).toHaveLength(1);
});

it("插件的 ctx.sessions 只读：列出会话、读到原文的副本；apply 时就读得到已有的会话", async () => {
	let access: PluginContext["sessions"] | undefined;
	const plugin: Plugin = {
		name: "test.sessions",
		apply(ctx) {
			access = ctx.sessions;
		},
	};
	const { service, session, idle } = await start([{ text: "你好" }], [plugin]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "打个招呼" }] });
	await done;

	const listed = await access?.list();
	expect(listed?.map((summary) => summary.id)).toEqual([session.id]);
	const messages = await access?.messages(session.id);
	expect(messages?.map((message) => message.role)).toEqual(["user", "assistant"]);
	messages?.pop();
	expect(await access?.messages(session.id)).toHaveLength(2);
	await expect(access?.messages("missing")).rejects.toThrow("missing");

	await agent?.shutdown();
	let seen: string[] = [];
	const early: Plugin = {
		name: "test.sessions",
		async apply(ctx) {
			seen = (await ctx.sessions.list()).map((summary) => summary.id);
		},
	};
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [{ key: early.name, load: async () => early }],
		log: () => undefined,
	});
	expect(seen).toEqual([session.id]);
});

it("插件改会话标题：压掉多余空白、存进库，第一条消息不再改写它；空串不起作用", async () => {
	let access: PluginContext["sessions"] | undefined;
	const plugin: Plugin = {
		name: "test.title",
		apply(ctx) {
			access = ctx.sessions;
		},
	};
	const { service, session, idle } = await start([{ text: "你好" }], [plugin]);
	await access?.setTitle(session.id, "  整理\n 发布流程  ");
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "帮我把发布流程整理一下" }] });
	await done;
	expect(service.listSessions().find((summary) => summary.id === session.id)?.title).toBe("整理 发布流程");
	await access?.setTitle(session.id, "   ");
	expect(service.listSessions().find((summary) => summary.id === session.id)?.title).toBe("整理 发布流程");
	await expect(access?.setTitle("missing", "x")).rejects.toThrow("missing");
	await agent?.shutdown();
	agent = undefined;
	const stored = storedRows<{ summary: string }>("SELECT summary FROM sessions").map((row) => JSON.parse(row.summary) as { title: string });
	expect(stored[0]?.title).toBe("整理 发布流程");
});

it("项目登记后存盘；会话开在项目里记下项目，什么都不给开在公共目录；移除项目不动它的会话", async () => {
	const { service } = await start([]);
	const project = await service.createProject("  ", workspace);
	expect(project).toMatchObject({ name: "workspace", path: workspace });
	const later = await service.createProject("另一个", dir);
	expect(service.listProjects().map((entry) => entry.id)).toEqual([later.id, project.id]);

	const inProject = await service.createSession({ project: project.id });
	expect(inProject).toMatchObject({ cwd: workspace, project: project.id });
	const chat = await service.createSession({});
	expect(chat.project).toBeUndefined();
	expect(chat.cwd).toBe(join(dir, "data", "workspaces", "general"));
	await expect(service.createSession({ cwd: " " })).rejects.toThrow("工作目录不能为空");
	await expect(service.createSession({ project: "missing" })).rejects.toThrow("没有项目 missing");

	await service.updateProject(project.id, "改名", workspace);
	await service.removeProject(later.id);
	await agent?.shutdown();
	agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "model.json"), plugins: [], log: () => undefined });
	expect(agent.service.listProjects()).toEqual([{ id: project.id, name: "改名", path: workspace }]);
	await agent.service.removeProject(project.id);
	expect(agent.service.listSessions().find((session) => session.id === inProject.id)?.project).toBe(project.id);
});

it("带图片和附件的消息：大图挪进 session-media，会话和事件里只留名字，发给模型时读回来", async () => {
	const { service, session, until, idle } = await start([{ text: "看到了" }]);
	const [provider] = (await service.getSettings()).providers;
	if (!provider) throw new Error("应该有一个供应商");
	await service.saveProvider({ ...provider, models: provider.models.map((entry) => ({ ...entry, supportsImages: true })) });

	const data = Buffer.alloc(9000, 7).toString("base64");
	const done = idle();
	service.send(session.id, {
		content: [
			{ type: "text", text: "\n\n### Attached file: shot.png\n\n" },
			{ type: "image", data, mimeType: "image/png" },
			{ type: "text", text: "这张图里有什么【图片 1】" },
		],
		displayText: "这张图里有什么【图片 1】",
		attachments: [{ name: "shot.png", kind: "image", mimeType: "image/png", label: "图片 1", path: "relative/shot.png" }],
	});
	const sent = await until((event): event is Extract<AgentEvent, { type: "message" }> => event.type === "message" && event.message.role === "user");
	await done;

	const image = sent.message.content.find((block) => block.type === "image");
	expect(image).toMatchObject({ data: "", mimeType: "image/png" });
	const media = image?.type === "image" ? image.media : undefined;
	expect(media).toMatch(/^[0-9a-f]{40}\.png$/);
	expect((await readFile(join(dir, "data", "session-media", media ?? ""))).toString("base64")).toBe(data);
	// 相对路径不认：以后要拿它去打开文件。
	expect(sent.message).toMatchObject({
		displayText: "这张图里有什么【图片 1】",
		attachments: [{ name: "shot.png", kind: "image", mimeType: "image/png", label: "图片 1" }],
	});
	expect(sent.message.role === "user" && sent.message.attachments?.[0]?.path).toBeFalsy();
	expect(service.listSessions()[0]?.title).toBe("这张图里有什么【图片 1】");
	expect(JSON.stringify(model?.requests[0])).toContain(data);
	const bodies = storedRows<{ body: string }>("SELECT body FROM records WHERE session_id = ?", session.id).map((row) => row.body);
	expect(bodies.join("\n")).toContain("shot.png");
	expect(bodies.join("\n")).not.toContain(data);

	expect(() =>
		service.send(session.id, {
			content: [
				{ type: "text", text: "  " },
				{ type: "image", data: "x", mimeType: "text/plain" },
			],
		}),
	).toThrow("消息不能为空");
});

it("documentText 抽 Word 的字，认不出的格式给 null", async () => {
	const { zipSync, strToU8 } = await import("fflate");
	const { service } = await start([{ text: "好" }]);
	const docx = zipSync({
		"word/document.xml": strToU8(
			"<w:document><w:body><w:p><w:r><w:t>合同 &amp; 条款</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>",
		),
	});
	expect(await service.documentText("合同.docx", docx)).toEqual({ text: "合同 & 条款\n第二段" });
	expect(await service.documentText("旧格式.doc", new Uint8Array([1, 2, 3]))).toBeNull();
	expect(await service.documentText("坏的.docx", new Uint8Array([1, 2, 3]))).toBeNull();
});

/** 重试只等一秒：默认策略一次等五秒，测试等不起。 */
const quickRetry: AgentOptions["retryPolicy"] = {
	network: { retries: 2, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
	upstream: { retries: 2, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
};

const textOfUser = (message: Message) =>
	message.role === "user" && typeof message.content !== "string" ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
const textOf = (message: Message | undefined) => (message?.role === "toolResult" && message.content[0]?.type === "text" ? message.content[0].text : "");

it("请求失败后重试接上：记一条「恢复了」的岔子，这一轮照常答完", async () => {
	const { service, session, events, idle } = await start([{ status: 503 }, { text: "好" }], [], { retryPolicy: quickRetry });
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	await done;

	const view = await service.getSession(session.id);
	expect(view.hiccups).toMatchObject([{ outcome: "recovered", attempts: 1, kind: "upstream", at: 1 }]);
	expect(events.filter((event) => event.type === "hiccups").map((event) => event.type === "hiccups" && event.hiccups.map((hiccup) => hiccup.outcome))).toEqual([
		[],
		["waiting"],
		["recovered"],
	]);
	expect(view.summary.stop).toEqual({ reason: "done" });
	expect(model?.requests).toHaveLength(2);
}, 10_000);

it("等重试时换了模型：旧请求当场放手，用新模型从同一处重发，岔子说换了模型", async () => {
	const { service, session, providerId, events, until, idle } = await start(
		(request) => (request.model === "fake" ? { status: 503 } : { text: "新模型答的" }),
		[],
		{
			retryPolicy: {
				network: { retries: null, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
				upstream: { retries: null, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
			},
		},
	);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	await until((event): event is AgentEvent => event.type === "hiccups" && event.hiccups.some((hiccup) => hiccup.outcome === "waiting"));
	await service.setSessionModel(session.id, `${providerId}/other`);
	await done;

	expect(model?.requests.map((request) => request.model)).toEqual(["fake", "other"]);
	const view = await service.getSession(session.id);
	// 放手的那次什么都不留：没人按停，不该有一条「已停止」的空回复。
	expect(view.messages.map((message) => (message.role === "assistant" ? `assistant:${message.stopReason}` : message.role))).toEqual(["user", "assistant:stop"]);
	expect(view.hiccups).toMatchObject([{ outcome: "switched", attempts: 1, switchedTo: "other" }]);
	expect(view.summary.stop).toEqual({ reason: "done" });
	expect(events.some((event) => event.type === "notice")).toBe(false);
}, 10_000);

it("已经在写的回复不因换模型放手，换的模型从下一个请求起用", async () => {
	const { service, session, providerId, until, idle } = await start((request) =>
		request.model === "fake"
			? { text: "旧模型在写", stream: { chunkSize: 1, delayMs: 40 }, toolCalls: [{ id: "call_1", name: "read", args: { path: "hello.txt" } }] }
			: { text: "新模型答的" },
	);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	// 等它出了字再换：只回了响应头、一个字还没说的，照样放手。
	await until((event): event is AgentEvent => event.type === "draft" && JSON.stringify(event.draft?.content ?? []).includes("旧模型在写"));
	await service.setSessionModel(session.id, `${providerId}/other`);
	await done;

	expect(model?.requests.map((request) => request.model)).toEqual(["fake", "other"]);
	const view = await service.getSession(session.id);
	expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	expect(view.hiccups).toEqual([]);
}, 10_000);

it("设置里的重试策略收好范围后存下，没给 retryPolicy 选项时这一轮按它重试", async () => {
	const { service, session, idle } = await start([{ status: 503 }, { text: "好" }]);
	await service.setRetryPolicy({ ...quickRetry!, upstream: { retries: 0, strategy: "fixed", intervalMs: 10, maxIntervalMs: 5 } } as never);
	expect((await service.getSettings()).retryPolicy.upstream).toEqual({ retries: 0, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 });
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	await done;
	// 上游故障不重试：一次请求就以出错收场。
	expect(model?.requests).toHaveLength(1);
	expect((await service.getSession(session.id)).summary.stop?.reason).toBe("error");
});

it("默认思考档位：新会话建时记下，之后改默认不影响已有的会话", async () => {
	const { service, session } = await start([]);
	expect((await service.getSettings()).thinking).toBe("medium");
	expect(session.thinking).toBe("medium");
	await service.setDefaultThinking("high");
	expect((await service.getSettings()).thinking).toBe("high");
	expect((await service.createSession({ cwd: workspace })).thinking).toBe("high");
	expect((await service.getSession(session.id)).summary.thinking).toBe("medium");
	await expect(service.setDefaultThinking("loud" as never)).rejects.toThrow();
});

it("没重试就失败（密钥不对）也留一条岔子，这一轮以出错结束并存盘", async () => {
	const { service, session, idle } = await start([{ status: 401 }], [], { retryPolicy: quickRetry });
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	await done;

	const view = await service.getSession(session.id);
	expect(view.hiccups).toMatchObject([{ outcome: "gave_up", hint: "check-key" }]);
	expect(view.summary.stop?.reason).toBe("error");
	await agent?.shutdown();
	agent = undefined;
	const index = storedRows<{ summary: string }>("SELECT summary FROM sessions").map((row) => JSON.parse(row.summary) as { stop?: { reason: string } });
	expect(index[0]?.stop?.reason).toBe("error");
});

it("流到一半按停止：开了头的工具调用补一条「已停止」的结果，不执行", async () => {
	const { service, session, until, idle } = await start([{ toolCalls: [edit], hang: true }]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "改一下" }] });
	// 草稿按节奏推，最后那块不一定推出来；等第一份草稿，再给流一点时间把工具调用写完。
	await until((event): event is AgentEvent => event.type === "draft" && event.draft !== undefined);
	await new Promise((resolve) => setTimeout(resolve, 100));
	service.stop(session.id);
	await done;

	const view = await service.getSession(session.id);
	const result = view.messages.find((message) => message.role === "toolResult");
	expect(result).toMatchObject({ toolCallId: "call_edit", isError: true, details: { cancelled: true } });
	expect(textOf(result)).toContain("the turn was stopped before it could run");
	expect(view.summary.stop).toEqual({ reason: "aborted" });
	expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hello\n");
});

it("等审批时按停止：结果说它从没执行，标成已停止", async () => {
	const { service, session, until, idle } = await start([{ toolCalls: [readHello, edit] }]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "改一下" }] });
	await until((event): event is AgentEvent => event.type === "approval" && event.approval !== undefined);
	service.stop(session.id);
	await done;

	const result = (await service.getSession(session.id)).messages.find((message) => message.role === "toolResult" && message.toolCallId === "call_edit");
	expect(result).toMatchObject({ isError: true, details: { cancelled: true } });
	expect(textOf(result)).toBe("Tool call was stopped while it waited for approval, so it never ran.");
});

it("回复写完时草稿由那条 message 顶替，不先发一次清空", async () => {
	const { service, session, events, idle } = await start([{ text: "先读一下。", toolCalls: [readHello] }, { text: "读完了" }]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读 hello" }] });
	await done;

	expect(events.some((event) => event.type === "draft" && event.draft !== undefined)).toBe(true);
	expect(events.some((event) => event.type === "draft" && event.draft === undefined)).toBe(false);
	expect(events.filter((event) => event.type === "message" && event.message.role === "assistant")).toHaveLength(2);
	expect((await service.getSession(session.id)).draft).toBeUndefined();
	// 正文写完时推一次带 `ended` 的快照；落进会话的那条不带。
	const drafts = events.flatMap((event) => (event.type === "draft" && event.draft ? [event.draft] : []));
	expect(drafts.some((draft) => draft.content.some((block) => block.type === "text" && block.ended === true))).toBe(true);
	const replies = events.flatMap((event) => (event.type === "message" && event.message.role === "assistant" ? [event.message] : []));
	expect(JSON.stringify(replies)).not.toContain('"ended"');
});

it("调用开始执行时记下时刻：等审批的也算开始了，跑完就作废", async () => {
	const { service, session, events, until, idle } = await start([{ toolCalls: [readHello, edit] }, { text: "好了" }]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "改一下" }] });
	await until((event): event is AgentEvent => event.type === "approval" && event.approval !== undefined);
	const waiting = await service.getSession(session.id);
	expect(Object.keys(waiting.startedAt)).toEqual(["call_edit"]);
	service.respond(session.id, "call_edit", "once");
	await done;

	const started = events.filter((event): event is Extract<AgentEvent, { type: "toolStart" }> => event.type === "toolStart");
	expect(started.map((event) => event.toolCallId)).toEqual(["call_read_hello", "call_edit"]);
	// 开始在前，结果在后。
	const result = events.findIndex((event) => event.type === "message" && event.message.role === "toolResult" && event.message.toolCallId === "call_read_hello");
	expect(events.indexOf(started[0]!)).toBeLessThan(result);
	expect((await service.getSession(session.id)).startedAt).toEqual({});
});

it("工具参数撞上输出上限：不执行、让它拆小；连着四次就以出错停下", async () => {
	const { service, session, idle } = await start([{ toolCalls: [edit], truncated: true }]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "改一下" }] });
	await done;

	const view = await service.getSession(session.id);
	expect(model?.requests).toHaveLength(4);
	const results = view.messages.filter((message) => message.role === "toolResult");
	expect(results).toHaveLength(4);
	expect(textOf(results[0])).toContain("hit the output token limit");
	expect(view.summary.stop).toMatchObject({ reason: "error", error: expect.stringContaining("输出长度上限") });
	expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hello\n");
});

it("界面替人说的话（synthetic）照样发给模型，但不当标题", async () => {
	const { service, session, idle } = await start([{ text: "接着做" }]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "继续，从暂停的地方接着做。" }], synthetic: true });
	await done;

	const view = await service.getSession(session.id);
	expect(view.messages[0]).toMatchObject({ role: "user", synthetic: true });
	expect(view.summary.title).toBe("");
	expect(JSON.stringify(model?.requests[0]?.messages)).toContain("继续，从暂停的地方接着做。");
});

it("busy：一轮在跑时为真，停下以后为假（插件市场的自动更新看它）", async () => {
	const { service, session, until, idle } = await start([{ text: "写到一半", hang: true }]);
	expect(agent!.busy()).toBe(false);
	service.send(session.id, { content: [{ type: "text", text: "写点东西" }] });
	await until((event): event is AgentEvent => event.type === "draft" && event.draft !== undefined);
	expect(agent!.busy()).toBe(true);
	const done = idle();
	service.stop(session.id);
	await done;
	expect(agent!.busy()).toBe(false);
});

it("退出应用时还在跑的一轮记成被中断，不是人按的停", async () => {
	const { service, session, until } = await start([{ text: "写到一半", hang: true }]);
	service.send(session.id, { content: [{ type: "text", text: "写点东西" }] });
	await until((event): event is AgentEvent => event.type === "draft" && event.draft !== undefined);
	await agent?.shutdown();
	agent = undefined;

	const index = storedRows<{ summary: string }>("SELECT summary FROM sessions").map(
		(row) => JSON.parse(row.summary) as { id: string; stop?: { reason: string } },
	);
	expect(index.find((entry) => entry.id === session.id)?.stop).toEqual({ reason: "interrupted" });
});

it("流到一半进程没了：重开以后已经收到的字作为停下的回复还在", async () => {
	const { service, session, until } = await start([{ text: "写到一半", hang: true }]);
	service.send(session.id, { content: [{ type: "text", text: "写点东西" }] });
	await until((event): event is AgentEvent => event.type === "draft" && event.draft !== undefined);
	await new Promise((resolve) => setTimeout(resolve, 50));
	// 不收尾，直接在同一个数据目录上再起一个：就像上一个进程没了。
	const crashed = agent;
	agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "model.json"), plugins: [], log: () => undefined });
	const view = await agent.service.getSession(session.id);
	expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	expect(view.messages[1]).toMatchObject({ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "写到一半" }] });
	await crashed?.shutdown();
});

const read = { id: "call_read", name: "read", args: { path: "hello.txt" } };

it("step.end：本来要结束时插件能让它接着做（synthetic 的一句话），有工具结果时说停不起作用", async () => {
	const steps: number[] = [];
	const nudge: Plugin = {
		name: "test.nudge",
		apply(ctx) {
			ctx.hook("step.end", async (input, next) => {
				steps.push(input.step);
				const verdict = await next(input);
				// 第一步有工具结果：说停也不停。
				if (input.toolResults.length > 0) return { continue: false, reason: "stalled" };
				if (input.step === 2) {
					ctx.notice(input.sessionId, "催了一句", "warn");
					return { continue: true, say: "KEEP_GOING" };
				}
				return verdict;
			});
		},
	};
	const { service, session, events, idle } = await start([{ toolCalls: [read] }, { text: "写到一半" }, { text: "写完了" }], [nudge]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
	await done;

	expect(model?.requests).toHaveLength(3);
	expect(steps).toEqual([1, 2, 3]);
	expect(JSON.stringify(model?.requests[2]?.messages)).toContain("KEEP_GOING");
	const view = await service.getSession(session.id);
	expect(view.messages.find((message) => message.role === "user" && message.synthetic)).toMatchObject({ content: [{ type: "text", text: "KEEP_GOING" }] });
	expect(view.summary.stop).toEqual({ reason: "done" });
	expect(events).toContainEqual({ type: "notice", sessionId: session.id, text: "催了一句", level: "warn" });
});

it("step.end：插件能给结束换原因", async () => {
	const stall: Plugin = { name: "test.stall", apply: (ctx) => ctx.hook("step.end", async () => ({ continue: false, reason: "stalled" })) };
	const { service, session, idle } = await start([{ text: "好了" }], [stall]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "做吧" }] });
	await done;
	expect((await service.getSession(session.id)).summary.stop).toEqual({ reason: "stalled" });
});

it("step.end 出错时按自然结论走并提示", async () => {
	const broken: Plugin = {
		name: "test.broken",
		apply: (ctx) =>
			ctx.hook("step.end", async () => {
				throw new Error("坏了");
			}),
	};
	const { service, session, events, idle } = await start([{ toolCalls: [read] }, { text: "读完了" }], [broken]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
	await done;
	expect(model?.requests).toHaveLength(2);
	expect((await service.getSession(session.id)).summary.stop).toEqual({ reason: "done" });
	expect(events.some((event) => event.type === "notice" && event.text.includes("test.broken") && event.level === undefined)).toBe(true);
});

it("step.end 给的结论认不得（忘了交回 next 的结论、原因不认得）时按自然结论走并提示", async () => {
	const sloppy: Plugin = {
		name: "test.sloppy",
		apply: (ctx) =>
			ctx.hook("step.end", async (input, next) => {
				if (input.step === 1) {
					await next(input);
					return undefined as never;
				}
				return { continue: false, reason: "bogus" } as never;
			}),
	};
	const { service, session, events, idle } = await start([{ toolCalls: [read] }, { text: "读完了" }], [sloppy]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
	await done;
	expect(model?.requests).toHaveLength(2);
	expect((await service.getSession(session.id)).summary.stop).toEqual({ reason: "done" });
	expect(events.filter((event) => event.type === "notice" && event.text.includes("step.end") && event.level === undefined)).toHaveLength(2);
});

it("工具结果的 details 存不成 JSON 时丢掉 details，输出照常交给模型，内存和会话库一致", async () => {
	const odd: Plugin = {
		name: "test.odd-details",
		apply: (ctx) =>
			void ctx.tools.register({
				name: "odd",
				description: "details 里带 BigInt",
				parameters: { type: "object", properties: {} },
				async execute() {
					return { output: "odd done", details: { count: 1n } };
				},
			}),
	};
	const { service, session, idle } = await start([{ toolCalls: [{ id: "call_odd", name: "odd", args: {} }] }, { text: "好了" }], [odd]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "跑一下" }] });
	await done;
	const view = await service.getSession(session.id);
	expect(view.summary.stop).toEqual({ reason: "done" });
	const result = view.messages.find((message) => message.role === "toolResult");
	expect(result).toMatchObject({ toolCallId: "call_odd", isError: false, content: [{ type: "text", text: "odd done" }] });
	expect(result && "details" in result).toBe(false);
	expect(storedRows("SELECT seq FROM records WHERE session_id = ?", session.id)).toHaveLength(view.messages.length);
});

it("一条消息写不进会话库时内存里也没有它，条数和会话库一致（撤回、编辑重发按条数截断）", async () => {
	const { service, session, idle } = await start([{ toolCalls: [read] }, { text: "不该到这里" }]);
	// 模拟磁盘出错：工具结果那一条插入会话库时抛错。
	const prepare = DatabaseSync.prototype.prepare;
	const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
		if (sql.startsWith("INSERT INTO records") && spy.mock.calls.filter(([text]) => text.startsWith("INSERT INTO records")).length === 3)
			throw new Error("disk I/O error");
		return prepare.call(this, sql);
	});
	try {
		const done = idle();
		service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
		await done;
	} finally {
		spy.mockRestore();
	}
	const view = await service.getSession(session.id);
	expect(view.summary.stop?.reason).toBe("error");
	expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	expect(storedRows("SELECT seq FROM records WHERE session_id = ?", session.id)).toHaveLength(2);
	expect(view.summary.messageCount).toBe(2);
});

it("工具结果带 terminate 时，这一步的结果写完就以它的原因结束，不再请求模型", async () => {
	const stop: Plugin = {
		name: "test.terminate",
		apply: (ctx) => ctx.hook("tool.execute", async (input, next) => ({ ...(await next(input)), terminate: "stalled" })),
	};
	const { service, session, idle } = await start([{ toolCalls: [read, { ...read, id: "call_read_2" }] }, { text: "不该到这里" }], [stop]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
	await done;
	expect(model?.requests).toHaveLength(1);
	const view = await service.getSession(session.id);
	expect(view.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
	expect(view.summary.stop).toEqual({ reason: "stalled" });
});

it("工具执行时看得到这一步回复里的全部调用", async () => {
	const seen: string[][] = [];
	const peek: Plugin = {
		name: "test.peek",
		apply: (ctx) =>
			void ctx.tools.register({
				name: "peek",
				description: "看同一步里还有谁",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					seen.push(run.calls.map((call) => `${call.name}:${call.id}`));
					return { output: "ok" };
				},
			}),
	};
	const { service, session, idle } = await start([{ toolCalls: [{ id: "call_peek", name: "peek", args: {} }, read] }, { text: "好了" }], [peek]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "看看" }] });
	await done;
	expect(seen).toEqual([["peek:call_peek", `read:${read.id}`]]);
});

it("撞上输出上限的回复接着写，连着三次以后停下并提示", async () => {
	const { service, session, events, idle } = await start([{ text: "写到一半", truncated: true }]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "写吧" }] });
	await done;
	expect(model?.requests).toHaveLength(4);
	const view = await service.getSession(session.id);
	expect(view.messages.filter((message) => message.role === "user" && message.synthetic && textOfUser(message).includes("输出长度上限"))).toHaveLength(3);
	expect(view.summary.stop).toEqual({ reason: "done" });
	expect(events.filter((event) => event.type === "notice" && event.level === "warn")).toHaveLength(1);
});

it("没有正文的回复催三次，之后以出错结束", async () => {
	const { service, session, idle } = await start([{ text: " " }]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "说话" }] });
	await done;
	expect(model?.requests).toHaveLength(4);
	expect((await service.getSession(session.id)).summary.stop).toEqual({ reason: "error", error: "模型连续返回空回复，请重试或更换模型。" });
});

it("step.end 的层不调 next 就换掉本体的续写", async () => {
	const own: Plugin = { name: "test.own", apply: (ctx) => ctx.hook("step.end", async () => ({ continue: false })) };
	const { service, session, idle } = await start([{ text: "写到一半", truncated: true }], [own]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "写吧" }] });
	await done;
	expect(model?.requests).toHaveLength(1);
});

/** 同一个读文件调用 `count` 次，id 各不相同。 */
const reads = (count: number, from = 0) => Array.from({ length: count }, (_, index) => ({ ...read, id: `call_read_${from + index}` }));

it("同一个调用第 3 次起发给模型的是「这是第 N 次」，提醒只说一次；会话里存的是原文", async () => {
	const { service, session, idle } = await start([{ toolCalls: reads(4) }, { toolCalls: reads(1, 4) }, { text: "好了" }]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
	await done;
	const second = sentText(model?.requests[1]);
	expect(second).toContain("这是你第 3 次");
	expect(second).toContain("这是你第 4 次");
	expect(second.match(/同样的参数调用 `read` 多次/g)).toHaveLength(1);
	expect(sentText(model?.requests[2]).match(/同样的参数调用 `read` 多次/g)).toHaveLength(1);
	const results = (await service.getSession(session.id)).messages.filter((message) => message.role === "toolResult");
	expect(new Set(results.map(textOf)).size).toBe(1);
});

it("第 10 次以「卡住」结束并提示；人发来新消息就从头数", async () => {
	const { service, session, events, idle } = await start([
		{ toolCalls: reads(9) },
		{ text: "好" },
		{ toolCalls: reads(1, 9) },
		{ text: "又好了" },
		{ toolCalls: reads(10, 10) },
		{ text: "不该到这里" },
	]);
	let done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读九次" }] });
	await done;
	done = idle();
	service.send(session.id, { content: [{ type: "text", text: "再读一次" }] });
	await done;
	expect((await service.getSession(session.id)).summary.stop).toEqual({ reason: "done" });

	done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读十次" }] });
	await done;
	expect(model?.requests).toHaveLength(5);
	expect((await service.getSession(session.id)).summary.stop).toEqual({ reason: "stalled" });
	expect(events.filter((event) => event.type === "notice" && event.level === "warn")).toHaveLength(1);
});

it("反复调一个不存在的工具，第 10 次同样以「卡住」结束", async () => {
	const missing = Array.from({ length: 10 }, (_, index) => ({ id: `call_missing_${index}`, name: "missing", args: {} }));
	const { service, session, idle } = await start([{ toolCalls: missing }, { text: "不该到这里" }]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "调一下" }] });
	await done;
	expect(model?.requests).toHaveLength(1);
	const view = await service.getSession(session.id);
	expect(textOf(view.messages.find((message) => message.role === "toolResult"))).toBe("没有名为 missing 的工具。");
	expect(view.summary.stop).toEqual({ reason: "stalled" });
});

/** 一份有 `lines` 行、每行 40 个字的文件。 */
async function bigFile(name: string, lines: number): Promise<void> {
	await writeFile(join(workspace, name), Array.from({ length: lines }, (_, index) => `${String(index).padStart(5, "0")} ${"x".repeat(34)}`).join("\n"));
}

const sentText = (request: Record<string, unknown> | undefined) => JSON.stringify(request?.messages ?? []);

it("太满了先压缩：较早的换成摘要，会话里一条不少，压缩记录存盘", async () => {
	await bigFile("a.txt", 200);
	await bigFile("b.txt", 150);
	const replies: FakeReply[] = [
		{ toolCalls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }] },
		{ text: "读完了 a" },
		{ toolCalls: [{ id: "call_b", name: "read", args: { path: "b.txt" } }] },
		{ text: "SUMMARY_TEXT" },
		{ text: "读完了 b" },
	];
	const { service, session, events, idle } = await start(replies, [], { contextWindow: 6000 });
	let done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下 a.txt" }] });
	await done;
	expect(events.some((event) => event.type === "compaction")).toBe(false);
	done = idle();
	service.send(session.id, { content: [{ type: "text", text: "再读 b.txt" }] });
	await done;

	expect(model?.requests).toHaveLength(5);
	const summary = model?.requests[3];
	expect(JSON.stringify(summary?.system)).toContain("handover summaries");
	expect(sentText(summary)).toContain("读一下 a.txt");
	const after = sentText(model?.requests[4]);
	expect(after).toContain("<session-summary>\\nSUMMARY_TEXT");
	// 折进头里的是 a.txt 的内容；人说过的话作为转录事实留在头里，最新那句原样引用。
	expect(after).not.toContain("[a.txt]");
	expect(after).toContain("Original user request (historical scope):\\n读一下 a.txt");
	expect(after).toContain("<standing-request>");
	expect(after).toContain("再读 b.txt");
	const view = await service.getSession(session.id);
	expect(view.messages).toHaveLength(8);
	// 6000 的窗口里尾部要删到 `settled` 以下：只留读 b.txt 的那一来一回。
	expect(view.compactions).toEqual([{ keptFrom: 5, before: 7, after: 4 }]);
	expect(view.compacting).toBe(false);
	// 转录里那一行跟着压缩走：开始、写摘要，最后收成「已压缩」。
	const changes = events.flatMap((event) => (event.type === "compaction" ? [event] : []));
	expect(changes[0]?.compacting).toBe(true);
	expect(changes.at(-1)?.compacting).toBe(false);
	expect(changes.at(-1)?.runs).toMatchObject([{ status: "done", code: "done", phase: "summarizing", before: 7, after: 4, via: "independent", at: 7 }]);
	expect(view.compactionRuns).toMatchObject([{ status: "done", at: 7 }]);
	const stored = JSON.parse(storedRows<{ context: string }>("SELECT context FROM sessions WHERE id = ?", session.id)[0]?.context ?? "null") as {
		compactions: Array<{ summary: string; head?: unknown[] }>;
	};
	expect(stored.compactions[0]?.summary).toBe("SUMMARY_TEXT");
	// 插件给的头原样存下，以后每次照发。
	expect(stored.compactions[0]?.head).toHaveLength(2);
});

it("context.compact 的层给的边界会拆开调用和结果时当作压缩失败，照常发全文", async () => {
	const keeps: number[] = [];
	const own: Plugin = {
		name: "test.compact",
		apply: (ctx) =>
			ctx.hook("context.compact", async (input) => {
				// 第二步的历史是：人的话、调用、结果；从结果起留会拆开它和它的调用。
				if (input.history.length !== 3) return undefined;
				keeps.push(input.history.length);
				return { keep: 2, summary: "OWN_SUMMARY", head: [{ role: "user", content: [{ type: "text", text: "摘要" }], timestamp: 0 }] };
			}),
	};
	const { service, session, events, idle } = await start([{ toolCalls: [read] }, { text: "读完了" }], [own]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
	await done;
	expect(keeps).toEqual([3]);
	expect(model?.requests).toHaveLength(2);
	expect(sentText(model?.requests[1])).not.toContain("OWN_SUMMARY");
	const view = await service.getSession(session.id);
	expect(view.compactions).toEqual([]);
	// 失败记在转录里那一行上（「压缩失败，保留最近已保存的上下文」），这一步照常发。
	expect(view.compactionRuns).toMatchObject([{ status: "failed", code: "failed" }]);
	expect(events.some((event) => event.type === "compaction" && event.runs.some((run) => run.status === "failed"))).toBe(true);
});

it("服务商说超长：压缩一次再发，失败的那条不进会话", async () => {
	// 短到六条以内、或摘要还没原文长的对话没什么可压的：先读两个文件攒出一段过去（不到拒收时剪成一行的那么大）。
	await bigFile("a.txt", 100);
	await bigFile("b.txt", 100);
	const { service, session, events, idle } = await start([
		{ toolCalls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }] },
		{ toolCalls: [{ id: "call_b", name: "read", args: { path: "b.txt" } }] },
		{ text: "读完了" },
		{ status: 413 },
		{ text: "SUMMARY_TEXT" },
		{ text: "又看了一遍" },
	]);
	let done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
	await done;
	done = idle();
	service.send(session.id, { content: [{ type: "text", text: "再看看" }] });
	await done;

	expect(model?.requests).toHaveLength(6);
	expect(sentText(model?.requests[5])).toContain("SUMMARY_TEXT");
	const view = await service.getSession(session.id);
	expect(view.messages.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"toolResult",
		"assistant",
		"toolResult",
		"assistant",
		"user",
		"assistant",
	]);
	expect(view.messages.some((message) => message.role === "assistant" && message.stopReason === "error")).toBe(false);
	expect(view.hiccups).toEqual([]);
	expect(view.summary.stop).toEqual({ reason: "done" });
	expect(events.some((event) => event.type === "notice" && event.level === "warn" && event.text.includes("上下文超出"))).toBe(true);
});

it("服务商拒收：过大的工具结果剪成一行再发一次，记下来；会话里存的仍是原文", async () => {
	await bigFile("big.txt", 300);
	const { service, session, idle } = await start([
		{ toolCalls: [{ id: "call_big", name: "read", args: { path: "big.txt" } }] },
		{ status: 400 },
		{ text: "好" },
	]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下 big.txt" }] });
	await done;

	expect(model?.requests).toHaveLength(3);
	expect(sentText(model?.requests[1])).toContain("00299");
	expect(sentText(model?.requests[2])).toContain("characters of output withheld");
	expect(sentText(model?.requests[2])).not.toContain("00299");
	const view = await service.getSession(session.id);
	expect(textOf(view.messages.find((message) => message.role === "toolResult"))).toContain("00299");
	expect(view.summary.stop).toEqual({ reason: "done" });
	const stored = JSON.parse(storedRows<{ context: string }>("SELECT context FROM sessions WHERE id = ?", session.id)[0]?.context ?? "null") as {
		withheld: string[];
	};
	expect(stored.withheld).toEqual(["call_big"]);
});

it("打断：停下正在跑的那一轮，等它收完尾再拿这条开始；发给模型时带上打断的说明", async () => {
	const { service, session, until, idle } = await start([{ text: "写着写着", hang: true }, { text: "好，改做这个" }]);
	service.send(session.id, { content: [{ type: "text", text: "写篇长文" }] });
	await until((event): event is AgentEvent => event.type === "draft" && event.draft !== undefined);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "别写了，改做 X" }], interrupt: true });
	await done;

	expect(model?.requests).toHaveLength(2);
	const sent = sentText(model?.requests[1]);
	expect(sent).toContain("（打断）");
	expect(sent).toContain("别写了，改做 X");
	const view = await service.getSession(session.id);
	expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
	expect(view.messages[1]).toMatchObject({ stopReason: "aborted" });
	expect(view.messages[2]).toMatchObject({ interrupting: true, content: [{ type: "text", text: "别写了，改做 X" }] });
	expect(view.summary.stop).toEqual({ reason: "done" });
});

it("插话：一轮正在跑时插进去，做完手上这一步、下一次请求之前读到，带着插话的说明；空闲时就是新的一轮", async () => {
	await bigFile("a.txt", 1);
	const { service, session, until, idle } = await start([
		{ toolCalls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }], stream: { chunkSize: 2, delayMs: 20 } },
		{ text: "好，只看 src/" },
		{ text: "又来了" },
	]);
	let done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
	await until((event): event is AgentEvent => event.type === "draft" && event.draft !== undefined);
	service.send(session.id, { content: [{ type: "text", text: "只看 src/" }], steer: true });
	await done;

	expect(model?.requests).toHaveLength(2);
	expect(sentText(model?.requests[0])).not.toContain("只看 src/");
	expect(sentText(model?.requests[1])).toContain("（插话）");
	const view = await service.getSession(session.id);
	expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
	expect(view.messages[3]).toMatchObject({ steered: true, content: [{ type: "text", text: "只看 src/" }] });
	expect(view.queue).toEqual([]);

	done = idle();
	service.send(session.id, { content: [{ type: "text", text: "再来" }], steer: true });
	await done;
	const after = await service.getSession(session.id);
	expect(after.messages.at(-2)).not.toHaveProperty("steered");
	// 只有前面那句插话带说明，这句开的是新的一轮。
	expect(sentText(model?.requests[2]).match(/（插话）/g)).toHaveLength(1);
});

it("相邻的只读调用同时跑，会改动的排在它们后面；同时要问的审批一次弹一张", async () => {
	const order: string[] = [];
	let running = 0;
	let most = 0;
	const probes: Plugin = {
		name: "test.probes",
		apply(ctx) {
			ctx.tools.register({
				name: "probe",
				description: "慢慢查",
				parameters: { type: "object" },
				async execute(args) {
					running += 1;
					most = Math.max(most, running);
					order.push(`start ${String(args.n)}`);
					await new Promise((resolve) => setTimeout(resolve, 50));
					running -= 1;
					order.push(`end ${String(args.n)}`);
					return { output: "查到了" };
				},
			});
			// 两个只读调用都要问：同时问的排队，一次只弹一张。
			ctx.hook("tool.execute", async (input, next) =>
				input.call.name === "read" && !(await input.ask("要读吗")) ? { output: "不读", isError: true } : next(input),
			);
		},
	};
	const calls = [1, 2, 3].map((n) => ({ id: `call_probe_${n}`, name: "probe", args: { n } }));
	const reads = [1, 2].map((n) => ({ id: `call_read_${n}`, name: "read", args: { path: "hello.txt" } }));
	const { service, session, events, until, idle } = await start(
		[{ toolCalls: [...calls, { id: "call_bash", name: "bash", args: { command: "touch made.txt" } }, ...reads] }, { text: "好了" }],
		[probes],
	);
	// 帮我批准下 touch 看不出风险、不问；这里要它问。
	await service.setPermissionMode("ask");
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "查" }] });
	const asked = (id: string) =>
		until((event): event is Extract<AgentEvent, { type: "approval" }> => event.type === "approval" && event.approval?.toolCallId === id);
	await asked("call_bash");
	expect(most).toBe(3);
	expect(order.slice(0, 3)).toEqual(["start 1", "start 2", "start 3"]);
	service.respond(session.id, "call_bash", "once");
	// 只读调用并发读权限，审批按实际到达顺序排队，不保证 read_1 先出现。等两个都问到了（一张弹着、一张排着）再答：
	// 先答的话，后一个可能在答完之后才问，排队这件事就没测到，事件数也跟着时序变。
	const firstRead = (
		await until(
			(event): event is Extract<AgentEvent, { type: "approval" }> =>
				event.type === "approval" && event.queuedApprovals === 1 && reads.some(({ id }) => event.approval?.toolCallId === id),
		)
	).approval!.toolCallId;
	const shown = () =>
		events.flatMap((event) => (event.type === "approval" && event.approval ? [[event.approval.toolCallId, event.queuedApprovals ?? 0] as const] : []));
	expect(shown()).toEqual([
		["call_bash", 0],
		[firstRead, 0],
		[firstRead, 1],
	]);
	service.respond(session.id, firstRead, firstRead === "call_read_1" ? "once" : "reject");
	const secondRead = firstRead === "call_read_1" ? "call_read_2" : "call_read_1";
	await asked(secondRead);
	expect(shown().slice(3)).toEqual([[secondRead, 0]]);
	service.respond(session.id, secondRead, secondRead === "call_read_1" ? "once" : "reject");
	await done;

	const view = await service.getSession(session.id);
	expect(view.messages.filter((message) => message.role === "toolResult").map((message) => message.role === "toolResult" && message.toolCallId)).toEqual([
		"call_probe_1",
		"call_probe_2",
		"call_probe_3",
		"call_bash",
		"call_read_1",
		"call_read_2",
	]);
	expect(textOf(view.messages.find((message) => message.role === "toolResult" && message.toolCallId === "call_read_2"))).toBe("不读");
});

it("能证明只读的 bash 命令和相邻的只读调用同时跑", async () => {
	let running = 0;
	let most = 0;
	const probes: Plugin = {
		name: "test.probes",
		apply(ctx) {
			ctx.tools.register({
				name: "probe",
				description: "慢慢查",
				parameters: { type: "object" },
				async execute() {
					running += 1;
					most = Math.max(most, running);
					await new Promise((resolve) => setTimeout(resolve, 80));
					running -= 1;
					return { output: "查到了" };
				},
			});
		},
	};
	const calls = [
		{ id: "call_probe_1", name: "probe", args: {} },
		{ id: "call_look", name: "bash", args: { command: "ls -la | head -3" } },
		{ id: "call_probe_2", name: "probe", args: {} },
	];
	const { service, session, idle } = await start([{ toolCalls: calls }, { text: "好了" }], [probes]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "查" }] });
	await done;
	expect(most).toBe(2);
});

it("只读命令不问；完全访问下会改动的也不问，命令不进沙箱", async () => {
	const look = { id: "call_look", name: "bash", args: { command: "cat hello.txt | head -1" } };
	const make = { id: "call_make", name: "bash", args: { command: "echo made > made.txt" } };
	const { service, session, events, idle } = await start([{ toolCalls: [look] }, { toolCalls: [readHello, edit, make] }, { text: "好了" }]);
	await service.setPermissionMode("full");
	expect((await service.getSettings()).permissionMode).toBe("full");

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "改" }] });
	await done;
	expect(events.some((event) => event.type === "approval" && event.approval !== undefined)).toBe(false);
	expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hi\n");
	expect(await readFile(join(workspace, "made.txt"), "utf8")).toBe("made\n");
});

/** tool.approve 外层的一层：记下见过的调用，层自己问的替人放行，edit 替人拒绝。 */
function approveGuard(seen: { tool: string; byLayer?: boolean }[]): Plugin {
	return {
		name: "test.guard",
		apply(ctx) {
			ctx.hook("tool.approve", async (input, next) => {
				seen.push({ tool: input.tool.name, byLayer: input.byLayer });
				if (input.byLayer) return "once";
				return input.tool.name === "edit" ? "reject" : next(input);
			});
			ctx.hook("tool.execute", async (input, next) =>
				input.call.name === "read" && !(await input.ask("要读吗")) ? { output: "不读", isError: true } : next(input),
			);
		},
	};
}

it("tool.approve 的外层能替人放行、替人拒绝", async () => {
	const seen: { tool: string; byLayer?: boolean }[] = [];
	const { service, session, events, idle } = await start([{ toolCalls: [readHello, edit] }, { text: "好了" }], [approveGuard(seen)]);
	await service.setPermissionMode("ask");

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "改" }] });
	await done;
	expect(events.some((event) => event.type === "approval" && event.approval !== undefined)).toBe(false);
	expect(seen).toEqual([{ tool: "read", byLayer: true }, { tool: "edit" }]);
	expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hello\n");
});

it("完全访问由本体放行，不经 tool.approve：外层拒绝不了，层自己问的也放行", async () => {
	const seen: { tool: string; byLayer?: boolean }[] = [];
	const { service, session, events, idle } = await start([{ toolCalls: [readHello, edit] }, { text: "好了" }], [approveGuard(seen)]);
	await service.setPermissionMode("full");

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "改" }] });
	await done;
	expect(events.some((event) => event.type === "approval" && event.approval !== undefined)).toBe(false);
	expect(seen).toEqual([]);
	expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hi\n");
});

it("userOnly 的问题完全访问下也弹给人", async () => {
	const decide: Plugin = {
		name: "test.decide",
		apply(ctx) {
			ctx.tools.register({
				name: "decide",
				description: "要人拍板",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					return { output: await run.ask({ kind: "decide", title: "拍板", detail: "做不做", userOnly: true }) };
				},
			});
		},
	};
	const call = { id: "call_decide", name: "decide", args: {} };
	const { service, session, until, idle } = await start([{ toolCalls: [call] }, { text: "好了" }], [decide]);
	await service.setPermissionMode("full");

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "定" }] });
	const asked = await until((event): event is Extract<AgentEvent, { type: "approval" }> => event.type === "approval" && event.approval !== undefined);
	expect(asked.approval).toMatchObject({ toolCallId: "call_decide", userOnly: true });
	service.respond(session.id, "call_decide", "once");
	await done;
	const result = (await service.getSession(session.id)).messages.find((message) => message.role === "toolResult");
	expect(result?.content[0]).toMatchObject({ text: "once" });
});

/** 一个不改动工作区、自己经 `run.ask` 问人的工具：同一步里调几次就同时问几张。 */
const asker: Plugin = {
	name: "test.asker",
	apply(ctx) {
		ctx.tools.register({
			name: "decide",
			description: "要人拍板",
			parameters: { type: "object", properties: {} },
			asks: true,
			async execute(_args, run) {
				return { output: await run.ask({ kind: "decide", title: "拍板", detail: "做不做", userOnly: true }) };
			},
		});
	},
};
type ApprovalEvent = Extract<AgentEvent, { type: "approval" }>;
const isApproval = (event: AgentEvent): event is ApprovalEvent => event.type === "approval";

it("只能由人答的，tool.approve 的层答放行不算数、照样弹卡；层的拒绝照算", async () => {
	const guard: Plugin = {
		name: "test.guard",
		apply(ctx) {
			ctx.hook("tool.approve", async (input) => (input.call.id === "call_pass" ? "once" : "reject"));
		},
	};
	const pass = { id: "call_pass", name: "decide", args: {} };
	const deny = { id: "call_deny", name: "decide", args: {} };
	const { service, session, events, until, idle } = await start([{ toolCalls: [pass] }, { toolCalls: [deny] }, { text: "好了" }], [asker, guard]);
	await service.setPermissionMode("full");

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "定" }] });
	await until((event): event is ApprovalEvent => isApproval(event) && event.approval?.toolCallId === "call_pass");
	service.respond(session.id, "call_pass", "reject");
	await done;
	expect(new Set(events.flatMap((event) => (isApproval(event) && event.approval ? [event.approval.toolCallId] : [])))).toEqual(new Set(["call_pass"]));
	const results = (await service.getSession(session.id)).messages.filter((message) => message.role === "toolResult");
	expect(results.map(textOf)).toEqual(["reject", "reject"]);
});

it("没人答的审批到时按拒绝收场：权限请求和只能由人答的问题各等各的，截止时刻随卡片发出", async () => {
	const touch = { id: "call_touch", name: "bash", args: { command: "touch made.txt" } };
	const decide = { id: "call_decide", name: "decide", args: {} };
	const { service, session, events, until, idle } = await start([{ toolCalls: [touch] }, { toolCalls: [decide] }, { text: "好了" }], [asker], {
		approvalTimeoutMs: { permission: 150, question: 400 },
	});
	await service.setPermissionMode("ask");

	const done = idle();
	const before = Date.now();
	service.send(session.id, { content: [{ type: "text", text: "做" }] });
	const permission = await until((event): event is ApprovalEvent => isApproval(event) && event.approval?.toolCallId === "call_touch");
	const permissionLeft = permission.approval!.expiresAt! - before;
	expect(permissionLeft).toBeGreaterThanOrEqual(150);
	expect(permissionLeft).toBeLessThan(400);
	const waiting = await service.getSession(session.id);
	expect(waiting.approval?.expiresAt).toBe(permission.approval!.expiresAt);
	const question = await until((event): event is ApprovalEvent => isApproval(event) && event.approval?.toolCallId === "call_decide");
	expect(question.approval!.expiresAt! - Date.now()).toBeGreaterThan(200);
	await done;

	const results = (await service.getSession(session.id)).messages.filter((message) => message.role === "toolResult");
	expect(textOf(results[0])).toContain("The user rejected this");
	expect(textOf(results[1])).toBe("reject");
	await expect(readFile(join(workspace, "made.txt"), "utf8")).rejects.toThrow();
	expect(events.findLast(isApproval)?.approval).toBeUndefined();
});

it("同时要问的排队：卡上带后面还排着几张，答一张换下一张；按停止全部收掉", async () => {
	const calls = [1, 2, 3].map((n) => ({ id: `call_decide_${n}`, name: "decide", args: { n } }));
	const { service, session, events, until, idle } = await start([{ toolCalls: calls }, { text: "好了" }], [asker]);

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "定" }] });
	const full = await until((event): event is ApprovalEvent => isApproval(event) && event.queuedApprovals === 2);
	const first = full.approval!.toolCallId;
	const view = await service.getSession(session.id);
	expect(view.approval?.toolCallId).toBe(first);
	expect(view.queuedApprovals).toBe(2);
	// 只认弹着的那张：排着的答了不算。
	const queued = calls.find((call) => call.id !== first)!.id;
	service.respond(session.id, queued, "once");
	service.respond(session.id, first, "once");
	const next = await until((event): event is ApprovalEvent => isApproval(event) && event.approval !== undefined && event.approval.toolCallId !== first);
	expect(next.queuedApprovals).toBe(1);
	expect(next.approval!.expiresAt).toBeGreaterThan(Date.now());

	const from = events.length;
	service.stop(session.id);
	await done;
	const cleared = events.slice(from).findLast(isApproval);
	expect(cleared).toMatchObject({ approval: undefined });
	expect(cleared?.queuedApprovals).toBeUndefined();
	const after = await service.getSession(session.id);
	expect(after.approval).toBeUndefined();
	const results = after.messages.filter((message) => message.role === "toolResult");
	expect(results.map((message) => message.role === "toolResult" && message.toolCallId).sort()).toEqual(calls.map((call) => call.id).sort());
	expect(results.filter((message) => textOf(message) === "once")).toHaveLength(1);
});

it.skipIf(process.platform !== "darwin")("tool.execute 的层要求只读时，完全访问下命令也跑在只读沙箱里", async () => {
	const readOnly: Plugin = {
		name: "test.read-only",
		apply(ctx) {
			ctx.hook("tool.execute", (input, next) => next({ ...input, readOnly: true }));
		},
	};
	const write = { id: "call_write", name: "bash", args: { command: "echo x > made.txt" } };
	const { service, session, idle } = await start([{ toolCalls: [write] }, { text: "好了" }], [readOnly]);
	await service.setPermissionMode("full");

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "写" }] });
	await done;
	await expect(readFile(join(workspace, "made.txt"), "utf8")).rejects.toThrow();
});

it("答「以后不再问」记进设置，同一条命令下次不再问", async () => {
	const once = { id: "call_one", name: "bash", args: { command: "echo one >> log.txt", description: "记一行日志" } };
	const again = { id: "call_two", name: "bash", args: { command: "echo one >> log.txt" } };
	const { service, session, events, until, idle } = await start([{ toolCalls: [once] }, { toolCalls: [again] }, { text: "好了" }]);
	await service.setPermissionMode("full");
	await service.setPermissionMode("ask");

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "记两次" }] });
	const asked = await until((event): event is Extract<AgentEvent, { type: "approval" }> => event.type === "approval" && event.approval !== undefined);
	// 标题是模型写的那句用途，正文才是命令。
	expect(asked.approval).toMatchObject({ kind: "bash", title: "记一行日志", subject: "echo one >> log.txt", detail: "echo one >> log.txt" });
	service.respond(session.id, "call_one", "always");
	await done;

	expect(events.filter((event) => event.type === "approval" && event.approval !== undefined)).toHaveLength(1);
	const stored = JSON.parse(await readFile(join(dir, "model.json"), "utf8")) as { alwaysAllow?: string[]; permissionMode?: string };
	expect(stored).toMatchObject({ alwaysAllow: ["echo one >> log.txt"], permissionMode: "ask" });
});

it.skipIf(process.platform !== "darwin")("请求批准下命令跑在只读沙箱里：写被拒、模型拿到提权提示；提权只能答一次，放宽后写得进去", async () => {
	const write = { id: "call_write", name: "bash", args: { command: "echo x > made.txt" } };
	const retry = { id: "call_retry", name: "bash", args: { command: "echo x > made.txt", escalate: "workspace-write", justification: "要写测试文件" } };
	const { service, session, until, idle } = await start([{ toolCalls: [write] }, { toolCalls: [retry] }, { text: "好了" }]);
	await service.setPermissionMode("ask");

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "写" }] });
	await until((event): event is AgentEvent => event.type === "approval" && event.approval?.toolCallId === "call_write");
	service.respond(session.id, "call_write", "always");
	const escalation = await until(
		(event): event is Extract<AgentEvent, { type: "approval" }> => event.type === "approval" && event.approval?.toolCallId === "call_retry",
	);
	expect(escalation.approval).toMatchObject({ kind: "bash", reason: "要写测试文件", escalation: "workspace-write" });
	expect(escalation.approval?.subject).toBeUndefined();
	service.respond(session.id, "call_retry", "once");
	await done;

	const results = (await service.getSession(session.id)).messages.filter((message) => message.role === "toolResult");
	expect(results[0]).toMatchObject({ toolCallId: "call_write", isError: true });
	expect(textOf(results[0])).toContain("escalate");
	expect(results[1]).toMatchObject({ toolCallId: "call_retry", isError: false });
	expect(await readFile(join(workspace, "made.txt"), "utf8")).toBe("x\n");
});

it.skipIf(process.platform !== "darwin")("帮我批准下看不出风险的命令不问、能写项目目录；命中规则的问人，卡上写着理由", async () => {
	const safe = { id: "call_safe", name: "bash", args: { command: "echo x > made.txt" } };
	const risky = { id: "call_risky", name: "bash", args: { command: "git push --force origin main" } };
	const { service, session, events, until, idle } = await start([{ toolCalls: [safe] }, { toolCalls: [risky] }, { text: "好了" }]);
	expect((await service.getSettings()).permissionMode).toBe("auto");

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "写，再删" }] });
	const asked = await until(
		(event): event is Extract<AgentEvent, { type: "approval" }> => event.type === "approval" && event.approval?.toolCallId === "call_risky",
	);
	expect(asked.approval).toMatchObject({ kind: "bash", subject: "git push --force origin main", reason: "强制推送会覆盖远程历史" });
	service.respond(session.id, "call_risky", "reject");
	await done;

	expect(events.some((event) => event.type === "approval" && event.approval?.toolCallId === "call_safe")).toBe(false);
	expect(await readFile(join(workspace, "made.txt"), "utf8")).toBe("x\n");
});

it("归档、删归档、按日期清：花销留着，正在跑的不删", async () => {
	let ctx: PluginContext | undefined;
	const plugin: Plugin = { name: "test.usage", apply: (context) => void (ctx = context) };
	const { service, session, until, idle } = await start([{ text: "好" }, { text: "我来改。", toolCalls: [readHello, edit] }], [plugin]);
	const requests = async () => ((await ctx?.model.usage())?.requests ?? []).reduce((sum, bucket) => sum + bucket.requests, 0);
	let done = idle();
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	await done;
	expect(await requests()).toBe(1);
	expect(Object.values((await ctx?.model.usage())?.providerNames ?? {})).toContain("假模型");

	await service.setSessionArchived(session.id, true);
	expect(service.listSessions().find((summary) => summary.id === session.id)?.archived).toBe(true);
	expect((await service.storageUse()).sessions).toBe(1);
	expect(await service.deleteArchivedSessions()).toBe(1);
	expect(service.listSessions()).toEqual([]);
	// 删会话不动花销。
	expect(await requests()).toBe(1);

	// 等审批的那一轮还在跑：清全部时跳过它。
	const running = await service.createSession({ cwd: workspace });
	const idleOne = await service.createSession({ cwd: workspace });
	done = idle();
	service.send(running.id, { content: [{ type: "text", text: "改一下" }] });
	await until((event): event is Extract<AgentEvent, { type: "approval" }> => event.type === "approval" && event.approval !== undefined);
	expect(await service.clearSessions({ from: null, to: null })).toMatchObject({ removed: 1, skipped: 1 });
	expect(service.listSessions().map((summary) => summary.id)).toEqual([running.id]);
	expect(service.listSessions().some((summary) => summary.id === idleOne.id)).toBe(false);
	service.stop(running.id);
	await done;
});

it("按日期清只挑顶层会话：子会话不单独算，跟着父会话删", async () => {
	let ctx: PluginContext | undefined;
	const plugin: Plugin = { name: "test.children", apply: (context) => void (ctx = context) };
	const { service, session } = await start([], [plugin]);
	const child = await ctx!.sessions.create({ parentId: session.id });
	expect((await service.storageUse()).sessions).toBe(1);
	expect(await service.clearSessions({ from: null, to: null })).toMatchObject({ removed: 1, skipped: 0 });
	expect(service.listSessions().some((summary) => summary.id === child.id || summary.id === session.id)).toBe(false);
});

it("使用统计：主请求按来源分 token，记下轮次和工具；缓存没读到时按前缀指纹和撤回归因", async () => {
	let ctx: PluginContext | undefined;
	const plugin: Plugin = { name: "test.usage", apply: (context) => void (ctx = context) };
	const { service, session, idle } = await start(
		[{ text: "我看看。", toolCalls: [readHello], cache: { write: 5_000 } }, { text: "看完了" }, { text: "改好了" }],
		[plugin],
	);
	let done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下 hello.txt" }] });
	await done;
	// 第二次请求原样接着第一次：前缀指纹量过，没有变化。
	const second = (await service.getSession(session.id)).messages.at(-1);
	expect(second).toMatchObject({ role: "assistant", prefix: { segments: expect.any(Number) } });
	expect(second?.role === "assistant" && second.prefix?.change).toBeUndefined();

	// 编辑重发：截掉的那段之后的第一次请求，没读到缓存记成撤回，不记成改写了消息。
	done = idle();
	await service.editMessage(session.id, 0, { content: [{ type: "text", text: "算了，改一下" }] });
	await done;
	const [bucket] = (await ctx!.model.usage()).requests;
	expect(bucket).toMatchObject({ requests: 3, sessions: [session.id], turns: 2, tools: 1, toolErrors: 0, timedReplies: 3 });
	// 这个模型报过缓存以后再一点没读到：第二次前缀没变是服务商没读到，第三次是撤回。
	expect(Object.keys(bucket!.cacheMiss.byCause).sort()).toEqual(["provider", "rewind"]);
	expect(bucket!.cacheMiss.tokens).toBeGreaterThan(0);
	const parts = bucket!.parts;
	for (const part of ["system", "toolDefs", "user", "assistant", "toolResults", "outputReply"] as const) expect(parts[part]).toBeGreaterThan(0);
	const total = Object.values(parts).reduce((sum, value) => sum + value, 0);
	expect(total).toBeCloseTo(bucket!.input + bucket!.cacheRead + bucket!.cacheWrite + bucket!.output);
});

it("prompt.submit：拦下的消息不写进会话、不调模型，理由弹成提示条", async () => {
	const seen: Array<{ text: string; fresh: boolean }> = [];
	const gate: Plugin = {
		name: "test.gate",
		apply: (ctx) =>
			ctx.hook("prompt.submit", async (input, next) => {
				seen.push({ text: input.text, fresh: input.fresh });
				return input.text.includes("秘密") ? { block: true, reason: "不许说秘密" } : next(input);
			}),
	};
	const { service, session, events, idle, until } = await start([{ text: "好的" }], [gate]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "说个秘密" }] });
	await done;
	expect(model?.requests ?? []).toHaveLength(0);
	expect((await service.getSession(session.id)).messages).toHaveLength(0);
	expect(events).toContainEqual({ type: "notice", sessionId: session.id, text: "不许说秘密", level: "warn" });

	const from = events.length;
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	await until((event): event is AgentEvent => event.type === "message" && event.message.role === "assistant", from);
	expect(seen).toEqual([
		{ text: "说个秘密", fresh: true },
		{ text: "你好", fresh: true },
	]);
	expect((await service.getSession(session.id)).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
});

it("prompt.submit：放行时带的话以 synthetic 用户消息跟在后面，模型读得到", async () => {
	const remind: Plugin = { name: "test.remind", apply: (ctx) => ctx.hook("prompt.submit", async () => ({ block: false, context: "REMINDER" })) };
	const { service, session, idle } = await start([{ text: "收到" }], [remind]);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "开始" }] });
	await done;
	expect(JSON.stringify(model?.requests[0]?.messages)).toContain("REMINDER");
	const view = await service.getSession(session.id);
	expect(view.messages[1]).toMatchObject({ role: "user", synthetic: true, content: [{ type: "text", text: "REMINDER" }] });
	expect(view.summary.title).toBe("开始");
});

it("prompt.submit：放行时给了 cwd，这一轮起在那个目录里跑；不是已有目录就不换", async () => {
	const copy = join(dir, "copy");
	await mkdir(copy);
	let target = copy;
	const seen: string[] = [];
	const move: Plugin = {
		name: "test.move",
		apply(ctx) {
			ctx.hook("prompt.submit", async (input, next) => ({ ...(await next(input)), cwd: target }));
			ctx.hook("model.context", async (input, next) => {
				seen.push(input.cwd);
				return next(input);
			});
		},
	};
	const { service, session, idle } = await start([{ text: "一" }, { text: "二" }], [move]);
	let done = idle();
	service.send(session.id, { content: [{ type: "text", text: "开始" }] });
	await done;
	// 一轮收尾后宿主还会组一次下一轮的请求，问要不要趁热压缩（`ContextCompact.idle`）：每一次都在新目录里。
	expect(seen.length).toBeGreaterThan(0);
	expect(seen.every((cwd) => cwd === copy)).toBe(true);
	expect((await service.getSession(session.id)).summary.cwd).toBe(copy);

	target = join(dir, "missing");
	const before = seen.length;
	done = idle();
	service.send(session.id, { content: [{ type: "text", text: "再来" }] });
	await done;
	expect(seen.length).toBeGreaterThan(before);
	expect(seen.every((cwd) => cwd === copy)).toBe(true);
	expect(service.listSessions().find((summary) => summary.id === session.id)?.cwd).toBe(copy);
});

it("onArchived：归档、取消归档时告诉插件，没变就不说；插件经 setArchived 归档也一样，子会话不能单独归档", async () => {
	const seen: Array<[string, boolean]> = [];
	let access!: PluginContext["sessions"];
	const watcher: Plugin = {
		name: "test.archive",
		apply(ctx) {
			access = ctx.sessions;
			ctx.sessions.onArchived((sessionId, archived) => seen.push([sessionId, archived]));
		},
	};
	const { service, session } = await start([], [watcher]);
	await service.setSessionArchived(session.id, true);
	await service.setSessionArchived(session.id, true);
	await service.setSessionArchived(session.id, false);
	await access.setArchived(session.id, true);
	expect(service.listSessions().find((summary) => summary.id === session.id)?.archived).toBe(true);
	expect(seen).toEqual([
		[session.id, true],
		[session.id, false],
		[session.id, true],
	]);
	const child = await access.create({ parentId: session.id });
	await expect(access.setArchived(child.id, true)).rejects.toThrow("子会话");
	await expect(access.setArchived("missing", true)).rejects.toThrow("没有会话");
});

it("命令：按插件加载先后列出、同名留第一条，展开交给供它的插件", async () => {
	const first: Plugin = {
		name: "test.first",
		apply: (ctx) =>
			ctx.commands.provide({
				list: (context) => [
					{ name: "review", description: "审查", argumentHint: "[路径]" },
					{ name: "Bad Name", description: "不合规矩" },
					{ name: "where", description: context.cwd ?? "无目录" },
				],
				expand: (name, rest, context) => ({ text: `${name}:${rest}:${context.cwd}`, displayText: `/${name} ${rest}` }),
			}),
	};
	const second: Plugin = {
		name: "test.second",
		apply: (ctx) => {
			ctx.commands.provide({
				list: () => [
					{ name: "review", description: "被盖住" },
					{ name: "git:commit", description: "提交", source: "项目" },
					{ name: "aside", description: "自己办掉" },
					{ name: "manage", description: "打开设置" },
				],
				expand: (name) =>
					name === "aside"
						? ({ handled: true, openPanel: "chat", extra: 1 } as never)
						: name === "manage"
							? ({ handled: true, openSettings: "commands", openPanel: 3 } as never)
							: { text: "commit" },
			});
			ctx.commands.provide({
				list: () => {
					throw new Error("坏了");
				},
				expand: () => ({ text: "" }),
			});
		},
	};
	const { service } = await start([], [first, second]);
	const listed = await service.listCommands({ cwd: "/work" });
	// 内置插件先加载：plume.compaction 的 `/compact` 在最前。
	expect(listed).toEqual([
		{ name: "compact", description: "压缩上下文", argumentHint: "可选：希望摘要保留的内容", plugin: "plume.compaction" },
		{ name: "review", description: "审查", argumentHint: "[路径]", plugin: "test.first" },
		{ name: "where", description: "/work", plugin: "test.first" },
		{ name: "git:commit", description: "提交", source: "项目", plugin: "test.second" },
		{ name: "aside", description: "自己办掉", plugin: "test.second" },
		{ name: "manage", description: "打开设置", plugin: "test.second" },
	]);
	expect(await service.expandCommand("test.first", "review", "src", { cwd: "/work" })).toEqual({ text: "review:src:/work", displayText: "/review src" });
	await expect(service.expandCommand("test.second", "nope", "", {})).rejects.toThrow("test.second");
	// 插件自己办掉的命令：只转交认得的几项，类型不对的丢掉。
	expect(await service.expandCommand("test.second", "aside", "", {})).toEqual({ handled: true, openPanel: "chat" });
	expect(await service.expandCommand("test.second", "manage", "", {})).toEqual({ handled: true, openSettings: "commands" });
	await service.setPluginEnabled("test.first", false);
	expect((await service.listCommands({})).map((command) => `${command.plugin}/${command.name}`)).toEqual([
		"plume.compaction/compact",
		"test.second/review",
		"test.second/git:commit",
		"test.second/aside",
		"test.second/manage",
	]);
});

it("子会话：插件在工具里建子会话、跑一轮拿回答；不进别人手里，父会话删掉时一起删", async () => {
	let access: PluginContext["sessions"] | undefined;
	let child: string | undefined;
	const deleted: string[] = [];
	const owner: Plugin = {
		name: "test.child",
		apply(ctx) {
			access = ctx.sessions;
			ctx.sessions.onDeleted((sessionId) => deleted.push(sessionId));
			ctx.tools.register({
				name: "delegate",
				description: "派一个子会话",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					const created = await ctx.sessions.create({ parentId: run.sessionId, title: "  查一件事  " });
					child = created.id;
					const stop = await ctx.sessions.send(created.id, "去查", { signal: run.signal });
					const messages = await ctx.sessions.messages(created.id);
					const reply = messages.findLast((message) => message.role === "assistant");
					const text = reply?.role === "assistant" ? reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") : "";
					return { output: `${stop.reason}: ${text}` };
				},
			});
		},
	};
	let other: PluginContext["sessions"] | undefined;
	const stranger: Plugin = { name: "test.stranger", apply: (ctx) => void (other = ctx.sessions) };
	const { service, session, idle } = await start(
		[{ toolCalls: [{ id: "call_delegate", name: "delegate", args: {} }] }, { text: "子会话的答复" }, { text: "收到" }],
		[owner, stranger],
	);
	await service.setSessionModel(session.id, `${(await service.getSettings()).providers[0]?.id}/other`);

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "派一个" }] });
	await done;

	const summary = service.listSessions().find((entry) => entry.id === child);
	expect(summary).toMatchObject({ parentId: session.id, owner: "test.child", cwd: workspace, title: "查一件事" });
	// 子会话没另选模型：跟着父会话。
	expect(model?.requests.map((request) => request.model)).toEqual(["other", "other", "other"]);
	const result = (await service.getSession(session.id)).messages.find((message) => message.role === "toolResult");
	expect(JSON.stringify(result?.content)).toContain("done: 子会话的答复");
	expect((await service.getSession(child as string)).messages.map((message) => message.role)).toEqual(["user", "assistant"]);

	// 界面、别的插件都不能在里面发起一轮或删掉它；子会话下面不再挂子会话。
	expect(() => service.send(child as string, { content: [{ type: "text", text: "插一句" }] })).toThrow("test.child");
	await expect(other?.send(child as string, "插一句")).rejects.toThrow("test.stranger");
	await expect(other?.delete(child as string)).rejects.toThrow("test.stranger");
	await expect(access?.create({ parentId: child as string })).rejects.toThrow("下面不能再建子会话");

	await service.deleteSession(session.id);
	expect(service.listSessions().map((entry) => entry.id)).not.toContain(child);
	expect(deleted.sort()).toEqual([session.id, child].sort());
	expect(storedRows("SELECT id FROM sessions WHERE id = ?", child as string)).toEqual([]);
});

it("子会话：signal 中止时这一轮停下，插件自己能删掉它", async () => {
	let access: PluginContext["sessions"] | undefined;
	const plugin: Plugin = { name: "test.child", apply: (ctx) => void (access = ctx.sessions) };
	const { session } = await start([{ text: "一半", hang: true }], [plugin]);
	const child = await access?.create({ parentId: session.id });
	const controller = new AbortController();
	const running = access?.send(child?.id as string, "说点什么", { signal: controller.signal });
	await expect(access?.send(child?.id as string, "再说一句")).rejects.toThrow("正在运行");
	controller.abort();
	expect(await running).toEqual({ reason: "aborted" });
	await access?.delete(child?.id as string);
	expect(agent?.service.listSessions().map((entry) => entry.id)).toEqual([session.id]);
});

it("撤回：这条和之后的全部截掉，库里跟着删；之后发给模型的历史里没有截掉的那段", async () => {
	const { service, session, events, until, idle } = await start([{ text: "第一个回答" }, { text: "第二个回答" }, { text: "重来的回答" }]);
	for (const words of ["第一问", "第二问"]) {
		const done = idle();
		service.send(session.id, { content: [{ type: "text", text: words }] });
		await done;
	}
	expect((await service.getSession(session.id)).summary.messageCount).toBe(4);
	// 回复和界面替人说的那句都不是能撤回的东西。
	await expect(service.revertMessage(session.id, 1)).rejects.toThrow("找不到这条消息");
	await service.revertMessage(session.id, 2);
	const rewound = await until((event): event is AgentEvent => event.type === "rewound");
	expect(rewound).toMatchObject({ sessionId: session.id, count: 2, compactions: [] });
	// 撤回随后报的那次会话列表到了再等空闲，不然等到的是它。
	await until((event): event is AgentEvent => event.type === "sessions", events.indexOf(rewound) + 1);
	const view = await service.getSession(session.id);
	expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	expect(view.summary.stop).toBeUndefined();
	expect(view.summary.messageCount).toBe(2);
	expect(storedRows<{ seq: number }>("SELECT seq FROM records WHERE session_id = ? ORDER BY seq", session.id).map((row) => row.seq)).toEqual([1, 2]);

	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "换个问法" }] });
	await done;
	const sent = sentText(model?.requests[2]);
	expect(sent).toContain("第一问");
	expect(sent).not.toContain("第二问");
	expect(storedRows<{ seq: number }>("SELECT seq FROM records WHERE session_id = ? ORDER BY seq", session.id).map((row) => row.seq)).toEqual([1, 2, 3, 4]);
});

it("消息事件带着写进后的条数；撤回按界面给的时间戳认回那一条，序号差了也不截错，认不出就不截", async () => {
	const { service, session, events, until, idle } = await start([{ text: "第一个回答" }, { text: "第二个回答" }]);
	for (const words of ["第一问", "第二问"]) {
		const done = idle();
		service.send(session.id, { content: [{ type: "text", text: words }] });
		await done;
	}
	expect(events.flatMap((event) => (event.type === "message" ? [event.count] : []))).toEqual([1, 2, 3, 4]);
	const second = (await service.getSession(session.id)).messages[2]!;
	// 界面多收了一条，以为第二问是第 3 条：按时间戳认回第 2 条。
	await expect(service.revertMessage(session.id, 3, { timestamp: second.timestamp + 1 })).rejects.toThrow("找不到这条消息");
	await service.revertMessage(session.id, 3, { timestamp: second.timestamp });
	expect(await until((event): event is AgentEvent => event.type === "rewound")).toMatchObject({ count: 2 });
});

it("编辑重发：截掉这条和之后的，拿新的话重新跑一轮；跑着的时候不让改", async () => {
	const { service, session, events, until, idle } = await start([{ text: "旧回答" }, { text: "一半", hang: true }]);
	let done = idle();
	service.send(session.id, { content: [{ type: "text", text: "原来的问题" }] });
	await done;
	const from = events.length;
	await service.editMessage(session.id, 0, { content: [{ type: "text", text: "改过的问题" }], displayText: "改过的问题" });
	await until((event): event is AgentEvent => event.type === "draft" && event.draft !== undefined, from);
	await expect(service.editMessage(session.id, 0, { content: [{ type: "text", text: "再改" }] })).rejects.toThrow("正在运行");
	await expect(service.revertMessage(session.id, 0)).rejects.toThrow("正在运行");
	const sent = sentText(model?.requests[1]);
	expect(sent).toContain("改过的问题");
	expect(sent).not.toContain("原来的问题");
	expect(sent).not.toContain("旧回答");
	done = idle();
	service.stop(session.id);
	await done;
	const view = await service.getSession(session.id);
	expect(view.messages[0]).toMatchObject({ role: "user", displayText: "改过的问题" });
});

it("session.rewind：截掉之前先问插件那段改过的文件；退不回去就不截、原话报给人，只截对话时不问", async () => {
	const asked: Array<{ roles: string[]; restore: boolean; cwd: string }> = [];
	let refuse = false;
	const files: Plugin = {
		name: "test.files",
		apply: (ctx) =>
			ctx.hook("session.rewind", async (input, next) => {
				asked.push({ roles: input.messages.map((message) => message.role), restore: input.restore, cwd: input.cwd });
				if (input.restore && refuse) throw new Error("a.ts 之后被改过，没有退回");
				const inner = await next(input);
				return { files: [...inner.files, { path: join(input.cwd, "a.ts"), added: 1, removed: 0, problem: null }], unrecorded: inner.unrecorded };
			}),
	};
	const { service, session, events, until, idle } = await start([{ text: "第一个回答" }, { text: "第二个回答" }, { text: "重来的回答" }], [files]);
	for (const words of ["第一问", "第二问"]) {
		const done = idle();
		service.send(session.id, { content: [{ type: "text", text: words }] });
		await done;
	}
	expect(await service.revertPlan(session.id, 2)).toEqual({
		files: [{ path: join(session.cwd, "a.ts"), added: 1, removed: 0, problem: null }],
		unrecorded: false,
	});
	await expect(service.revertPlan(session.id, 1)).rejects.toThrow("找不到这条消息");
	expect(asked).toEqual([{ roles: ["user", "assistant"], restore: false, cwd: session.cwd }]);

	refuse = true;
	await expect(service.revertMessage(session.id, 2, { files: true })).rejects.toThrow(/^a\.ts 之后被改过，没有退回$/);
	await expect(service.editMessage(session.id, 2, { content: [{ type: "text", text: "改问" }] }, { files: true })).rejects.toThrow("没有退回");
	expect((await service.getSession(session.id)).summary.messageCount).toBe(4);
	expect(asked.slice(1).map((entry) => entry.restore)).toEqual([true, true]);

	// 只截对话：不问插件。
	await service.revertMessage(session.id, 2);
	expect(asked).toHaveLength(3);
	expect((await service.getSession(session.id)).summary.messageCount).toBe(2);

	refuse = false;
	const from = events.length;
	await service.editMessage(session.id, 0, { content: [{ type: "text", text: "重新问" }] }, { files: true });
	expect(asked[3]).toEqual({ roles: ["user", "assistant"], restore: true, cwd: session.cwd });
	await until((event): event is AgentEvent => event.type === "message" && event.message.role === "assistant", from);
	expect((await service.getSession(session.id)).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
});

it("分叉：问题上停在它之前，落定的回复上带着它；原会话不动，压缩记录只留对得上的", async () => {
	await bigFile("a.txt", 200);
	await bigFile("b.txt", 150);
	const replies: FakeReply[] = [
		{ toolCalls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }] },
		{ text: "读完了 a" },
		{ toolCalls: [{ id: "call_b", name: "read", args: { path: "b.txt" } }] },
		{ text: "SUMMARY_TEXT" },
		{ text: "读完了 b" },
	];
	const { service, session, idle } = await start(replies, [], { contextWindow: 6000 });
	const ask = async (words: string) => {
		const done = idle();
		service.send(session.id, { content: [{ type: "text", text: words }] });
		await done;
	};
	await ask("读一下 a.txt");
	await ask("再读 b.txt");
	await service.renameSession(session.id, "读文件");
	const source = await service.getSession(session.id);
	expect(source.compactions).toEqual([{ keptFrom: 5, before: 7, after: 4 }]);
	const last = source.messages[7]!;

	// 序号落后了也认得出：按时间戳找回那条回复。
	const after = await service.forkSession(session.id, 6, last.timestamp, "读文件（分叉）");
	const forked = await service.getSession(after.id);
	expect(forked.summary).toMatchObject({ title: "读文件（分叉）", cwd: workspace, forkedFrom: { sessionId: session.id }, messageCount: 8 });
	expect(forked.messages).toEqual(source.messages);
	expect(forked.compactions).toEqual(source.compactions);
	// 停在工具调用上的那句、和人的问题以外的消息都不能分叉。
	await expect(service.forkSession(session.id, 5, source.messages[5]!.timestamp, "x")).rejects.toThrow("找不到这条消息");

	const before = await service.forkSession(session.id, 0, source.messages[0]!.timestamp, "读文件（分叉）");
	const empty = await service.getSession(before.id);
	expect(empty.messages).toEqual([]);
	expect(empty.summary.messageCount).toBe(0);
	expect(empty.compactions).toEqual([]);
	expect((await service.getSession(session.id)).messages).toHaveLength(8);
	// 花销不跟着拷：那些钱是原会话花的。
	expect(storedRows("SELECT session_id FROM spend WHERE session_id = ?", after.id)).toEqual([]);
});

it("编辑重发带回存着的图：只给 media 名字，发给模型时照样读回像素；名字不对的块丢掉", async () => {
	const { service, session, until, idle } = await start([{ text: "看到了" }, { text: "又看到了" }]);
	const [provider] = (await service.getSettings()).providers;
	if (!provider) throw new Error("应该有一个供应商");
	await service.saveProvider({ ...provider, models: provider.models.map((entry) => ({ ...entry, supportsImages: true })) });
	const data = Buffer.alloc(9000, 7).toString("base64");
	let done = idle();
	service.send(session.id, {
		content: [
			{ type: "image", data, mimeType: "image/png" },
			{ type: "text", text: "这是什么" },
		],
	});
	const sent = await until((event): event is Extract<AgentEvent, { type: "message" }> => event.type === "message" && event.message.role === "user");
	await done;
	const image = sent.message.content.find((block) => block.type === "image");
	await service.editMessage(session.id, 0, {
		content: [image!, { type: "image", data: "", mimeType: "image/png", media: "../secret.png" }, { type: "text", text: "图里是什么" }],
	});
	await until(
		(event): event is AgentEvent =>
			event.type === "message" && event.message.role === "assistant" && JSON.stringify(event.message.content).includes("又看到了"),
	);
	const [first] = (await service.getSession(session.id)).messages;
	expect(first?.role === "user" && first.content.filter((block) => block.type === "image")).toHaveLength(1);
	expect(JSON.stringify(model?.requests[1])).toContain(data);
	expect(JSON.stringify(model?.requests[1])).toContain("图里是什么");
});

it("多源项目和手动顺序落盘；主文件夹变更不搬动已有会话，非法排序不保存", async () => {
	const { service } = await start([]);
	const extra = join(dir, "extra");
	await mkdir(extra);
	const project = await service.createProject("多源", workspace, [workspace, extra, extra]);
	const other = await service.createProject("另一个", dir);
	const a = await service.createSession({ project: project.id });
	const b = await service.createSession({ project: project.id });
	await service.reorderProjects(project.id, other.id, "before");
	await service.reorderProjectSessions(project.id, [a.id, b.id]);
	await expect(service.reorderProjectSessions(project.id, [a.id, a.id])).rejects.toThrow();
	await service.setSessionPinned(b.id, true);
	await expect(service.reorderProjectSessions(project.id, [b.id])).rejects.toThrow();
	const alien = await service.createSession({ project: other.id });
	await expect(service.reorderProjectSessions(project.id, [alien.id])).rejects.toThrow();
	// 置顶的 b 不在拖动的名单里，名次照旧留在 a 后面：取消置顶后回到原处，不跳到最前。
	const c = await service.createSession({ project: project.id });
	await service.reorderProjectSessions(project.id, [c.id, a.id]);
	expect(service.listProjects().find((entry) => entry.id === project.id)?.sessionOrder).toEqual([c.id, a.id, b.id]);
	await service.setSessionPinned(b.id, false);
	await service.reorderProjectSessions(project.id, [c.id, a.id, b.id]);
	await service.updateProject(project.id, "多源", extra, [extra, workspace]);
	expect((await service.getSession(a.id)).summary.cwd).toBe(workspace);
	expect((await service.createSession({ project: project.id })).cwd).toBe(extra);
	await agent?.shutdown();
	agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "model.json"), plugins: [], log: () => undefined });
	expect(agent.service.listProjects().map((entry) => entry.id)).toEqual([project.id, other.id]);
	expect(agent.service.listProjects()[0]).toMatchObject({ path: extra, folders: [extra, workspace], sessionOrder: [c.id, a.id, b.id] });
});

it("项目源目录到达提示词和工具，目录移除后下一轮不再授予", async () => {
	const seen: Array<readonly string[] | undefined> = [];
	const plugin: Plugin = {
		name: "test.roots",
		apply(ctx) {
			ctx.tools.register({
				name: "roots",
				description: "inspect",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					seen.push(run.projectRoots);
					return { output: "ok" };
				},
			});
		},
	};
	const { service, session, idle } = await start([{ toolCalls: [{ id: "roots", name: "roots", args: {} }] }, { text: "完成" }], [plugin]);
	const extra = join(dir, "source");
	const project = await service.createProject("项目", workspace, [workspace, extra]);
	await service.moveSessionProject(session.id, project.id);
	service.send(session.id, { content: [{ type: "text", text: "检查目录" }] });
	await idle();
	expect(seen).toEqual([[workspace, extra]]);
	expect(JSON.stringify(model?.requests[0]?.system)).toContain(extra);
	await service.updateProject(project.id, "项目", workspace, [workspace]);
	service.send(session.id, { content: [{ type: "text", text: "再检查" }] });
	await idle();
	// 系统提示词在会话里冻结，前缀缓存接得上；移除的目录由接在这一轮开头的增量告诉模型。
	const last = model?.requests.at(-1) as { system?: unknown; messages?: Array<{ role: string; content: unknown }> } | undefined;
	expect(JSON.stringify(last?.system)).toBe(JSON.stringify(model?.requests[0]?.system));
	const update = JSON.stringify(last?.messages?.at(-1)?.content);
	expect(update).toContain('<section-update id=\\"workspace\\">');
	expect(update).not.toContain(extra);
});

it("人拖进来的文件经 ToolRun.allowedPaths 交给工具，之后几轮也算；没有附件时不给", async () => {
	const seen: Array<readonly string[] | undefined> = [];
	const plugin: Plugin = {
		name: "test.attached",
		apply(ctx) {
			ctx.tools.register({
				name: "attached",
				description: "inspect",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					seen.push(run.allowedPaths);
					return { output: "ok" };
				},
			});
		},
	};
	const call = (id: string) => ({ toolCalls: [{ id, name: "attached", args: {} }] });
	const { service, session, idle } = await start([call("none"), { text: "完成" }, call("given"), { text: "完成" }, call("later"), { text: "完成" }], [plugin]);
	service.send(session.id, { content: [{ type: "text", text: "没有附件" }] });
	await idle();
	const outside = join(dir, "elsewhere", "notes.txt");
	service.send(session.id, {
		content: [{ type: "text", text: "看看这个【文件 1】" }],
		attachments: [
			{ name: "notes.txt", kind: "text", label: "文件 1", path: outside },
			{ name: "loose.txt", kind: "text", path: "relative/loose.txt" },
		],
	});
	await idle();
	service.send(session.id, { content: [{ type: "text", text: "再看一遍" }] });
	await idle();
	// 相对路径不认：它会按进程的工作目录补全，谁也没打算授权那个位置。
	expect(seen).toEqual([undefined, [outside], [outside]]);
});

it("运行观察记录真实请求和响应，不暴露模型配置密钥", async () => {
	const observations: import("@plume/contract").SessionObservation[] = [];
	const { service, session, idle } = await start(
		[{ text: "diagnostic reply" }],
		[
			{
				name: "test.observer",
				apply(ctx) {
					ctx.sessions.observe((value) => observations.push(value));
				},
			},
		],
	);
	service.send(session.id, { content: [{ type: "text", text: "inspect this run" }] });
	await idle();
	const request = observations.find((value) => value.event.type === "request")!;
	const response = observations.find((value) => value.event.type === "response")!;
	expect(request).toMatchObject({
		sessionId: session.id,
		at: 1,
		event: { type: "request", messages: expect.arrayContaining([expect.objectContaining({ role: "user" })]) },
	});
	expect(response.event.type === "response" && response.event.reply.content).toContainEqual(
		expect.objectContaining({ type: "text", text: "diagnostic reply" }),
	);
	expect(request.event.type === "request" && response.event.type === "response" && request.event.id === response.event.id).toBe(true);
	expect(JSON.stringify(observations)).not.toContain("test-key");
	expect(observations.filter((value) => value.event.type === "running").map((value) => value.event.type === "running" && value.event.running)).toEqual([
		true,
		false,
	]);
});

it("完整收尾只发一次 idle，发送与编辑重发保留会话引用", async () => {
	const { service, session, events, until, idle } = await start([{ text: "完成" }]);
	const refs = [{ id: "old", title: "旧会话" }];
	let done = idle();
	await service.send(session.id, { content: [{ type: "text", text: "参考旧会话" }], sessionRefs: refs });
	await done;
	await until((event): event is Extract<AgentEvent, { type: "idle" }> => event.type === "idle");
	expect(events.filter((event) => event.type === "idle")).toHaveLength(1);
	const view = await service.getSession(session.id);
	expect(view.messages[0]).toMatchObject({ sessionRefs: refs });
	const at = events.length;
	done = idle();
	await service.editMessage(session.id, 0, { content: [{ type: "text", text: "重新参考" }], sessionRefs: refs });
	await done;
	await until((event): event is Extract<AgentEvent, { type: "idle" }> => event.type === "idle", at);
	expect((await service.getSession(session.id)).messages[0]).toMatchObject({ sessionRefs: refs });
});
