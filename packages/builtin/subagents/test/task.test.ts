import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type {
	BackgroundJobInfo,
	HookLayer,
	Message,
	ModelContext,
	PluginContext,
	ReportOptions,
	ResourceAddress,
	ResourceHandler,
	SessionMessage,
	SessionModel,
	SessionSummary,
	ToolDefinition,
	ToolOutput,
	ToolRun,
	TurnStop,
} from "@plume/contract";
import type { SubagentsApi } from "../src/api.ts";
import { BUILTIN_AGENTS } from "../src/agents.ts";
import plugin from "../src/index.ts";
import { lastProse, wayBack } from "../src/types.ts";

const MODELS: SessionModel[] = [{ id: "provider/model", name: "Model", contextWindow: 100_000, thinking: [{ id: "high", label: "High", detail: "" }] }];
const assistant = (text: string, timestamp = Date.now()): Message => ({ role: "assistant", content: [{ type: "text", text }], timestamp }) as Message;

async function until(predicate: () => boolean) {
	for (let n = 0; n < 100 && !predicate(); n++) await setImmediate();
	assert.ok(predicate(), "background work did not settle");
}

async function fixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "plume-subagents-"));
	const tools = new Map<string, ToolDefinition>();
	const layers = new Map<string, HookLayer<"model.context"> | HookLayer<"tool.execute"> | HookLayer<"step.end">>();
	const messages = new Map<string, Message[]>();
	const sessions = new Map<string, SessionSummary>([["main", { id: "main", title: "Main", cwd: "/work", running: false, createdAt: 0, updatedAt: 0 }]]);
	const starts: Array<{ sessionId: string; message: string | SessionMessage; runId: string }> = [];
	const pending = new Map<string, (stop: TurnStop) => void>();
	const waits = new Map<string, Promise<TurnStop>>();
	const reports: Array<{ runId: string; text: string; delivery?: ReportOptions["delivery"] }> = [];
	const stopped: string[] = [];
	const steering: Array<{ sessionId: string; message: string | SessionMessage }> = [];
	let stopListeners: Array<(id: string) => void> = [];
	let deleteListeners: Array<(id: string) => void> = [];
	let disposers: Array<() => void | Promise<void>> = [];
	let api!: SubagentsApi;
	let serial = 0;
	let beforeCreate: (() => Promise<void>) | undefined;
	const resources: ResourceHandler[] = [];
	const jobs: Array<{ sessionId: string; id: string; status: BackgroundJobInfo["status"] }> = [];
	const killed: Array<{ sessionId: string; id: string; force: boolean }> = [];
	const ctx = {
		name: "plume.subagents",
		dataDir: directory,
		appDataDir: join(directory, "home"),
		locale: () => "en",
		log: { info() {}, warn() {}, error() {} },
		tools: {
			register: (tool: ToolDefinition) => {
				tools.set(tool.name, tool);
				return () => void tools.delete(tool.name);
			},
			names: () => ["read", "write", "bash", ...tools.keys()],
		},
		hook: (name: string, layer: never) => void layers.set(name, layer),
		serve: (value: SubagentsApi) => {
			api = value;
		},
		effect: (dispose: () => void | Promise<void>) => disposers.push(dispose),
		use: (name: string) =>
			name === "background.jobs"
				? {
						list: (sessionId: string) => jobs.filter((job) => job.sessionId === sessionId),
						stop: (sessionId: string, id: string, force: boolean) => {
							const job = jobs.find((entry) => entry.sessionId === sessionId && entry.id === id);
							if (!job) return false;
							killed.push({ sessionId, id, force });
							job.status = "exited";
							return true;
						},
					}
				: {
						register: (handler: ResourceHandler) => {
							resources.push(handler);
							return () => void resources.splice(resources.indexOf(handler), 1);
						},
					},
		sessions: {
			list: async () => [...sessions.values()],
			models: async () => MODELS,
			onStopped: (listener: (id: string) => void) => stopListeners.push(listener),
			onDeleted: (listener: (id: string) => void) => deleteListeners.push(listener),
			create: async (options: { parentId: string; title?: string; model?: string; thinking?: string }) => {
				await beforeCreate?.();
				const child: SessionSummary = {
					id: `child-${++serial}`,
					title: options.title ?? "",
					cwd: "/work",
					createdAt: 0,
					updatedAt: 0,
					running: false,
					parentId: options.parentId,
					owner: "plume.subagents",
					thinking: options.thinking,
				};
				sessions.set(child.id, child);
				messages.set(child.id, []);
				return child;
			},
			start: async (sessionId: string, message: string | SessionMessage) => {
				const runId = `run-${starts.length + 1}`;
				starts.push({ sessionId, message, runId });
				messages.get(sessionId)!.push({
					role: "user",
					...(typeof message === "string" ? { content: [{ type: "text", text: message }] } : message),
					timestamp: Date.now(),
				} as Message);
				waits.set(runId, new Promise((resolve) => pending.set(runId, resolve)));
				return { id: runId, sessionId };
			},
			wait: async (runId: string) => waits.get(runId)!,
			// 一份单独送达时宿主拼成的样子：开头、正文、送出那一刻的结尾。
			report: async (runId: string, text: string, { frame, delivery }: ReportOptions = {}) => {
				const data = JSON.parse(readFileSync(join(directory, "subagents.json"), "utf8"));
				assert.ok(data.tasks.some((task: { runId: string; endedAt?: number }) => task.runId === runId && task.endedAt));
				reports.push({ runId, text: [frame?.head, text, frame?.tail?.()].filter(Boolean).join("\n\n"), delivery });
				return true;
			},
			messages: async (id: string) => structuredClone(messages.get(id) ?? []),
			steer: async (sessionId: string, message: string | SessionMessage) => void steering.push({ sessionId, message }),
			stop: (id: string) => {
				stopped.push(id);
				for (const listener of stopListeners) listener(id);
				const start = starts.findLast((entry) => entry.sessionId === id);
				if (start) pending.get(start.runId)?.({ reason: "aborted" });
			},
		},
	} as unknown as PluginContext;
	const load = async () => {
		await plugin.apply(ctx);
	};
	const unload = async () => {
		for (const dispose of disposers.reverse()) await dispose();
		disposers = [];
		stopListeners = [];
		deleteListeners = [];
	};
	await load();
	t.after(async () => {
		for (const resolve of pending.values()) resolve({ reason: "aborted" });
		await unload();
		rmSync(directory, { recursive: true, force: true });
	});
	const run = (args: Record<string, unknown>, sessionId = "main", name = "task") =>
		tools.get(name)!.execute(args, {
			sessionId,
			cwd: "/work",
			signal: new AbortController().signal,
			progress() {},
			ask: async () => "once",
			permissionMode: async () => "ask",
			tools: () => [],
			calls: [],
		} as ToolRun) as Promise<ToolOutput>;
	const finish = (index: number, reason: TurnStop["reason"] = "done", text?: string) => {
		const start = starts[index]!;
		if (text) messages.get(start.sessionId)!.push(assistant(text));
		pending.get(start.runId)!({ reason });
	};
	return {
		run,
		starts,
		reports,
		stopped,
		steering,
		messages,
		layers,
		sessions,
		finish,
		load,
		unload,
		api: () => api,
		stopParent: () => stopListeners.forEach((listener) => listener("main")),
		deleteSession: (id: string) => {
			sessions.delete(id);
			deleteListeners.forEach((listener) => listener(id));
		},
		beforeCreate: (callback: () => Promise<void>) => {
			beforeCreate = callback;
		},
		directory,
		resources,
		tools,
		jobs,
		killed,
	};
}

