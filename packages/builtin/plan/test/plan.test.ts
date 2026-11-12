import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type {
	ContextCompact,
	AssistantMessage,
	CommandProvider,
	HookLayer,
	HumanRequestInput,
	Message,
	ModelContext,
	PluginContext,
	SessionLaunch,
	StepEnd,
	StepVerdict,
	ToolDefinition,
	ToolExecution,
	ToolOutput,
	ToolResultMessage,
	ToolRun,
} from "@plume/contract";
import type { PlanApi } from "../src/api.ts";
import plugin from "../src/index.ts";
import { approvedPlans, currentPlan, planSubject, SUBMIT_PLAN } from "../src/plan.ts";

/**
 * 只有这个插件用到的那几样 ctx。`child` 的父会话是 `main`。`launch` 记下开过的新会话，`fail` 给了就让它抛这个错。
 */
async function fakeContext(stored: Message[] = [], options: { fail?: string } = {}) {
	const tools = new Map<string, ToolDefinition>();
	const layers = new Map<string, unknown>();
	let commands: CommandProvider | undefined;
	let api: PlanApi | undefined;
	const dataDir = await mkdtemp(join(tmpdir(), "plume-plan-"));
	const launched: SessionLaunch[] = [];
	const notices: string[] = [];
	let calls = 0;
	const ctx = {
		name: "plume.plan",
		dataDir,
		notice: (_sessionId: string, text: string) => void notices.push(text),
		log: { info() {}, warn() {}, error() {} },
		locale: () => "zh-CN",
		tools: { register: (tool: ToolDefinition) => void tools.set(tool.name, tool) },
		// 同一个钩子挂了不止一层时按 order 分开存：`model.context@-1001` 是 plume.prompt 外面的那层。
		hook: (name: string, layer: unknown, options?: { order?: number }) =>
			void layers.set(options?.order === undefined ? name : `${name}@${options.order}`, layer),
		commands: { provide: (provider: CommandProvider) => void (commands = provider) },
		serve: (served: PlanApi) => void (api = served),
		sessions: {
			get: async (id: string) =>
				[
					{ id: "a1b2c3d4-0000-4000-8000-000000000000", title: "改登录 [草稿]", cwd: "/w", project: "p1" },
					{ id: "main", title: "", cwd: "/w/app" },
					{ id: "fresh" },
					{ id: "child", parentId: "main" },
				].find((session) => session.id === id),
			messages: async () => stored,
			onDeleted: () => undefined,
			models: async () => [{ id: "m1", name: "Model One", contextWindow: 1 }],
			async launch(launch: SessionLaunch) {
				if (options.fail) throw new Error(options.fail);
				launched.push(launch);
				return { session: { id: "new" }, done: new Promise(() => {}), idle: new Promise(() => {}) };
			},
		},
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	if (!api || !commands) throw new Error("插件没开接口或没供命令");

	const signal = new AbortController().signal;
	/** 经 tool.execute 跑一次调用，最里层记下交给工具的输入。 */
	const execute = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
		let reached: ToolExecution | undefined;
		const layer = layers.get("tool.execute") as HookLayer<"tool.execute">;
		const output = await layer(
			{
				sessionId,
				cwd: "/w",
				call: { id: name, name, args },
				tool: { name, mutating: true, plugin: "plume.tools" },
				signal,
				ask: async () => true,
				progress() {},
			},
			async (input) => {
				reached = input;
				return { output: "ran" };
			},
		);
		return { output, reached };
	};
	/** 交一份计划，`reply` 是人在计划卡上交回的（不给就是什么都没说的拒绝）。 */
	const submit = async (sessionId: string, plan: string, reply?: unknown) => {
		const asked: HumanRequestInput[] = [];
		const output = (await (tools.get(SUBMIT_PLAN) as ToolDefinition).execute({ plan }, {
			sessionId,
			toolCallId: `call-${++calls}`,
			cwd: "/w",
			scratchDir: join(dataDir, "scratch", sessionId),
			signal,
			progress() {},
			permissionMode: async () => "full",
			tools: () => [],
			calls: [],
			ask: async () => "reject",
			request: async (input) => {
				asked.push(input);
				return reply === undefined ? { answered: false, reason: "declined" } : { answered: true, value: reply };
			},
		} as ToolRun)) as ToolOutput;
		return { output, asked };
	};
	const end = (step: number, toolResults: string[], natural: StepVerdict = { continue: false }) =>
		(layers.get("step.end") as HookLayer<"step.end">)(
			{
				sessionId: "main",
				cwd: "/w",
				step,
				stepsLeft: 10,
				reply: { role: "assistant", content: [] } as unknown as AssistantMessage,
				toolResults: toolResults.map((toolName) => ({ toolName }) as ToolResultMessage),
				signal,
			} as StepEnd,
			async () => natural,
		);
	const sections = async (sessionId: string) =>
		(
			await (layers.get("model.context") as HookLayer<"model.context">)(
				{ sessionId, sections: [], tools: [] } as unknown as ModelContext,
				async (context) => context,
			)
		).sections.map((section) => section.id);
	const submitPrompt = (sessionId: string, fresh: boolean) =>
		(layers.get("prompt.submit") as HookLayer<"prompt.submit">)(
			{ sessionId, cwd: "/w", text: "hi", attachments: [], synthetic: false, fresh, signal },
			async () => ({ block: false }),
		);
	const compact = (history: Message[], keep: number) =>
		(layers.get("context.compact") as HookLayer<"context.compact">)({ sessionId: "main", history } as unknown as ContextCompact, async () => ({
			keep,
			summary: "摘要",
			head: [
				{ role: "user", content: [{ type: "text", text: "<session-summary>\n摘要\n</session-summary>" }], timestamp: 0, synthetic: true },
				{ role: "assistant", content: [{ type: "text", text: "Understood." }] } as unknown as Message,
			],
		}));
	const readOnly = async (sessionId: string) =>
		(
			await (layers.get("model.context@-1001") as HookLayer<"model.context">)(
				{ sessionId, sections: [], tools: [] } as unknown as ModelContext,
				async (context) => context,
			)
		).readOnly === true;
	return { api, commands, execute, submit, end, sections, readOnly, submitPrompt, compact, launched, notices };
}

