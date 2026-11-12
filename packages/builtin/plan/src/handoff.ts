/**
 * 「在新会话里执行」时新会话的第一条消息。
 *
 * 为什么另开会话而不是原地执行：几轮讨论和审核留在实施的上下文里，旧版计划、打回意见、为核实而读的代码都跟着实施走到底。
 * 新会话的第一条消息只有标题、概要、计划文件和两条规矩；计划全文在文件里，压缩以后路径还在，随时能重读。
 *
 * 只说计划文件里没有的：要做的是什么（概要）、以哪份为准、能做到哪一步、拿不准时问谁。授权范围写死而不是让模型临场写：
 * 计划批的是改代码和验证，提交、推送这类外部可见的动作从来不在批准里。「能从代码查到的自己查」是为原会话省钱：
 * 不加的话每碰到一点不确定就问一次，每问一次那边就多跑一轮。
 *
 * 拿不准的意图和取舍只说「原会话里有讨论，有办法就去那里找，否则问人」，不点名怎么读、怎么问：那是别的插件的工具
 * （内置插件不认识市场插件）。新会话记着 `spawnedFrom`，提供读会话、问会话的插件自己按它告诉模型怎么找原会话。
 */

import type { MESSAGES } from "./messages.ts";
import { planSummary, planTitle } from "./plan.ts";

export function handoffPrompt(text: (typeof MESSAGES)["zh-CN"], plan: { plan: string; file: string }): string {
	const summary = planSummary(plan.plan);
	return [
		text.handoffTitle(planTitle(plan.plan)),
		...(summary ? [summary] : []),
		[text.handoffFile(plan.file), text.handoffScope, text.handoffQuestions].join("\n"),
	].join("\n\n");
}