const context = (sessionId: string): ModelContext => ({
	sessionId,
	cwd: "/work",
	model: { id: "provider/model", name: "Model" },
	personalization: { customInstructions: "", tone: "professional" },
	systemPrompt: "",
	sections: [{ id: "identity", text: "Plume" }],
	messages: [],
	tools: ["read", "write", "task", "stop_subagent", "todo_write"].map((name) => ({ name, description: name, parameters: {} })),
});

test("task immediately returns an ID; persists final report before delivery", async (t) => {
	const f = await fixture(t);
	const result = await f.run({ description: "Find entry", prompt: "Find it", subagent_type: "explore" });
	assert.equal(result.isError, undefined);
	assert.match(result.output, /background.*child-1/);
	assert.equal(f.reports.length, 0);
	await until(() => f.starts.length === 1);
	assert.equal((f.starts[0]!.message as SessionMessage).origin, "parent");
	f.finish(0, "done", "src/a.ts:12");
	await until(() => f.reports.length === 1);
	assert.match(f.reports[0]!.text, /src\/a.ts:12/);
	assert.deepEqual(f.reports[0]!.delivery, { id: f.api().list("main")[0]!.id, agent: "explore", description: "Find entry", status: "done" });
	assert.equal(f.api().list("main")[0]!.answer, "src/a.ts:12");
});

test("register all queued children, admit only four, then release FIFO", async (t) => {
	const f = await fixture(t);
	await Promise.all(Array.from({ length: 6 }, (_, n) => f.run({ description: `Task ${n}`, prompt: "work" })));
	await until(() => f.starts.length === 4);
	assert.equal(f.api().list("main").length, 6);
	assert.equal(
		f
			.api()
			.list("main")
			.filter((task) => task.state === "queued").length,
		2,
	);
	f.finish(0, "done", "Done");
	await until(() => f.starts.length === 5);
	assert.equal(f.starts[4]!.sessionId, "child-5");
});