test("关着时什么都不管；开着时写文件被拒，别的调用带着 readOnly 交下去，子会话受父会话的开关管", async () => {
	const plan = await fakeContext();
	assert.deepEqual((await plan.execute("main", "edit")).output, { output: "ran" });
	assert.equal((await plan.execute("main", "bash")).reached?.readOnly, undefined);

	plan.api.set("main", true);
	const edit = await plan.execute("main", "edit");
	assert.equal(edit.reached, undefined);
	assert.equal(edit.output.isError, true);
	assert.match(edit.output.output, /^Plan mode: it edits files, so "edit" did not run/);
	assert.equal((await plan.execute("main", "bash", { command: "ls" })).reached?.readOnly, true);
	assert.equal((await plan.execute("main", "bash", { command: "touch x", escalate: "workspace-write" })).output.isError, true);
	assert.match((await plan.execute("child", "write")).output.output, /^The conversation that started you is in plan mode/);
	assert.equal((await plan.execute("child", "read")).reached?.readOnly, true);
	assert.equal((await plan.execute("fresh", "write")).reached?.readOnly, undefined);
	assert.deepEqual(await plan.sections("main"), ["plan"]);
	assert.deepEqual(await plan.sections("child"), []);
});

test("计划中在 plume.prompt 外面标上 readOnly，系统提示词按只读那档点名 shell；子会话跟着父会话", async () => {
	const plan = await fakeContext();
	assert.equal(await plan.readOnly("main"), false);
	plan.api.set("main", true);
	assert.equal(await plan.readOnly("main"), true);
	assert.equal(await plan.readOnly("child"), true);
	assert.equal(await plan.readOnly("fresh"), false);
});

