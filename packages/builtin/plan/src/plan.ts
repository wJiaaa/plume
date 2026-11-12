/**
 * 两个入口共用的、不碰 Node 的那一半：计划长什么样、会话历史里眼下是哪一份。
 *
 * 计划不另存：交计划的调用和它的结果本来就在会话里，面板和卡片都从消息里读，重启、换会话回来计划还在。
 */

import type { Message } from "@plume/contract";

export const SUBMIT_PLAN = "submit_plan";

/**
 * `submit_plan` 结果的 details：人批没批这份计划。批准时附上的评论是执行时的注意事项（`notes`），
 * 打回时写的修改意见是 `feedback`。
 */
export interface PlanDetails {
	kind: "plan";
	plan: string;
	approved: boolean;
	notes?: string;
	feedback?: string;
	/** 批准的时刻，面板按它分出批准过的每一份。 */
	approvedAt?: number;
	/** 批准时存下的计划文件（会话临时目录里的 `plans/plan-<批准时刻>.md`，带着注意事项）；没写成就没有。 */
	file?: string;
	/** 人选了在新会话里执行：这个会话就此停下，实施在新会话里。 */
	handoff?: boolean;
	/** 交给的新会话用的模型（`SessionModel.id`）；没挑是默认模型。 */
	model?: string;
}

function isPlanDetails(value: unknown): value is PlanDetails {
	const details = value as Partial<PlanDetails> | undefined;
	return details?.kind === "plan" && typeof details.plan === "string" && typeof details.approved === "boolean";
}

/** 计划在面板、交给模型的结果和压缩摘要里长的样子：带着批准时附上的注意事项。 */
// i18n-exempt：小标题跟着计划一起存进会话、交给模型，不随界面语言变。
export function renderPlan(plan: string, notes?: string): string {
	return notes ? `${plan}\n\n## 执行时注意\n${notes}` : plan;
}

/**
 * 审批卡交给逻辑入口的那几句话，连同回答一起交给 `submit_plan`：接受时是 `note`（注意事项），
 * 拒绝时有 `feedback` 就是「修改」——模型照着改完再交，这一轮不停。
 */
export interface PlanReply {
	note?: string;
	feedback?: string;
	/** 接受时选了「在新会话里执行」；`model` 是卡上给新会话挑的模型，没挑就是默认模型。 */
	handoff?: { model?: string };
}

/** 引文太长时只带开头：模型据此认出是哪一段就够了，整段搬过去只是重复它自己写的计划。 */
const QUOTE_LIMIT = 200;

/**
 * 评论排成一段话。引文写成引用块，后面空一行再写评论（紧跟着写会被 Markdown 并进引文）；`said` 是人在卡上另外写的那句，放最前面。
 */
export function planFeedback(comments: readonly { quote: string; text: string }[], said = ""): string {
	const parts = comments.map(({ quote, text }) => {
		const flat = quote.replace(/\s+/g, " ").trim();
		const cut = [...flat].length > QUOTE_LIMIT ? `${[...flat].slice(0, QUOTE_LIMIT).join("")}…` : flat;
		return `> ${cut}\n\n${text.trim()}`;
	});
	return [said.trim(), ...parts].filter(Boolean).join("\n\n");
}

/** 计划的标题：正文第一个标题，没有就取第一行。 */
export function planTitle(plan: string): string {
	const lines = plan
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const heading = lines.find((line) => line.startsWith("#"));
	return (heading ?? lines[0] ?? "").replace(/^#+\s*/, "");
}

/** 转录里那一行「提交计划 标题」点名的对象：参数里计划的标题，截到 40 个字（整份在面板里）；参数还没成形时没有。 */
export function planSubject(args: Record<string, unknown>): string | undefined {
	const title = typeof args.plan === "string" ? [...planTitle(args.plan)].slice(0, 40).join("") : "";
	return title || undefined;
}

// i18n-exempt：认计划里概要那一节的标题，不显示。
const SUMMARY_HEADINGS = new Set(["概要", "摘要", "概述", "summary", "overview", "tl;dr"]);
const SUMMARY_MAX = 300;

/**
 * 计划的概要：叫「概要」「摘要」「Summary」的那一节的第一段，没有这一节就取标题下面的第一段。
 * 交给新会话时放在计划文件路径前面，让它先知道要做的是什么。只取一段、截到三百字：全文在文件里，
 * 这里再抄一份就是两处可能对不上的计划。
 */
export function planSummary(plan: string): string {
	const lines = plan.split("\n").map((line) => line.trim());
	const isHeading = (line: string) => line.startsWith("#");
	// i18n-exempt：标题末尾的中英文冒号，认标题用，不显示。
	const named = lines.findIndex(
		(line) =>
			isHeading(line) &&
			SUMMARY_HEADINGS.has(
				line
					.replace(/^#+\s*/, "")
					.replace(/[:：]\s*$/, "")
					.toLowerCase(),
			),
	);
	let at = named >= 0 ? named + 1 : lines.findIndex(isHeading) + 1;
	while (at < lines.length && !lines[at]) at++;
	const paragraph: string[] = [];
	for (; at < lines.length && lines[at] && !isHeading(lines[at]!); at++) paragraph.push(lines[at]!);
	const text = paragraph.join(" ");
	return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
}

export interface CurrentPlan {
	/** 带着注意事项的那份（`renderPlan`）。 */
	plan: string;
	/** `open`：还没有结果，在等审批，或者那一轮断在了半路。 */
	status: "approved" | "declined" | "open";
}

/**
 * 会话里眼下的那份计划：最后一次交上来的，批没批都算——人要看的正是自己刚打回的那份，模型改完再交，新的那份排到最后。
 * 被工具当场退回的那次（参数不成形、计划模式已关）人没见过，不算一份计划。
 */
export function currentPlan(messages: readonly Message[]): CurrentPlan | null {
	const results = new Map<string, CurrentPlan | "error">();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "toolResult") {
			if (message.toolName !== SUBMIT_PLAN) continue;
			const details = message.details;
			results.set(
				message.toolCallId,
				message.isError || !isPlanDetails(details)
					? "error"
					: { plan: renderPlan(details.plan, details.notes), status: details.approved ? "approved" : "declined" },
			);
		} else if (message?.role === "assistant") {
			for (let at = message.content.length - 1; at >= 0; at--) {
				const block = message.content[at];
				if (block?.type !== "toolCall" || block.name !== SUBMIT_PLAN) continue;
				const result = results.get(block.id);
				const plan = typeof block.arguments.plan === "string" ? block.arguments.plan.trim() : "";
				if (result === "error" || !plan) continue;
				return result ?? { plan, status: "open" };
			}
		}
	}
	return null;
}

export interface ApprovedPlan {
	/** 交这份计划的那次调用。 */
	toolCallId: string;
	plan: string;
	notes?: string;
	approvedAt: number;
	/** 交给了新会话执行。 */
	handoff?: boolean;
}

/** 会话里批准过的每一份计划，按批准先后；打回的、还在等的不算。 */
export function approvedPlans(messages: readonly Message[]): ApprovedPlan[] {
	const plans: ApprovedPlan[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== SUBMIT_PLAN || message.isError) continue;
		const details = message.details;
		if (!isPlanDetails(details) || !details.approved || details.approvedAt === undefined) continue;
		plans.push({
			toolCallId: message.toolCallId,
			plan: details.plan,
			...(details.notes ? { notes: details.notes } : {}),
			approvedAt: details.approvedAt,
			...(details.handoff ? { handoff: true } : {}),
		});
	}
	return plans;
}
