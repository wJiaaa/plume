import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AssistantMessage, Message, ModelContext, Plugin } from "@plume/contract";
import type { ToolCallContent } from "@plume/llm/types";
import todo from "../../../builtin/todo/src/index.ts";
import { PluginHost, type HostSessions } from "../src/host.ts";
import { runSteps, type TurnScope } from "../src/loop.ts";
import { RepetitionWatch } from "../src/repetition.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
let sequence = 0;
const call = (name: string, args: Record<string, unknown> = {}): ToolCallContent => ({ type: "toolCall", id: `c${sequence++}`, name, arguments: args });
const reply = (calls: ToolCallContent[] = [], text = "", stopReason = calls.length ? "toolUse" : "stop"): AssistantMessage =>
	({
		role: "assistant",
		content: [...(text ? [{ type: "text" as const, text }] : []), ...calls],
		stopReason,
		timestamp: 0,
	}) as AssistantMessage;
const reads = (count: number, text = "") => Array.from({ length: count }, (_, index) => reply([call("read", { path: `a${sequence}-${index}` })], text));

async function setup(replies: AssistantMessage[], plugins: Plugin[] = []) {
	const dir = await mkdtemp(join(tmpdir(), "plume-loop-parity-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const messages: Message[] = [];
	const executed: string[] = [];
	const notices: string[] = [];
	const host = new PluginHost({
		dataDir: dir,
		appDataDir: dir,
		log: () => {},
		notice: () => {},
		model: {
			complete: async () => "",
			usage: async () => ({ requests: [], providerNames: {}, archived: [] }),
			findImageModel: async () => ({ reason: "none", candidates: [] }),
			image: async () => ({ ok: false, failure: { summary: "" } }),
		},
		sessions: { messages: async () => structuredClone(messages), disposeOwner: async () => {} } as unknown as HostSessions,
	});
	cleanups.push(() => host.dispose());
	const tools: Plugin = {
		name: "test.tools",
		apply(ctx) {
			for (const name of ["read", "edit", "noargs"])
				ctx.tools.register({
					name,
					description: name,
					parameters: { type: "object", required: name === "noargs" ? [] : ["path"] },
					execute: async () => {
						executed.push(name);
						return { output: "结果" };
					},
				});
		},
	};
	await host.load([tools, ...plugins].map((plugin) => ({ key: plugin.name, load: async () => plugin })));
	let requests = 0;
	const scope: TurnScope = {
		sessionId: "s",
		cwd: dir,
		scratchDir: dir,
		signal: new AbortController().signal,
		host,
		log: () => {},
		repetition: new RepetitionWatch(),
		context: async () =>
			host.run(
				"model.context",
				{
					sessionId: "s",
					cwd: dir,
					scratchDir: dir,
					model: { id: "m", name: "m" },
					permissionMode: "auto",
					personalization: { customInstructions: "", tone: "professional" },
					systemPrompt: "",
					sections: [],
					messages,
					tools: host.toolSpecs(),
				} as ModelContext,
				async (input) => input,
			),
		boundary: async () => false,
		request: async () => {
			const next = replies[requests++];
			if (!next) throw new Error("请求超出测试回复");
			return next;
		},
		commit: async (message) => {
			messages.push(message);
		},
		notice: (text) => {
			notices.push(text);
		},
		compact: async () => false,
		withhold: async () => false,
		permission: async () => ({ mode: "full", alwaysAllow: [] }),
		ask: async () => "once",
		started: () => {},
		progress: () => {},
	};
	return { scope, messages, executed, notices, requests: () => requests };
}
const spoken = (messages: Message[]) =>
	messages.filter((message) => message.role === "user" && message.synthetic).map((message) => JSON.stringify(message.content));
const lost = () => reply([call("read"), call("read")]);

it("并行调用整轮丢参不执行，纠正后连续三轮按 error 停下，不掺入重复提醒", async () => {
	const state = await setup([lost(), lost(), lost(), reply([], "不该到这里")]);
	expect(await runSteps(state.scope)).toEqual({ reason: "error", error: "模型服务连续 3 轮丢失了工具调用的参数，请更换模型或服务商后重试。" });
	expect(state.requests()).toBe(3);
	expect(state.executed).toEqual([]);
	const results = state.messages.filter((message) => message.role === "toolResult");
	expect(results).toHaveLength(6);
	for (const result of results) {
		expect(result.details).toEqual({ argumentsLost: true });
		expect(JSON.stringify(result.content)).toContain("Make one tool call per reply from now on");
	}
	expect(spoken(state.messages)).toEqual([]);
	expect(state.scope.repetition.replaced.size).toBe(0);
});

it("正常工具步清零丢参连续计数；单调用、混有正常参数、无参工具或未知工具都不误判", async () => {
	const state = await setup([lost(), lost(), reply([call("read", { path: "a" })]), lost(), lost(), reply([], "结束")]);
	expect(await runSteps(state.scope)).toEqual({ reason: "done" });
	expect(state.executed).toEqual(["read"]);
	for (const calls of [[call("read")], [call("read"), call("read", { path: "a" })], [call("read"), call("noargs")], [call("read"), call("unknown")]]) {
		const edge = await setup([reply(calls), reply([], "结束")]);
		expect(await runSteps(edge.scope)).toEqual({ reason: "done" });
		expect(edge.messages.filter((message) => message.role === "toolResult").every((message) => !message.details)).toBe(true);
		expect(edge.executed.length).toBeGreaterThan(0);
	}
});

it("无清单也每二十个沉默工具步提醒一次，提醒只说明现状且不停止", async () => {
	const state = await setup([...reads(40), reply([], "结束")]);
	expect(await runSteps(state.scope)).toEqual({ reason: "done" });
	const notes = spoken(state.messages);
	expect(notes).toHaveLength(2);
	for (const note of notes) {
		expect(note).toContain("连续 20 次请求没有对用户说过话");
		expect(note).toContain("不要给阶段性结论");
		expect(note).toContain("不需要为此新建任务清单");
	}
	expect(state.requests()).toBe(41);
});

it("正文汇报重置计数，重复提醒与进度提醒同一步都说且顺序固定", async () => {
	const speaking = await setup([...reads(19), ...reads(1, "正在读"), ...reads(19), reply([], "结束")]);
	await runSteps(speaking.scope);
	expect(spoken(speaking.messages)).toEqual([]);
	const repeated = Array.from({ length: 3 }, () => reply([call("read", { path: "same" })]));
	const state = await setup([...reads(17), ...repeated, reply([], "结束")]);
	await runSteps(state.scope);
	const notes = spoken(state.messages);
	expect(notes).toHaveLength(1);
	expect(notes[0]).toMatch(/同样的参数[\s\S]*连续 20 次请求没有对用户说过话/);
});

it("插件重复 next 后抛错只计一步；不调 next 时本体不插进度提醒", async () => {
	const twice: Plugin = {
		name: "test.twice",
		apply: (ctx) =>
			ctx.hook("step.end", async (input, next) => {
				await next(input);
				const verdict = await next(input);
				if (input.step === 10) throw new Error("测试失败");
				return verdict;
			}),
	};
	const state = await setup([...reads(20), reply([], "结束")], [twice]);
	await runSteps(state.scope);
	expect(spoken(state.messages)).toHaveLength(1);
	const replaced: Plugin = {
		name: "test.replace",
		apply: (ctx) => ctx.hook("step.end", async (input) => (input.toolResults.length ? { continue: true } : { continue: false })),
	};
	const other = await setup([...reads(20), reply([], "结束")], [replaced]);
	await runSteps(other.scope);
	expect(spoken(other.messages)).toEqual([]);
});

it("todo 清单共用循环计数：有未完项只认更新清单，完成后仍提醒正文汇报", async () => {
	const todos = [{ content: "读代码", status: "in_progress" }];
	const state = await setup(
		[
			reply([call("todo_write", { todos }), call("read", { path: "start" })]),
			...reads(20, "正在继续读"),
			reply([call("todo_write", { todos: [{ content: "读代码", status: "completed" }] }), call("read", { path: "done" })]),
			...reads(20),
			reply([], "结束"),
		],
		[todo],
	);
	expect(await runSteps(state.scope)).toEqual({ reason: "done" });
	const notes = spoken(state.messages);
	expect(notes).toHaveLength(2);
	expect(notes[0]).toContain("任务清单已经 20 次请求没更新了");
	expect(notes[1]).toContain("连续 20 次请求没有对用户说过话");
});

it("同一步末尾成功 edit 先让旧观察作废，精确重复仍在第十次停下", async () => {
	const state = await setup([
		reply(Array.from({ length: 9 }, () => call("read", { path: "a" }))),
		reply([call("read", { path: "a" }), call("edit", { path: "b" })]),
		reply([], "结束"),
	]);
	expect(await runSteps(state.scope)).toEqual({ reason: "done" });
	const repeated = await setup([reply(Array.from({ length: 10 }, () => call("read", { path: "a" })))]);
	expect(await runSteps(repeated.scope)).toEqual({ reason: "stalled" });
	expect(repeated.notices).toHaveLength(1);
});

it("带工具和纯正文的连续截断共享三次续写预算", async () => {
	const state = await setup([
		reply([], "前半段", "length"),
		reply([call("read", { path: "a" })], "", "length"),
		reply([], "后一段", "length"),
		reply([call("read", { path: "b" })], "", "length"),
		reply([], "不该到这里"),
	]);
	expect((await runSteps(state.scope)).reason).toBe("error");
	expect(state.requests()).toBe(4);
	expect(state.executed).toEqual([]);
});

it("外层说还在等后台（awaiting）：空回复催的是它那句，清单收尾不追问；没说时照旧", async () => {
	const todos = [{ content: "合并结论", status: "in_progress" }];
	const replies = () => [reply([call("todo_write", { todos }), call("read", { path: "a" })]), reply([], ""), reply([], "还在等 explore")];
	const awaiting: Plugin = {
		name: "test.awaiting",
		apply: (ctx) => ctx.hook("step.end", async (input, next) => next({ ...input, awaiting: { nudge: "说一句在等谁" } }), { order: -20 }),
	};
	const waiting = await setup(replies(), [todo, awaiting]);
	expect(await runSteps(waiting.scope)).toEqual({ reason: "done" });
	expect(spoken(waiting.messages)).toEqual([JSON.stringify([{ type: "text", text: "说一句在等谁" }])]);

	const plain = await setup([...replies(), reply([], "")], [todo]);
	expect(await runSteps(plain.scope)).toEqual({ reason: "done" });
	const notes = spoken(plain.messages);
	expect(notes).toHaveLength(2);
	expect(notes[0]).toContain("上一条回复没有正文。请给出回答");
	expect(notes[1]).toContain("任务清单里还有 1 项没勾");
});