test("parent stop cancels queue and processes without reporting; creation race cannot start", async (t) => {
	const f = await fixture(t);
	await Promise.all(Array.from({ length: 6 }, () => f.run({ description: "Task", prompt: "work" })));
	await until(() => f.starts.length === 4);
	f.stopParent();
	await setImmediate();
	assert.equal(f.starts.length, 4);
	assert.equal(
		f
			.api()
			.list("main")
			.every((task) => task.state === "stopped"),
		true,
	);
	assert.equal(f.reports.length, 0);
	let release!: () => void;
	f.beforeCreate(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const creating = f.run({ description: "Race", prompt: "work" });
	await until(() => Boolean(release));
	f.stopParent();
	release();
	await creating;
	await setImmediate();
	assert.equal(f.starts.length, 4);
	assert.equal(f.api().list("main").at(-1)!.state, "stopped");
});

test("stop_subagent cancels one queued or running child, not siblings", async (t) => {
	const f = await fixture(t);
	await Promise.all(Array.from({ length: 5 }, () => f.run({ description: "Task", prompt: "work" })));
	await until(() => f.starts.length === 4);
	assert.equal((await f.run({ id: "child-5" }, "main", "stop_subagent")).isError, undefined);
	await f.run({ id: "child-1" }, "main", "stop_subagent");
	await setImmediate();
	assert.equal(f.starts.length, 4);
	assert.equal(f.api().list("main")[1]!.state, "running");
	assert.equal(f.reports.length, 0);
});

test("resume preserves session, agent identity and tool limits, including after reload", async (t) => {
	const f = await fixture(t);
	await f.run({ description: "Explore", prompt: "Find entry", subagent_type: "explore" });
	await until(() => f.starts.length === 1);
	f.finish(0, "error", "Partial");
	await until(() => f.reports.length === 1);
	await setImmediate();
	await f.unload();
	await f.load();
	await f.run({ description: "Continue", prompt: "Finish it", resume: "child-1", subagent_type: "general" });
	await until(() => f.starts.length === 2);
	assert.equal(f.starts[1]!.sessionId, "child-1");
	const layer = f.layers.get("model.context") as HookLayer<"model.context">;
	const built = await layer(context("child-1"), async (value) => value);
	assert.match(built.sections[0]!.text, /read-only exploration/);
	assert.deepEqual(
		built.tools.map((tool) => tool.name),
		["read", "todo_write"],
	);
	assert.equal(f.api().list("main")[0]!.agent, "explore");
	assert.equal(f.api().list("main")[0]!.attempt, 2);
	assert.equal((await f.run({ description: "Nested", prompt: "no" }, "child-1")).isError, true);
});

test("steering preserves attachments and strips parent origin; idle rejects", async (t) => {
	const f = await fixture(t);
	await f.run({ description: "Task", prompt: "work" });
	await until(() => Boolean(f.api().list("main")[0]?.runId));
	const message: SessionMessage = {
		content: [{ type: "text", text: "Look here" }],
		displayText: "Look here",
		attachments: [{ name: "a.txt", kind: "text" }],
		origin: "parent",
	};
	await f.api().steer("child-1", message);
	assert.deepEqual(f.steering[0]!.message, { content: message.content, displayText: message.displayText, attachments: message.attachments });
	f.api().stop("child-1");
	await assert.rejects(f.api().steer("child-1", message), /stopped/);
});

test("delete and unload cancel pending work and never deliver results", async (t) => {
	const f = await fixture(t);
	await Promise.all(Array.from({ length: 5 }, () => f.run({ description: "Task", prompt: "work" })));
	await until(() => f.starts.length === 4);
	f.deleteSession("child-5");
	assert.equal(f.api().list("main")[4]!.resumable, false);
	await f.unload();
	assert.equal(f.reports.length, 0);
	assert.equal(f.starts.length, 4);
	assert.equal(
		f
			.api()
			.list("main")
			.every((task) => !["queued", "running"].includes(task.state)),
		true,
	);
});

test("model choices persist and invalid explicit choices fail instead of fallback", async (t) => {
	const f = await fixture(t);
	await f.api().setModel("explore", { model: "provider/model", thinking: "high" });
	await f.unload();
	await f.load();
	assert.deepEqual((await f.api().catalog(null)).choices.explore, { model: "provider/model", thinking: "high" });
	await assert.rejects(f.api().setModel("explore", { model: "missing" }), /unavailable/);
	await assert.rejects(f.api().setModel("explore", { model: "provider/model", thinking: "nope" }), /thinking/);
});

test("user-defined agents dispatch with their own identity; disabled ones are hidden and refused; the identity is a snapshot", async (t) => {
	const f = await fixture(t);
	const agents = join(f.directory, "home", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "helper.md"), "---\nname: helper\ndescription: Helps out\ntools: [read]\n---\nOriginal prompt");
	const layer = f.layers.get("model.context") as HookLayer<"model.context">;
	f.api().setEnabled("helper", false);
	assert.doesNotMatch((await layer(context("main"), async (input) => input)).sections.at(-1)!.text, /helper/);
	assert.equal((await f.run({ description: "Help", prompt: "work", subagent_type: "helper" })).isError, true);
	f.api().setEnabled("helper", true);
	assert.match((await layer(context("main"), async (input) => input)).sections.at(-1)!.text, /helper/);
	assert.equal((await f.run({ description: "Help", prompt: "work", subagent_type: "helper" })).isError, undefined);
	await until(() => f.starts.length === 1);
	// 派出去以后改定义文件：已经派出的那一个还是原来的指令和工具。
	writeFileSync(join(agents, "helper.md"), "---\nname: helper\ndescription: Helps out\ntools: [read, write]\n---\nChanged prompt");
	const child = await layer(context(f.starts[0]!.sessionId), async (input) => input);
	assert.equal(child.sections[0]!.text, "Original prompt");
	assert.deepEqual(
		child.tools.map((tool) => tool.name),
		["read", "todo_write"],
	);
});

