import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { HookLayer, Message, ParentSession, ParentStatus, PluginContext, SessionLaunch, SessionSummary, ToolDefinition, ToolRun } from "@plume/contract";
import { CARRY_ON, CONTROL_MAIN, DISPATCH_TASK, cardTitle, isDispatchSuggestion } from "../src/controls.ts";
import type { SideChatApi } from "../src/api.ts";
import plugin from "../src/index.ts";

/** 记下侧边聊天对主会话做了什么的假父会话。 */
function fakeParent(state: ParentStatus["state"] = "idle") {
	const calls: string[] = [];
	const status = (): ParentStatus => ({ state, queued: 0 });
	const parent: ParentSession = {
		id: "main",
		async enqueue(instruction) {
			calls.push(`enqueue:${instruction}`);
			return { started: state === "idle" };
		},
		async stop(options) {
			calls.push(options?.discardPlan ? "stop:discard" : "stop");
			return status();
		},
		async carryOn(text) {
			calls.push(`carryOn:${text}`);
			return status();
		},
		status,
	};
	return { parent, calls };
}

const run = (parent?: ParentSession) => ({ ...(parent ? { parent } : {}) }) as unknown as ToolRun;
const exec = (tool: ToolDefinition, args: Record<string, unknown>, parent?: ParentSession) => tool.execute(args, run(parent));

test("dispatch_task：人点名交给主会话才当场排进去，否则只留一张卡片", async () => {
	const main = fakeParent("running");
	assert.deepEqual(await exec(DISPATCH_TASK, { instruction: " 修好 a.ts ", user_asked: true }, main.parent), {
		output: "已排入主会话的任务队列，它会在当前工作完成后执行。",
	});
	const idle = fakeParent("idle");
	assert.equal((await exec(DISPATCH_TASK, { instruction: "跑测试", user_asked: true }, idle.parent)).output, "主会话当前空闲，已经开始执行。");
	assert.deepEqual([...main.calls, ...idle.calls], ["enqueue:修好 a.ts", "enqueue:跑测试"]);

	const card = fakeParent();
	const suggested = await exec(DISPATCH_TASK, { instruction: "第一行\n第二行", user_asked: false }, card.parent);
	assert.ok(isDispatchSuggestion(suggested.details));
	assert.deepEqual(suggested.details, { kind: "dispatch_suggestion", title: "第一行", instruction: "第一行\n第二行" });
	assert.match(suggested.output as string, /^什么都还没开始/);
	assert.deepEqual(card.calls, []);

	assert.equal((await exec(DISPATCH_TASK, { instruction: "  ", user_asked: true }, card.parent)).output, "指令为空，没有派出任何任务。");
	assert.equal((await exec(DISPATCH_TASK, { instruction: "x", user_asked: true })).isError, true);
	assert.equal(cardTitle("长".repeat(80), "x").length, 60);
});

test("control_main：暂停、废清单、接着做、看状态当场生效，不在侧边聊天里拒绝", async () => {
	const running = fakeParent("running");
	assert.match((await exec(CONTROL_MAIN, { action: "pause" }, running.parent)).output as string, /^已经让主会话停下了/);
	assert.match((await exec(CONTROL_MAIN, { action: "pause", discardPlan: true }, running.parent)).output as string, /旧任务清单已取消/);
	assert.equal((await exec(CONTROL_MAIN, { action: "resume" }, running.parent)).output, "主会话正在执行，不用继续。");
	assert.deepEqual(running.calls, ["stop", "stop:discard", `carryOn:${CARRY_ON}`]);

	const idle = fakeParent("idle");
	assert.match((await exec(CONTROL_MAIN, { action: "pause" }, idle.parent)).output as string, /^主会话现在闲着，不需要暂停。.*环境卡片.*「全部停止」/);
	assert.equal((await exec(CONTROL_MAIN, { action: "resume" }, idle.parent)).output, "已经让主会话接着做了。");
	assert.equal((await exec(CONTROL_MAIN, { action: "status" }, idle.parent)).output, "主会话当前空闲。");
	const background = fakeParent("background");
	assert.match((await exec(CONTROL_MAIN, { action: "resume" }, background.parent)).output as string, /还在后台跑/);
	assert.equal((await exec(CONTROL_MAIN, { action: "fly" }, idle.parent)).isError, true);
	assert.equal((await exec(CONTROL_MAIN, { action: "status" })).isError, true);
});