test("交计划：只能人答；批准就地关掉开关，拒绝结束这一轮、开关不动；关着时和子会话里交不了", async () => {
	const plan = await fakeContext();
	assert.equal((await plan.submit("main", "# 计划", { accept: true })).output.isError, true);

	plan.api.set("main", true);
	assert.equal((await plan.submit("child", "# 计划", { accept: true })).output.isError, true);
	const declined = await plan.submit("main", "# 改登录\n\n概要");
	assert.deepEqual(declined.asked, [{ kind: SUBMIT_PLAN, title: "Plume 提出了一个计划", payload: "# 改登录\n\n概要", waiting: "等你批准计划" }]);
	assert.equal(declined.output.terminate, "done");
	assert.equal((await plan.execute("main", "edit")).reached, undefined);
	// 交回来的不成形（空的修改意见、认不出的回答）：和什么都没说的拒绝一样，这一轮停下。
	for (const bad of [{ accept: false, feedback: "  " }, "once", { accept: "yes" }]) {
		assert.equal((await plan.submit("main", "# 改登录", bad)).output.terminate, "done", JSON.stringify(bad));
		assert.equal((await plan.execute("main", "edit")).reached, undefined);
	}

	const approved = await plan.submit("main", "# 改登录\n\n概要", { accept: true });
	assert.match(approved.output.output, /^The user approved the plan\. Plan mode is off; every tool is available again\. The plan is saved at .*plan-\d+\.md\./);
	const { file, approvedAt } = approved.output.details as { file: string; approvedAt: number };
	assert.equal(file, join(dirname(file), `plan-${approvedAt}.md`));
	assert.equal(await readFile(file, "utf8"), "# 改登录\n\n概要\n");
	assert.deepEqual(approved.output.details, { kind: "plan", plan: "# 改登录\n\n概要", approved: true, approvedAt, file });
	assert.equal((await plan.execute("main", "edit")).reached?.readOnly, undefined);
});

test("/plan 不带话是开关，带话先开再发后半句；新对话的开关交给第一句话建出来的会话", async () => {
	const plan = await fakeContext();
	assert.deepEqual(await plan.commands.expand("plan", "", { sessionId: "main" }), { handled: true });
	assert.deepEqual(await plan.sections("main"), ["plan"]);
	assert.deepEqual(await plan.commands.expand("plan", "", { sessionId: "main" }), { handled: true });
	assert.deepEqual(await plan.sections("main"), []);
	assert.deepEqual(await plan.commands.expand("plan", "改登录", { sessionId: "main" }), { text: "改登录" });
	assert.deepEqual(await plan.sections("main"), ["plan"]);

	assert.deepEqual(await plan.commands.expand("plan", "", {}), { handled: true });
	await plan.submitPrompt("child", true);
	assert.deepEqual(await plan.sections("child"), []);
	await plan.submitPrompt("fresh", true);
	assert.deepEqual(await plan.sections("fresh"), ["plan"]);
});

test("查过东西、以正文收尾却没交计划：提醒一次；没调过工具、交过计划、问过人的不提醒", async () => {
	const plan = await fakeContext();
	plan.api.set("main", true);
	assert.deepEqual(await plan.end(1, []), { continue: false });

	await plan.end(1, ["read"], { continue: true });
	const reminded = await plan.end(2, []);
	assert.equal(reminded.continue, true);
	assert.deepEqual(await plan.end(3, []), { continue: false });

	await plan.end(1, ["read", SUBMIT_PLAN], { continue: true });
	assert.deepEqual(await plan.end(2, []), { continue: false });

	await plan.end(1, ["read", "ask_user"], { continue: true });
	assert.deepEqual(await plan.end(2, []), { continue: false });
});