test("validation and catalogue remain available without starting invalid tasks", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.run({ description: "Task", prompt: "work", subagent_type: "missing" })).isError, true);
	assert.equal((await f.run({ description: "", prompt: "work" })).isError, true);
	assert.equal((await f.run({ description: "Resume", prompt: "work", resume: "missing" })).isError, true);
	assert.equal(f.starts.length, 0);
	const layer = f.layers.get("model.context") as HookLayer<"model.context">;
	const main = await layer(context("main"), async (input) => input);
	assert.match(main.sections.at(-1)!.text, /<available_subagents>/);
	// 名单后面说清同时跑几个：和登记簿真实的上限是同一个数。
	assert.match(main.sections.at(-1)!.text, /最多 4 个子代理同时跑/);
	const hidden = await layer(context("main"), async (input) => ({ ...input, tools: input.tools.filter((tool) => tool.name !== "task") }));
	assert.equal(
		hidden.sections.some((section) => section.id === "subagents"),
		false,
	);
});

test("every agent kind switched off: task is hidden from the model along with the catalogue; switching one back on returns both", async (t) => {
	const f = await fixture(t);
	const layer = f.layers.get("model.context") as HookLayer<"model.context">;
	for (const agent of BUILTIN_AGENTS) f.api().setEnabled(agent.name, false);
	const off = await layer(context("main"), async (input) => input);
	assert.equal(
		off.tools.some((tool) => tool.name === "task"),
		false,
	);
	assert.equal(
		off.sections.some((section) => section.id === "subagents"),
		false,
	);
	f.api().setEnabled(BUILTIN_AGENTS[0]!.name, true);
	const on = await layer(context("main"), async (input) => input);
	assert.equal(
		on.tools.some((tool) => tool.name === "task"),
		true,
	);
	assert.match(on.sections.at(-1)!.text, /<available_subagents>/);
});

test("deleting the parent drops its roster and cannot admit queued work", async (t) => {
	const f = await fixture(t);
	await Promise.all(Array.from({ length: 5 }, () => f.run({ description: "Task", prompt: "work" })));
	await until(() => f.starts.length === 4);
	f.deleteSession("main");
	for (let index = 0; index < 4; index++) f.finish(index, "aborted");
	await setImmediate();
	assert.deepEqual(f.api().list("main"), []);
	assert.equal(f.starts.length, 4);
	assert.equal(f.reports.length, 0);
});

test("the final report is the newest thing this run said, skipping old turns and restated commentary", () => {
	const process = {
		role: "assistant",
		content: [
			{ type: "text", text: "Let me inspect" },
			{ type: "toolCall", id: "x", name: "read", arguments: {} },
		],
		timestamp: 2,
	} as Message;
	const restated = {
		role: "assistant",
		content: [
			{ type: "text", text: "Checking", phase: "commentary" },
			{ type: "text", text: "Final", phase: "final_answer" },
		],
		timestamp: 3,
	} as Message;
	assert.deepEqual(lastProse([assistant("Old answer", 1)], 1), { text: "", timestamp: undefined });
	// 停在工具调用上的那一轮：往回找它最后说过的话，回报卡仍挂在最后一条回复下面。
	assert.deepEqual(lastProse([assistant("Old answer", 1), process], 1), { text: "Let me inspect", timestamp: 2 });
	assert.deepEqual(lastProse([process, restated], 0), { text: "Final", timestamp: 3 });
});

const explore = { summary: "Entry is in src/a.ts", files: [{ path: "src/a.ts:12", why: "defines main" }] };

