/**
 * `ask_user`：参数的校验、问人时交出去的卡、卡上交回的回答怎么核、怎么变成给模型的结果。
 * 人在卡上怎么答由 `run.ask` 的假实现定：它拿到卡片的 `detail`，按问题里的编号经接口交回答，再给出决定。
 */

import { expect, it } from "vitest";
import type { ApprovalContent, ApprovalDecision, PluginContext, ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";
import type { AskUserApi } from "../src/api.ts";
import plugin from "../src/index.ts";
import { ASK_USER, type Question, type QuestionReply } from "../src/question.ts";

async function setup() {
	let tool: ToolDefinition | undefined;
	let api: AskUserApi | undefined;
	const ctx = {
		name: "plume.ask-user",
		locale: () => "zh-CN",
		tools: { register: (definition: ToolDefinition) => void (tool = definition) },
		serve: (served: AskUserApi) => void (api = served),
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	if (!tool || !api) throw new Error("插件没注册工具或没开接口");
	const served = api;
	const asked: ApprovalContent[] = [];
	/** 调一次 `ask_user`；`reply` 是人在卡上交的回答（不交就是 undefined），`decision` 是卡片随后的 `respond`。 */
	const ask = async (
		args: Record<string, unknown>,
		reply?: QuestionReply,
		decision: ApprovalDecision = reply === undefined ? "reject" : "once",
	): Promise<{ result: ToolOutput; refused?: unknown }> => {
		let refused: unknown;
		const run = {
			sessionId: "s",
			cwd: "/w",
			signal: new AbortController().signal,
			progress() {},
			async ask(content: ApprovalContent) {
				asked.push(content);
				const question = JSON.parse(content.detail) as Question;
				if (reply !== undefined) await served.answer(question.id, reply).catch((error: unknown) => void (refused = error));
				return refused === undefined ? decision : "reject";
			},
			permissionMode: async () => "full",
			tools: () => [],
			calls: [],
		} as unknown as ToolRun;
		const result = await tool!.execute(args, run);
		return { result, ...(refused === undefined ? {} : { refused }) };
	};
	return { ask, asked, api: served };
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
	for (const [args, message] of cases) {
		const { result } = await ask(args);
		expect(result, JSON.stringify(args)).toEqual({ output: message, isError: true });
	}
	expect(asked).toEqual([]);
});

it("问人的卡只能由人答，带着整理好的问题；选一项就是答案", async () => {
	const { ask, asked } = await setup();
	const { result } = await ask(
		{ question: "  先备份吗？ ", options: [" 备份 ", { label: "不备份", description: "直接改", recommended: true }] },
		{ answer: " 不备份 " },
	);
	expect(asked[0]).toMatchObject({ kind: ASK_USER, title: "需要你的意见", userOnly: true });
	expect(JSON.parse(asked[0]!.detail)).toMatchObject({
		question: "先备份吗？",
		options: ["备份", { label: "不备份", description: "直接改", recommended: true }],
		selectionMode: "single",
		allowCustomInput: true,
		allowSkip: true,
	});
	expect(result).toEqual({ output: "不备份", details: { kind: "question", answer: "不备份", skipped: false } });
});

it("跳过：有默认项时采用它，没有时说清楚没给答案；不许跳过时不收", async () => {
	const { ask } = await setup();
	const withDefault = await ask({ question: "用哪个库", options: ["A", "B"], defaultOptionIndex: 1 }, { skip: true });
	expect(withDefault.result).toEqual({
		output: "The user skipped and accepted the explicit default: B",
		details: { kind: "question", answer: "B", skipped: true },
	});
	const bare = await ask({ question: "用哪个库", options: ["A", { label: "B", recommended: true }] }, { skip: true });
	expect(bare.result.output).toContain("The user skipped this question. No answer or permission was granted.");
	expect(bare.result.details).toEqual({ kind: "question", skipped: true });
	expect(bare.result.isError).toBeUndefined();
	const locked = await ask({ question: "用哪个库", options: ["A"], allowSkip: false }, { skip: true });
	expect((locked.refused as Error).message).toBe("回答和问题对不上");
	expect(locked.result).toMatchObject({ isError: true });
	expect(locked.result.output).toContain(UNANSWERED);
});

it("多选交一组、去重去空白，给模型的是 JSON 数组；单选交一组、多选里有重复的都不收", async () => {
	const { ask } = await setup();
	const many = await ask({ question: "要哪些", options: ["A", "B", "C"], selectionMode: "multi" }, { answer: ["A", " C"] });
	expect(many.result).toEqual({ output: '["A","C"]', details: { kind: "question", answer: ["A", "C"], skipped: false } });
	const single = await ask({ question: "要哪个", options: ["A", "B"] }, { answer: ["A", "B"] });
	expect(single.refused).toBeInstanceOf(Error);
	const twice = await ask({ question: "要哪些", options: ["A", "B"], selectionMode: "multi" }, { answer: ["A", "A "] });
	expect(twice.refused).toBeInstanceOf(Error);
	const empty = await ask({ question: "要哪些", options: ["A"], selectionMode: "multi" }, { answer: [] });
	expect(empty.refused).toBeInstanceOf(Error);
});

it("自己写的回答默认收下；不许自填时只能选选项里的", async () => {
	const { ask } = await setup();
	const free = await ask({ question: "叫什么名字", options: [] }, { answer: "  plume-ask " });
	expect(free.result).toEqual({ output: "plume-ask", details: { kind: "question", answer: "plume-ask", skipped: false } });
	const strict = await ask({ question: "选哪个", options: ["A", "B"], allowCustomInput: false }, { answer: "C" });
	expect((strict.refused as Error).message).toBe("回答和问题对不上");
	const blank = await ask({ question: "叫什么名字", options: [] }, { answer: "   " });
	expect(blank.refused).toBeInstanceOf(Error);
});

it("取消、到时没人答、卡上没交回答就放行的，都是没有答案；问完的问题不再收回答", async () => {
	const { ask, api } = await setup();
	// 本体到时按拒绝收场，和人点取消一样到这里都是 reject。
	const expired = await ask({ question: "推不推", options: ["推", "不推"] });
	expect(expired.result).toMatchObject({ isError: true });
	expect(expired.result.output).toContain(UNANSWERED);
	expect(expired.result.output).toContain("say so plainly in your reply");
	// 产品的通用卡（插件的卡画不出来时）只有允许、拒绝：允许了也没有答案。
	const blind = await ask({ question: "推不推", options: ["推", "不推"] }, undefined, "once");
	expect(blind.result.output).toContain(UNANSWERED);
	// 交了回答却被拒（停下了这一轮）的也不算。
	const stopped = await ask({ question: "推不推", options: ["推", "不推"] }, { answer: "推" }, "reject");
	expect(stopped.result.output).toContain(UNANSWERED);
	await expect(api.answer("不存在的", { answer: "推" })).rejects.toThrow("这个问题已经不等回答了");
});