test("面板读最后交上来的那份：批没批都算，被工具当场退回的不算", () => {
	const call = (id: string, plan: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: SUBMIT_PLAN, arguments: { plan } }] });
	const result = (id: string, details: unknown, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: SUBMIT_PLAN, details, isError });
	const messages = [
		call("a", "# 一"),
		result("a", { kind: "plan", plan: "# 一", approved: false }),
		call("b", "# 二"),
		result("b", undefined, true),
	] as unknown as Message[];
	assert.deepEqual(currentPlan(messages), { plan: "# 一", status: "declined" });
	assert.deepEqual(currentPlan([...messages, call("c", "# 三")] as unknown as Message[]), { plan: "# 三", status: "open" });
});

test("环境卡片列批准过的每一份，按批准先后，打回的、退回的不列；转录里那一行点名计划的标题", () => {
	const result = (id: string, details: unknown, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: SUBMIT_PLAN, details, isError });
	const messages = [
		result("a", { kind: "plan", plan: "# 一", approved: true, approvedAt: 1, handoff: true }),
		result("b", { kind: "plan", plan: "# 二", approved: false }),
		result("c", undefined, true),
		result("d", { kind: "plan", plan: "# 三", approved: true, notes: "注意", approvedAt: 2 }),
	] as unknown as Message[];
	assert.deepEqual(approvedPlans(messages), [
		{ toolCallId: "a", plan: "# 一", approvedAt: 1, handoff: true },
		{ toolCallId: "d", plan: "# 三", notes: "注意", approvedAt: 2 },
	]);
	assert.equal(planSubject({ plan: "# 移除 Redisson\n\n## 概要\n换成单实例锁。" }), "移除 Redisson");
	assert.equal(planSubject({ plan: `# ${"长".repeat(50)}` }), "长".repeat(40));
	assert.equal(planSubject({}), undefined, "参数还在流进来时只说动作");
});

