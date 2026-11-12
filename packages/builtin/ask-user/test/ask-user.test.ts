/**
 * `ask_user`：参数的校验、问人时交出去的卡、交回的回答怎么核、怎么变成给模型的结果。
 * 人在卡上怎么答由 `run.request` 的假实现定：它拿到卡片的 `payload`，给出人交回的数据或没答的原因。
 */

import { expect, it } from "vitest";
import type { HumanAnswer, HumanRequestInput, PluginContext, ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";
import plugin from "../src/index.ts";
import { ASK_USER, type QuestionReply } from "../src/question.ts";

async function setup() {
	let tool: ToolDefinition | undefined;
	const ctx = {
		name: "plume.ask-user",
		locale: () => "zh-CN",
		tools: { register: (definition: ToolDefinition) => void (tool = definition) },
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	if (!tool) throw new Error("插件没注册工具");
	const asked: HumanRequestInput[] = [];
	/** 调一次 `ask_user`；`reply` 是人在卡上交的回答，或者没答的原因。 */
	const ask = async (
		args: Record<string, unknown>,
		reply: QuestionReply | (HumanAnswer & { answered: false }) = { answered: false, reason: "declined" },
	): Promise<ToolOutput> => {
		const run = {
			sessionId: "s",
			cwd: "/w",
			signal: new AbortController().signal,
			progress() {},
			async request(input: HumanRequestInput) {
				asked.push(input);
				return typeof reply === "object" && "answered" in reply ? reply : { answered: true, value: reply };
			},
			permissionMode: async () => "full",
			tools: () => [],
			calls: [],
		} as unknown as ToolRun;
		return await tool!.execute(args, run);
	};
	return { ask, asked };
}

const UNANSWERED = "The question was declined, or it expired with nobody at the keyboard.";

it("参数不成立时直接告诉模型，不问人", async () => {
	const { ask, asked } = await setup();
	const cases: [Record<string, unknown>, string][] = [
		[{ question: " ", options: ["A"] }, "Provide a question and choices with nonempty labels."],
		[{ question: "选哪个", options: ["A", ""] }, "Provide a question and choices with nonempty labels."],
		[{ question: "选哪个", options: [{ label: "A", recommended: "yes" }] }, "Provide a question and choices with nonempty labels."],
		[{ question: "选哪个", options: ["A", " A "] }, "Provide distinct choices, or enable custom input."],
		[{ question: "选哪个", options: [], allowCustomInput: false }, "Provide distinct choices, or enable custom input."],
		[{ question: "选哪个", options: ["A"], selectionMode: "many" }, "selectionMode must be single or multi."],
		[{ question: "选哪个", options: ["A"], defaultOptionIndex: 1 }, "defaultOptionIndex must identify an existing choice."],
		[{ question: "选哪个", options: ["A"], defaultOptionIndex: 0.5 }, "defaultOptionIndex must identify an existing choice."],
	];
	for (const [args, message] of cases) expect(await ask(args), JSON.stringify(args)).toEqual({ output: message, isError: true });
	expect(asked).toEqual([]);
});

it("问人的卡只能由人答，带着整理好的问题；选一项就是答案", async () => {
	const { ask, asked } = await setup();
	const result = await ask(
		{ question: "  先备份吗？ ", options: [" 备份 ", { label: "不备份", description: "直接改", recommended: true }] },
		{ answer: " 不备份 " },
	);
	expect(asked).toEqual([
		{
			kind: ASK_USER,
			title: "需要你的意见",
			payload: {
				question: "先备份吗？",
				options: ["备份", { label: "不备份", description: "直接改", recommended: true }],
				selectionMode: "single",
				allowCustomInput: true,
				allowSkip: true,
			},
		},
	]);
	expect(result).toEqual({ output: "不备份", details: { kind: "question", answer: "不备份", skipped: false } });
});

it("跳过：有默认项时采用它，没有时说清楚没给答案；不许跳过时不收", async () => {
	const { ask } = await setup();
	expect(await ask({ question: "用哪个库", options: ["A", "B"], defaultOptionIndex: 1 }, { skip: true })).toEqual({
		output: "The user skipped and accepted the explicit default: B",
		details: { kind: "question", answer: "B", skipped: true },
	});
	const bare = await ask({ question: "用哪个库", options: ["A", { label: "B", recommended: true }] }, { skip: true });
	expect(bare.output).toContain("The user skipped this question. No answer or permission was granted.");
	expect(bare.details).toEqual({ kind: "question", skipped: true });
	expect(bare.isError).toBeUndefined();
	// 卡上不许跳过，交回来的却是跳过：不照着问题答的客户端，当作没有回答。
	const locked = await ask({ question: "用哪个库", options: ["A"], allowSkip: false }, { skip: true });
	expect(locked).toMatchObject({ isError: true });
	expect(locked.output).toContain(UNANSWERED);
});

it("多选交一组、去重去空白，给模型的是 JSON 数组；单选交一组、多选里有重复的都不收", async () => {
	const { ask } = await setup();
	expect(await ask({ question: "要哪些", options: ["A", "B", "C"], selectionMode: "multi" }, { answer: ["A", " C"] })).toEqual({
		output: '["A","C"]',
		details: { kind: "question", answer: ["A", "C"], skipped: false },
	});
	for (const [args, reply] of [
		[{ question: "要哪个", options: ["A", "B"] }, { answer: ["A", "B"] }],
		[{ question: "要哪些", options: ["A", "B"], selectionMode: "multi" }, { answer: ["A", "A "] }],
		[{ question: "要哪些", options: ["A"], selectionMode: "multi" }, { answer: [] }],
	] as [Record<string, unknown>, QuestionReply][])
		expect((await ask(args, reply)).output).toContain(UNANSWERED);
});

it("自己写的回答默认收下；不许自填时只能选选项里的", async () => {
	const { ask } = await setup();
	expect(await ask({ question: "叫什么名字", options: [] }, { answer: "  plume-ask " })).toEqual({
		output: "plume-ask",
		details: { kind: "question", answer: "plume-ask", skipped: false },
	});
	expect((await ask({ question: "选哪个", options: ["A", "B"], allowCustomInput: false }, { answer: "C" })).output).toContain(UNANSWERED);
	expect((await ask({ question: "叫什么名字", options: [] }, { answer: "   " })).output).toContain(UNANSWERED);
	// 不是回答形状的数据。
	expect((await ask({ question: "叫什么名字", options: [] }, "推" as unknown as QuestionReply)).output).toContain(UNANSWERED);
});

it("取消、到时没人答、停下这一轮，都是没有答案，结果叮嘱模型说出来", async () => {
	const { ask } = await setup();
	for (const reason of ["declined", "expired", "stopped"] as const) {
		const result = await ask({ question: "推不推", options: ["推", "不推"] }, { answered: false, reason });
		expect(result, reason).toMatchObject({ isError: true });
		expect(result.output).toContain(UNANSWERED);
		expect(result.output).toContain("say so plainly in your reply");
	}
});
