/**
 * 内置插件 plume.ask-user 的逻辑入口：`ask_user` 工具，让模型停下来问人一个它自己答不了的问题（澄清、拿主意）。
 *
 * 问题经这次调用的 `run.ask` 弹成一张审批卡（带 `userOnly`：完全访问免的是操作审批，免不了问题的答案），界面入口按工具名
 * 认出来画成提问卡（`ui.tsx`）。人在卡上的回答先经 `answer` 交到这里、对着问题再核一遍，卡片再 `respond`；`run.ask`
 * 返回后取走。卡上没交回答就收场的（取消、停下这一轮、到时没人答），都是没有答案。
 *
 * 跳过不是同意：没给默认项时，模型只能接着做不依赖这个答案的事。
 */

import { randomUUID } from "node:crypto";
import type { Plugin, ToolOutput } from "@plume/contract";
import type { AskUserApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { ASK_USER, type CheckedReply, checkReply, type Question, readArgs } from "./question.ts";

// i18n-exempt：工具描述、参数说明和结果都是交给模型的。
const DESCRIPTION =
	"Ask the user for a clarification or a decision. Options may carry a description and a recommended badge. The user picks, writes an answer, or skips. Skipping is not consent: without an explicit default, continue only work that does not depend on the answer. Full access grants permissions, not answers.";

// i18n-exempt：交给模型的工具结果。
const RESULTS = {
	skipped: "The user skipped this question. No answer or permission was granted. Continue only work that does not depend on this answer.",
	/*
	 * 没人答时要它在回复里说出来：到这时卡片已经收走，一轮以整齐的总结收尾，看着和从没卡过一样，
	 * 人回来只看到做到一半的活，不知道为什么。只有这里知道问题没得到回答，所以叮嘱写在结果里，不写在提示词里。
	 */
	unanswered:
		"The question was declined, or it expired with nobody at the keyboard. No answer was received. Whatever you do next, say so plainly in your reply — that you asked, that no answer came, and what you did instead — because the question is no longer on screen and nothing else will mention it.",
	defaulted: (answer: string) => `The user skipped and accepted the explicit default: ${answer}`,
};

/** 答案给模型时：一个就是它本身，多个写成 JSON 数组，免得选项里的逗号读成分隔。 */
const spoken = (answer: string | string[]) => (Array.isArray(answer) ? JSON.stringify(answer) : answer);

/** 人怎么答的变成交给模型的结果。`details` 给工具卡片和以后读会话的插件。 */
function answerOutput(reply: CheckedReply | undefined): ToolOutput {
	if (!reply) return { output: RESULTS.unanswered, isError: true };
	if (!("answer" in reply)) return { output: RESULTS.skipped, details: { kind: "question", skipped: true } };
	const skipped = reply.skipped === true;
	return {
		output: skipped ? RESULTS.defaulted(spoken(reply.answer)) : spoken(reply.answer),
		details: { kind: "question", answer: reply.answer, skipped },
	};
}

export default {
	name: "plume.ask-user",
	apply(ctx) {
		/** 在等回答的问题，和卡片交来的回答。 */
		const pending = new Map<string, { question: Question; reply?: CheckedReply }>();

		ctx.tools.register({
			name: ASK_USER,
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					question: { type: "string", description: "The question and the context needed to answer it." },
					options: {
						type: "array",
						items: {
							anyOf: [
								{ type: "string" },
								{
									type: "object",
									properties: { label: { type: "string" }, description: { type: "string" }, recommended: { type: "boolean" } },
									required: ["label"],
									additionalProperties: false,
								},
							],
						},
					},
					selectionMode: { type: "string", enum: ["single", "multi"] },
					allowCustomInput: { type: "boolean" },
					allowSkip: { type: "boolean", description: "Allow an explicit skipped response. Defaults to true." },
					defaultOptionIndex: {
						type: "integer",
						minimum: 0,
						description: "An explicit default used only when the user chooses Skip; a recommendation alone is not a default.",
					},
				},
				required: ["question", "options"],
				additionalProperties: false,
			},
			async execute(args, run) {
				const question = readArgs(args, randomUUID());
				if (typeof question === "string") return { output: question, isError: true };
				pending.set(question.id, { question });
				try {
					// `userOnly`：问的是人的决定，不是权限。到时没人答，本体按拒绝收场，这里就没有回答。
					const decision = await run.ask({ kind: ASK_USER, title: MESSAGES[ctx.locale()].title, detail: JSON.stringify(question), userOnly: true });
					return answerOutput(decision === "reject" ? undefined : pending.get(question.id)?.reply);
				} finally {
					pending.delete(question.id);
				}
			},
		});

		ctx.serve({
			async answer(id, reply) {
				const entry = typeof id === "string" ? pending.get(id) : undefined;
				if (!entry) throw new Error(MESSAGES[ctx.locale()].gone);
				const checked = checkReply(entry.question, reply);
				if (!checked) throw new Error(MESSAGES[ctx.locale()].invalid);
				entry.reply = checked;
			},
		} satisfies AskUserApi);
	},
} satisfies Plugin;