test("yield checks the definition's output shape, retries twice, then accepts with warnings and ends the turn", async (t) => {
	const f = await fixture(t);
	await f.run({ description: "Find entry", prompt: "Find it", subagent_type: "explore" });
	await until(() => Boolean(f.api().list("main")[0]?.runId));
	const first = await f.run({ summary: "x" }, "child-1", "yield");
	assert.equal(first.isError, true);
	assert.match(first.output, /`files`/);
	assert.equal(first.terminate, undefined);
	assert.equal((await f.run({ summary: 1, files: [] }, "child-1", "yield")).isError, true);
	const third = await f.run({ summary: "Partly", files: "src/a.ts" }, "child-1", "yield");
	assert.equal(third.isError, undefined);
	assert.equal(third.terminate, "done");
	assert.deepEqual(f.api().list("main")[0]!.warnings, ["files 应该是一个数组，实际是 string。"]);
	f.finish(0, "done");
	await until(() => f.reports.length === 1);
	assert.match(f.reports[0]!.text, /⚠ 这个结果有 1 处不符合约定的格式/);
});

test("a clean yield ends the turn and is delivered as the structured result inside <subagent_result>", async (t) => {
	const f = await fixture(t);
	await f.run({ description: "Find entry", prompt: "Find it", subagent_type: "explore" });
	await f.run({ description: "Other", prompt: "Other work" });
	await until(() => Boolean(f.api().list("main")[0]?.runId));
	const done = await f.run(explore, "child-1", "yield");
	assert.deepEqual([done.output, done.terminate], ["结果已提交。", "done"]);
	f.messages.get("child-1")!.push({ role: "assistant", content: [{ type: "toolCall", id: "y", name: "yield", arguments: explore }], timestamp: 50 } as Message);
	f.finish(0, "done");
	await until(() => f.reports.length === 1);
	const text = f.reports[0]!.text;
	assert.match(
		text,
		/<subagent_result id="child-1" agent="explore" task="Find entry" status="done">\nEntry is in src\/a.ts\n\n\*\*files\*\*\n- `src\/a.ts:12` — why: defines main\n<\/subagent_result>/,
	);
	assert.match(text, /还有 1 个没回来：general（Other）/);
	const task = f.api().list("main")[0]!;
	assert.deepEqual(task.output, explore);
	assert.equal(task.answerTimestamp, 50);
	assert.equal(task.incomplete, undefined);
});

