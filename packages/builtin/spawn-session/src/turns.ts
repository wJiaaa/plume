/** 从会话记录里读：这一轮是谁引起的、最后那段回复、这一轮提了几张建议卡。 */

import type { Message } from "@plume/contract";
import { isSuggestion, SPAWN_SESSION } from "./suggestion.ts";

/**
 * 一条用户消息是谁说的：人（输入框里打的，侧边聊天交过来的也是人交代的）、别的会话寄来的信、或者运行时递来的
 * （后台结果、唤醒、代管插件转来的话）。
 */
type Speaker = { by: "human" } | { by: "peer"; from: string } | { by: "runtime" };

function speaker(message: Extract<Message, { role: "user" }>): Speaker {
	const letter = message.peer?.[0];
	if (letter) return { by: "peer", from: letter.sessionId };
	if (message.synthetic || message.delivery || message.origin === "plugin" || message.origin === "parent") return { by: "runtime" };
	return { by: "human" };
}

/** 最近那条用户消息是谁说的：一轮结束时，它就是引起这一轮（或者中途插进来）的那句话。 */
export function lastSpeaker(messages: readonly Message[]): Speaker {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user") return speaker(message);
	}
	return { by: "runtime" };
}

/**
 * 这一轮背后是不是人：越过运行时递来的几条（钩子补的上下文、自己派出去的后台事的结果），往回找到最近一句人或者信说的话。
 *
 * 开出来的会话交回的汇报（带 `delivery.sessionId`）要看它在哪：紧跟在上一段回复后面的，是它在上一轮收尾以后叫起了新的一轮，
 * 和信一样，人未必在；跟在人那句后面（人开口时读进攒着的）、跟在工具结果后面（一轮中途读到的）的，只是这一轮里多读了一份，接着往回找。
 */
export function humanTurn(messages: readonly Message[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "user") continue;
		if (message.delivery?.some((report) => report.sessionId !== undefined) && messages[index - 1]?.role === "assistant") return false;
		const who = speaker(message);
		if (who.by !== "runtime") return who.by === "human";
	}
	return false;
}

/** 最近一句人说的话之后提的建议卡，按调用 id。 */
export function suggestionsThisTurn(messages: readonly Message[]): Set<string> {
	const ids = new Set<string>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user" && speaker(message).by !== "runtime") break;
		if (message.role === "toolResult" && message.toolName === SPAWN_SESSION && !message.isError && isSuggestion(message.details)) ids.add(message.toolCallId);
	}
	return ids;
}

/** 最后一段有字的回复。 */
export function lastReply(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		const text = message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}

/** 按码位取前 `max` 个字，截了就补省略号。 */
export function excerpt(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}