test("卡上的附言：拒绝带修改意见时回给模型、这一轮不停；接受带评论时评论成为注意事项", async () => {
	const plan = await fakeContext();
	plan.api.set("main", true);
	const revised = await plan.submit("main", "# 改登录", { accept: false, feedback: "  先别动数据库  " });
	assert.match(revised.output.output, /Feedback: 先别动数据库[\s\S]*Revise the plan/);
	assert.equal(revised.output.terminate, undefined);
	assert.deepEqual(revised.output.details, { kind: "plan", plan: "# 改登录", approved: false, feedback: "先别动数据库" });
	assert.equal((await plan.execute("main", "edit")).reached, undefined);

	const approved = await plan.submit("main", "# 改登录", { accept: true, note: "> 第二节\n\n注意兼容" });
	assert.match(approved.output.output, /approved the plan with notes[\s\S]*## 执行时注意\n> 第二节/);
	const details = approved.output.details as { notes?: string; approvedAt?: number };
	assert.equal(details.notes, "> 第二节\n\n注意兼容");
	assert.equal(typeof details.approvedAt, "number");
});

test("压缩把批准计划的那次结果折进摘要头时，计划接在头的第一条后面；结果还留着时不重复；交给新会话的不写成执行它", async () => {
	const call = { role: "assistant", content: [{ type: "toolCall", id: "p", name: SUBMIT_PLAN, arguments: { plan: "# 计划" } }] };
	const result = {
		role: "toolResult",
		toolCallId: "p",
		toolName: SUBMIT_PLAN,
		isError: false,
		details: { kind: "plan", plan: "# 计划", approved: true, notes: "小心", approvedAt: 1, file: "/s/plans/plan-1.md" },
	};
	const later = { role: "user", content: "接着做" };
	const history = [call, result, later, later] as unknown as Message[];
	const plan = await fakeContext(history);
	const texts = (compacted: Awaited<ReturnType<typeof plan.compact>>) =>
		compacted && "head" in compacted
			? compacted.head.flatMap((message) => (message.role === "user" && Array.isArray(message.content) ? message.content : []))
			: [];
	const dropped = await plan.compact(history, 2);
	assert.equal(dropped && "summary" in dropped ? dropped.summary : undefined, "摘要");
	const [summary, note] = texts(dropped);
	assert.match(summary && "text" in summary ? summary.text : "", /^<session-summary>/);
	assert.match(
		note && "text" in note ? note.text : "",
		/^<approved-plan>\nTranscript fact, not a summary claim\. User-approved plan \(execute it; re-plan only if the user says so\), saved at \/s\/plans\/plan-1\.md:\n\n# 计划\n\n## 执行时注意\n小心\n<\/approved-plan>$/,
	);
	assert.equal(texts(await plan.compact(history, 1)).length, 1);

	const handed = [call, { ...result, details: { ...result.details, handoff: true } }, later, later] as unknown as Message[];
	const [, handedNote] = texts(await (await fakeContext(handed)).compact(handed, 2));
	assert.match(
		handedNote && "text" in handedNote ? handedNote.text : "",
		/handed to another session that carries it out from \/s\/plans\/plan-1\.md \(do not carry it out here/,
	);
});

test("在新会话里执行：计划存成文件，在原会话的项目里开新会话、记着从这次调用开出来，这一轮停下", async () => {
	const origin = "a1b2c3d4-0000-4000-8000-000000000000";
	const plan = await fakeContext();
	plan.api.set(origin, true);
	const text = "# 改登录\n\n## 概要\n把登录改成短信验证码。\n\n## 改动\n- a.ts";
	const handed = await plan.submit(origin, text, { accept: true, note: "注意兼容", handoff: { model: "m1" } });
	const details = handed.output.details as { file: string; handoff?: boolean; model?: string; approvedAt: number };
	assert.equal(handed.output.terminate, "done");
	assert.equal(
		handed.output.output,
		`The user approved the plan and handed it to a new session, which carries it out from ${details.file}. Do not carry it out here. That session may message you about intent or trade-offs the plan leaves open; answer from this conversation.`,
	);
	assert.equal(details.handoff, true);
	assert.equal(details.model, "m1");
	// 评论写进文件末尾的「执行时注意」，新会话读得到。
	assert.equal(await readFile(details.file, "utf8"), `${text}\n\n## 执行时注意\n注意兼容\n`);
	assert.deepEqual(plan.launched, [
		{
			project: "p1",
			message: [
				"按已批准的计划实施：改登录",
				"把登录改成短信验证码。",
				[
					`- 计划文件：${details.file}。以它为准，动手前完整读一遍。`,
					"- 授权范围：按计划修改代码并完成计划里的验证。计划没写到的提交、推送、发布或改动外部状态，先问人。",
					// 不点名读会话、问会话的工具：那是别的插件的，它按 `spawnedFrom` 自己告诉新会话。
					"- 有疑问：能从代码查到的自己查；计划没定下的意图和取舍不要猜：开出这个会话的原会话里有这份计划的完整讨论，有办法读它、问它就先去那里找，没有就停下来问人。",
				].join("\n"),
			].join("\n\n"),
			title: "改登录",
			model: "m1",
			spawnedFrom: { sessionId: origin, toolCallId: "call-1" },
		},
	]);
	// 开关关了：这个会话之后照常能改文件（人再让它做时）。
	assert.equal((await plan.execute(origin, "edit")).reached?.readOnly, undefined);
});

test("在新会话里执行：原会话不在项目里时开在它的目录；开不出来时提示人、这一轮照样停下", async () => {
	const alone = await fakeContext();
	alone.api.set("main", true);
	await alone.submit("main", "改登录", { accept: true, handoff: {} });
	const [launch] = alone.launched;
	assert.equal(launch?.cwd, "/w/app");
	assert.equal(launch?.project, undefined);
	assert.equal(launch?.model, undefined);

	const broken = await fakeContext([], { fail: "项目已移除" });
	broken.api.set("main", true);
	const failed = await broken.submit("main", "改登录", { accept: true, handoff: {} });
	const { file } = failed.output.details as { file: string };
	assert.equal(failed.output.terminate, "done");
	assert.match(failed.output.output, /could not be started: 项目已移除\. The plan is saved at /);
	assert.deepEqual(broken.notices, [`执行计划的新会话没能开出来：项目已移除。计划保存在 ${file}。`]);
});