test("an empty yield does not end the turn and falls back to the last prose; strict definitions refuse after the retries", async (t) => {
	const f = await fixture(t);
	const agents = join(f.directory, "home", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(
		join(agents, "checker.md"),
		"---\nname: checker\ndescription: Checks\nschema-mode: strict\noutput:\n  type: object\n  required: [passed]\n  properties:\n    passed:\n      type: boolean\n---\nCheck",
	);
	await f.run({ description: "Find entry", prompt: "Find it", subagent_type: "explore" });
	await f.run({ description: "Check", prompt: "Check it", subagent_type: "checker" });
	await until(() => f.starts.length === 2);
	const empty = await f.run({ summary: "", files: [] }, "child-1", "yield");
	assert.equal(empty.terminate, undefined);
	f.finish(0, "done", "Nothing found.");
	await until(() => f.reports.length === 1);
	assert.match(f.reports[0]!.text, /status="done">\nNothing found.\n</);
	for (let n = 0; n < 2; n++) assert.equal((await f.run({ passed: "yes" }, "child-2", "yield")).isError, true);
	const last = await f.run({ passed: "yes" }, "child-2", "yield");
	assert.equal(last.isError, true);
	assert.match(last.output, /派生失败/);
	assert.equal(f.api().list("main")[1]!.output, undefined);
});

test("yield is offered only to sub-agents, with the definition's shape and a delivery note", async (t) => {
	const f = await fixture(t);
	const layer = f.layers.get("model.context") as HookLayer<"model.context">;
	const withYield = (sessionId: string): ModelContext => ({
		...context(sessionId),
		tools: [...context(sessionId).tools, { name: "yield", description: "handoff", parameters: { required: ["summary", "remaining"] } }],
	});
	const main = await layer(withYield("main"), async (input) => input);
	assert.equal(
		main.tools.some((tool) => tool.name === "yield"),
		false,
	);
	assert.equal((await f.run({ summary: "x" }, "main", "yield")).isError, true);
	// 交差用的工具每一种都有，定义编辑器里不让挑。
	assert.equal((await f.api().catalog(null)).tools.includes("yield"), false);
	await f.run({ description: "Find entry", prompt: "Find it", subagent_type: "explore" });
	await f.run({ description: "General", prompt: "Do it" });
	await until(() => f.starts.length === 2);
	const child = await layer(withYield("child-1"), async (input) => input);
	const tool = child.tools.find((entry) => entry.name === "yield")!;
	assert.deepEqual((tool.parameters as { required: string[] }).required, ["summary", "files"]);
	assert.match(child.sections.at(-1)!.text, /必须调用 `yield`[\s\S]*`summary`、`files`/);
	const general = await layer(withYield("child-2"), async (input) => input);
	assert.equal(general.tools.find((entry) => entry.name === "yield")!.description, "handoff");
	assert.doesNotMatch(general.sections.at(-1)!.text, /交付/);
});

/** 子会话一步收尾：`results` 是这一步有没有工具结果；里层照自然结论接着做，`inner` 记下里层被问过几次。 */
function stepEnder(f: Awaited<ReturnType<typeof fixture>>, sessionId = "child-1") {
	const layer = f.layers.get("step.end") as unknown as HookLayer<"step.end">;
	const inner = { calls: 0 };
	const end = (step: number, results = true) =>
		layer(
			{
				sessionId,
				cwd: "/work",
				step,
				stepsLeft: 200 - step,
				reply: assistant("") as never,
				toolResults: results ? [{} as never] : [],
				signal: new AbortController().signal,
			},
			async () => {
				inner.calls++;
				return { continue: true };
			},
		);
	return { end, inner };
}

function executor(f: Awaited<ReturnType<typeof fixture>>, sessionId = "child-1") {
	const execute = f.layers.get("tool.execute") as HookLayer<"tool.execute">;
	return (name: string) =>
		execute(
			{
				sessionId,
				cwd: "/work",
				call: { id: "c", name, args: {} },
				tool: { name, mutating: false, plugin: "x" },
				signal: new AbortController().signal,
			} as never,
			async () => ({ output: "ran" }),
		);
}

const todoResult = (...statuses: string[]): Message =>
	({
		role: "toolResult",
		toolCallId: "t",
		toolName: "todo_write",
		content: [{ type: "text", text: "ok" }],
		details: { kind: "todo", todos: statuses.map((status, index) => ({ content: `step ${index}`, status })) },
		isError: false,
		timestamp: Date.now(),
	}) as Message;

test("every 60 steps a checkpoint: an advancing list carries on, two stalled segments ask for a handoff; the two handoff steps only run yield", async (t) => {
	const f = await fixture(t);
	await f.run({ description: "Big job", prompt: "Do a lot" });
	await until(() => Boolean(f.api().list("main")[0]?.runId));
	const { end, inner } = stepEnder(f);
	const call = executor(f);
	assert.deepEqual(await end(59), { continue: true });
	// 第一段勾了一项：接着跑。
	f.messages.get("child-1")!.push(todoResult("completed", "in_progress", "pending"));
	assert.deepEqual(await end(60), { continue: true });
	// 第二段一项没勾：允许一次。
	assert.deepEqual(await end(120), { continue: true });
	// 第三段还是没勾：停下讨交接，这一段的轮数照每段算。
	const demand = await end(180);
	assert.equal(demand.continue, true);
	assert.match((demand as { say: string }).say, /这一段的 60 轮已经用完/);
	// 讨交接的第一步：别的工具拒掉，这一轮还没完；收尾不问里层。
	const asked = inner.calls;
	assert.match((await call("read")).output, /只能调用 `yield`/);
	assert.equal((await call("read")).terminate, undefined);
	assert.deepEqual(await end(181), { continue: true });
	assert.equal(inner.calls, asked);
	// 第二步：不管交没交上，这一轮到此为止。
	const last = await call("read");
	assert.deepEqual([/只能调用 `yield`/.test(last.output), last.terminate], [true, "done"]);
	assert.deepEqual(await call("yield"), { output: "ran", terminate: "done" });
	const handoff = await f.run({ summary: "Did half", remaining: "The other half" }, "child-1", "yield");
	assert.equal(handoff.terminate, "done");
	f.finish(0, "done");
	await until(() => f.reports.length === 1);
	assert.match(f.reports[0]!.text, /incomplete="true">\n⚠ 到了检查点（这一段 60 轮），它还没做完。下面是它交的阶段性交接/);
	const task = f.api().list("main")[0]!;
	assert.deepEqual([task.state, task.incomplete], ["done", true]);
	assert.equal(wayBack(task), "resume");
	// 续跑：上一段交的东西清掉，讨交接的状态也不带过去；清单的起点是上一段留下的那份。
	await f.run({ description: "Continue", prompt: "Finish", resume: "child-1" });
	await until(() => f.starts.length === 2);
	const resumed = f.api().list("main")[0]!;
	assert.deepEqual([resumed.output, resumed.answer, resumed.incomplete], [undefined, undefined, undefined]);
	assert.equal((await call("read")).output, "ran");
	assert.deepEqual(await end(60), { continue: true });
	assert.match(((await end(120)) as { say: string }).say, /这一段的 60 轮已经用完/);
});

test("a checkpoint with no list asks once to write one when todo_write exists, otherwise asks for the handoff; a finished list stops", async (t) => {
	const f = await fixture(t);
	await Promise.all([f.run({ description: "A", prompt: "a" }), f.run({ description: "B", prompt: "b" })]);
	await until(
		() =>
			f.starts.length === 2 &&
			f
				.api()
				.list("main")
				.every((task) => task.runId),
	);
	// 没有清单工具：说「列清单」是一句做不到的话，直接讨交接。
	assert.match(((await stepEnder(f, "child-1").end(60)) as { say: string }).say, /只能调用 `yield`/);
	f.tools.set("todo_write", { name: "todo_write" } as ToolDefinition);
	const b = stepEnder(f, "child-2");
	assert.match(((await b.end(60)) as { say: string }).say, /先用 `todo_write` 把剩下的步骤列出来/);
	// 只给一次：还是没写，讨交接。
	assert.match(((await b.end(120)) as { say: string }).say, /只能调用 `yield`/);
	// 清单都勾完了还撞上检查点：它在清单之外还在忙，停下。
	await f.run({ description: "C", prompt: "c" });
	await until(() => f.starts.length === 3 && Boolean(f.api().list("main")[2]?.runId));
	f.messages.get("child-3")!.push(todoResult("completed"));
	assert.match(((await stepEnder(f, "child-3").end(60)) as { say: string }).say, /只能调用 `yield`/);
	// 讨交接时回复没调工具：这一轮就此结束。
	assert.deepEqual(await stepEnder(f, "child-3").end(61, false), { continue: false });
});

test("maxTurns in the definition sets the segment, capped at the host's 200 steps; the working note says it", async (t) => {
	const f = await fixture(t);
	const agents = join(f.directory, "home", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "short.md"), "---\nname: short\ndescription: Short\nmax-turns: 10\n---\nGo");
	writeFileSync(join(agents, "long.md"), "---\nname: long\ndescription: Long\nmaxTurns: 500\n---\nGo");
	// 同时派时谁先建出子会话不一定：按种类找它的子会话。
	await Promise.all([f.run({ description: "S", prompt: "s", subagent_type: "short" }), f.run({ description: "L", prompt: "l", subagent_type: "long" })]);
	await until(
		() =>
			f.starts.length === 2 &&
			f
				.api()
				.list("main")
				.every((task) => task.runId),
	);
	const session = (agent: string) =>
		f
			.api()
			.list("main")
			.find((task) => task.agent === agent)!.session;
	const layer = f.layers.get("model.context") as HookLayer<"model.context">;
	const note = async (agent: string) => (await layer(context(session(agent)), async (input) => input)).sections.at(-1)!.text;
	assert.match(await note("short"), /每跑 10 轮[\s\S]*`todo_write` 记下步骤/);
	assert.deepEqual(await stepEnder(f, session("short")).end(9), { continue: true });
	assert.match(((await stepEnder(f, session("short")).end(10)) as { say: string }).say, /这一段的 10 轮已经用完/);
	// 一段比宿主一轮还长：按一轮的 200 步说，只剩两步时讨交接。
	assert.match(await note("long"), /每跑 200 轮/);
	assert.deepEqual(await stepEnder(f, session("long")).end(197), { continue: true });
	assert.match(((await stepEnder(f, session("long")).end(198)) as { say: string }).say, /这一段的 200 轮已经用完/);
});