async function fixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "plume-side-chat-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const summaries: SessionSummary[] = [
		{ id: "main", title: "", cwd: "/w", project: "p1", running: false, createdAt: 0, updatedAt: 0 } as SessionSummary,
		{ id: "side", title: "", cwd: "/w", running: false, createdAt: 0, updatedAt: 0, parentId: "main", owner: "plume.side-chat" } as SessionSummary,
	];
	const suggestion = { kind: "dispatch_suggestion", title: "修好 a.ts", instruction: "把 /w/a.ts 的类型错误修掉" };
	const messages: Message[] = [
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "dispatch_task",
			content: [{ type: "text", text: "" }],
			details: suggestion,
			isError: false,
			timestamp: 1,
		} as Message,
		{ role: "toolResult", toolCallId: "call-2", toolName: "dispatch_task", content: [{ type: "text", text: "" }], isError: false, timestamp: 2 } as Message,
	];
	const launched: SessionLaunch[] = [];
	const tools: string[] = [];
	const layers = new Map<string, unknown>();
	let api: SideChatApi | undefined;
	const ctx = {
		name: "plume.side-chat",
		dataDir: directory,
		locale: () => "zh-CN",
		log: { info() {}, warn() {}, error() {} },
		use: () => ({}),
		hook: (name: string, layer: unknown) => void layers.set(name, layer),
		tools: {
			register: (tool: ToolDefinition) => (tools.push(tool.name), () => {}),
			// 查网页的、读写文件跑命令的工具按声明的类别、种类留下，叫什么都行；长跑的命令（`watch`）不给侧边聊天。
			list: () => [
				{ name: "view_file", plugin: "test.files", kind: "view" },
				{ name: "follow_log", plugin: "test.files", kind: "watch" },
				{ name: "look_up", plugin: "test.web", category: "web" },
				{ name: "track", plugin: "test.todo", category: "checklist" },
			],
		},
		commands: { provide() {} },
		serve: (value: SideChatApi) => void (api = value),
		sessions: {
			list: async () => structuredClone(summaries),
			get: async (id: string) => structuredClone(summaries.find((summary) => summary.id === id)),
			messages: async (id: string) => (id === "side" ? structuredClone(messages) : []),
			onDeleted() {},
			async launch(options: SessionLaunch) {
				launched.push(options);
				const session = {
					id: `new-${launched.length}`,
					title: options.title ?? "",
					cwd: "/w",
					running: true,
					createdAt: 1,
					updatedAt: 1,
					spawnedFrom: options.spawnedFrom,
				} as SessionSummary;
				summaries.push(session);
				return { session, done: new Promise(() => {}), idle: new Promise(() => {}) };
			},
		},
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	return { api: api!, launched, tools, context: layers.get("model.context") as HookLayer<"model.context"> };
}

test("卡片上「开新会话」开在主会话的项目里、记着从哪张卡开出来，点两次只开一个；不是建议卡的不开", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(f.tools, ["read_main_chat", "dispatch_task", "control_main"]);
	assert.equal(await f.api.started("side", "call-1"), undefined);
	const [first, second] = await Promise.all([f.api.launch("side", "call-1"), f.api.launch("side", "call-1")]);
	assert.equal(first, "new-1");
	assert.equal(second, "new-1");
	assert.equal(await f.api.launch("side", "call-1"), "new-1");
	assert.deepEqual(f.launched, [
		{ project: "p1", message: "把 /w/a.ts 的类型错误修掉", title: "修好 a.ts", spawnedFrom: { sessionId: "main", toolCallId: "call-1" } },
	]);
	assert.equal(await f.api.started("side", "call-1"), "new-1");
	await assert.rejects(f.api.launch("side", "call-2"), /卡片/);
	await assert.rejects(f.api.launch("main", "call-1"));
});

test("普通会话的工具表里没有侧边聊天专用的三件", async (t) => {
	const f = await fixture(t);
	const names = ["read", "read_main_chat", "dispatch_task", "control_main"].map((name) => ({ name }));
	let seen: string[] = [];
	await f.context({ sessionId: "main", tools: names, sections: [] } as never, async (input) => {
		seen = input.tools.map((tool) => tool.name);
		return input;
	});
	assert.deepEqual(seen, ["read"]);
});

test("侧边聊天里身份、准则两段按类别换成自己的，段名和位置照旧；读文件、查网页的工具按种类、类别留下", async (t) => {
	const f = await fixture(t);
	const sections = [
		{ id: "who", text: "主会话的身份", category: "identity" as const },
		{ id: "rules", text: "主会话的准则", category: "guidelines" as const },
		{ id: "boundaries", text: "边界" },
	];
	const tools = ["view_file", "follow_log", "look_up", "track", "read_main_chat"].map((name) => ({ name }));
	const built = await f.context({ sessionId: "side", tools, sections } as never, async (input) => input);
	assert.deepEqual(
		built.tools.map((tool) => tool.name),
		["view_file", "look_up", "read_main_chat"],
	);
	assert.deepEqual(
		built.sections.map((section) => section.id),
		["who", "rules", "boundaries"],
	);
	assert.match(built.sections[0]!.text, /^You are Plume's side assistant/);
	assert.match(built.sections[1]!.text, /^Guidelines:\n- Answer in the user's language/);
	assert.equal(built.sections[2]!.text, "边界");
});