test("running out of steps without a handoff, stalling and provider errors each say why in front of the last prose", async (t) => {
	const f = await fixture(t);
	await Promise.all([f.run({ description: "A", prompt: "a" }), f.run({ description: "B", prompt: "b" }), f.run({ description: "C", prompt: "c" })]);
	await until(() => f.starts.length === 3);
	f.finish(0, "max_turns", "Let me look at x");
	f.finish(1, "stalled", "Trying again");
	f.finish(2, "error", "Half done");
	await until(() => f.reports.length === 3);
	const [a, b, c] = f.api().list("main");
	assert.deepEqual([a!.state, b!.state, c!.state], ["done", "done", "failed"]);
	assert.match(a!.answer!, /^⚠ 到了检查点（这一段 60 轮），它还没做完，也没交出交接[\s\S]*Let me look at x$/);
	assert.match(b!.answer!, /^⚠ 它反复用同样的参数[\s\S]*Trying again$/);
	assert.match(c!.answer!, /^⚠ 模型服务出错[\s\S]*Half done$/);
	assert.ok(f.reports.every((report) => report.text.includes('incomplete="true"')));
});

test("agent:// 读这个会话派出的子代理交回的结果：整份、一个字段、没声明结构的回复；别的会话的读不到", async (t) => {
	const f = await fixture(t);
	await f.run({ description: "Find entry", prompt: "Find it", subagent_type: "explore" });
	await f.run({ description: "Other", prompt: "Other work" });
	await until(() => f.starts.length === 2);
	await f.run(explore, "child-1", "yield");
	f.finish(0, "done");
	f.finish(1, "done", "plain answer");
	await until(() => f.reports.length === 2);
	const handler = f.resources.find((resource) => resource.scheme === "agent")!;
	const scope = { sessionId: "main", cwd: "/work", scratchDir: "/tmp" };
	const read = (raw: string, sessionId = "main") => {
		const path = raw.slice("agent://".length);
		const address: ResourceAddress = { scheme: "agent", path, segments: path.split("/").filter(Boolean), raw };
		return handler.resolve(address, { ...scope, sessionId });
	};
	const whole = await read("agent://child-1");
	assert.deepEqual(JSON.parse(whole.content), explore);
	assert.equal(whole.label, "子代理 explore 的完整结果");
	const field = await read("agent://ld-1/files.0.path");
	assert.equal(field.content, "src/a.ts:12");
	assert.equal(field.label, "子代理 explore 结果里的 files.0.path");
	const prose = await read("agent://child-2");
	assert.equal(prose.content, "plain answer");
	assert.match(prose.label!, /没有声明结构化输出/);
	await assert.rejects(read("agent://child-1/nope"), /结果里没有 `nope`。可用的顶层字段：summary、files/);
	await assert.rejects(read("agent://child-1", "other"), /没有 id 是“child-1”的子代理。现有的是：（一个都没有）/);
	assert.deepEqual(await handler.list!(scope), [
		{ value: "agent://child-1", description: "explore · Find entry · done" },
		{ value: "agent://child-2", description: "general · Other · done" },
	]);
	await f.unload();
	assert.equal(f.resources.length, 0);
});

test("收工时停掉子会话自己起的后台进程，父会话的不动；续跑那一段收工时再停", async (t) => {
	const f = await fixture(t);
	await f.run({ description: "Serve", prompt: "Start the dev server" });
	await until(() => f.starts.length === 1);
	f.jobs.push(
		{ sessionId: "child-1", id: "dev", status: "running" },
		{ sessionId: "child-1", id: "old", status: "exited" },
		{ sessionId: "main", id: "mine", status: "running" },
	);
	f.finish(0, "done", "Started");
	await until(() => f.reports.length === 1);
	assert.deepEqual(f.killed, [{ sessionId: "child-1", id: "dev", force: true }]);
	f.jobs.push({ sessionId: "child-1", id: "again", status: "running" });
	await f.run({ description: "Again", prompt: "More", resume: "child-1" });
	await until(() => f.starts.length === 2);
	assert.equal(f.killed.length, 1, "跑着的时候不动");
	f.finish(1, "aborted");
	await until(() => f.killed.length === 2);
	assert.deepEqual(f.killed[1], { sessionId: "child-1", id: "again", force: true });
});

test("父会话还有子代理没回来：里层拿到 awaiting（空回复催在等谁），每 4 次带工具的请求提醒一次，名单变了从头数", async (t) => {
	const f = await fixture(t);
	const layer = f.layers.get("step.end") as HookLayer<"step.end">;
	const seen: Array<{ awaiting?: string }> = [];
	const end = (step: number, results: boolean) =>
		layer(
			{
				sessionId: "main",
				cwd: "/work",
				step,
				stepsLeft: 200 - step,
				reply: assistant("") as never,
				toolResults: results ? [{} as never] : [],
				signal: new AbortController().signal,
			},
			async (input) => {
				seen.push({ awaiting: input.awaiting?.nudge });
				return results ? { continue: true } : { continue: false };
			},
		);
	// 没派出去的：原样交给里层。
	assert.deepEqual(await end(1, true), { continue: true });
	assert.equal(seen[0]!.awaiting, undefined);
	await f.run({ description: "Find entry", prompt: "Find it", subagent_type: "explore" });
	await until(() => f.starts.length === 1);
	// 名单变了的那一步不说；之后第 4 次说一遍，再隔 4 次又说。
	const said: Array<string | undefined> = [];
	for (let step = 2; step <= 10; step++) {
		const verdict = await end(step, true);
		said.push(verdict.continue ? verdict.say : undefined);
	}
	assert.deepEqual(
		said.map((say) => (say ? "note" : "-")),
		["-", "-", "-", "-", "note", "-", "-", "-", "note"],
	);
	assert.match(said[4]!, /还有 1 个没回来：explore（Find entry）[\s\S]*不要给用户写结论/);
	assert.match(seen.at(-1)!.awaiting!, /上一条回复没有正文。派出去的子代理还有 1 个没回来：explore（Find entry）/);
	// 没有工具结果的一步只交 awaiting，不加提醒。
	assert.deepEqual(await end(11, false), { continue: false });
	assert.ok(seen.at(-1)!.awaiting);
	// 回来了：不再带 awaiting。
	f.finish(0, "done", "src/a.ts:12");
	await until(() => f.reports.length === 1);
	assert.deepEqual(await end(12, true), { continue: true });
	assert.equal(seen.at(-1)!.awaiting, undefined);
});

test("task 的说明写明结论要等子代理都回来", async (t) => {
	const f = await fixture(t);
	assert.match(
		f.tools.get("task")!.description,
		/write no final answer or summary, and never guess what they will find, until every sub-agent you dispatched has reported/,
	);
	const result = await f.run({ description: "Find entry", prompt: "Find it" });
	assert.match(result.output, /until every dispatched sub-agent has reported, do not write a conclusion/);
});
