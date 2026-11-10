/**
 * 转录左边那条问题导航、两句话之间的时间线：从消息里认出人问了哪几句、哪两句隔得久。纯整理，不碰界面，
 * 要说的字（「图片消息」「今天」）由调用方给。
 */

import type { Message } from "@plume/contract";
import { spokenText } from "./sent-attachments.ts";

/** 人问的一句：`index` 是它在消息列表里的位置，同样的两句话、只带了图的一句也各是各的落点。 */
export interface Question {
	index: number;
	text: string;
	/** 跟在它后面的回答开头一段，悬停预览用。 */
	answer: string;
}

/** 消息是一段没人再校验过的数据，缺了 `role` 的整条不认。 */
const readable = (message: Message | undefined): message is Message => Boolean(message && typeof message.role === "string");

/** 人问过的每一句。只带了附件、一个字没打的，用 `imageLabel` 代替。 */
export function questionsIn(messages: readonly Message[], imageLabel: string): Question[] {
	const questions: Question[] = [];
	for (const [index, message] of messages.entries()) {
		if (!readable(message)) continue;
		if (message.role === "assistant") {
			const question = questions.at(-1);
			const answer = message.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n\n")
				.trim();
			if (question && answer) question.answer = answer.slice(0, 600);
			continue;
		}
		// 界面替人说的「继续」不是一个问题。
		if (message.role !== "user" || message.synthetic) continue;
		const text = spokenText(message).trim();
		questions.push({ index, text: text || imageLabel, answer: "" });
	}
	return questions;
}

/** 导航上一次最多排出几道刻痕：多了就是一把挤在一起的梳子，指不准哪一道。 */
const QUESTION_LIMIT = 15;

/** 围着当前那一问的一段，长度固定；两头到了就贴着头尾，短会话不拉长。 */
export function questionWindow(total: number, position: number): { start: number; end: number } {
	const size = Math.min(QUESTION_LIMIT, total);
	const start = Math.max(0, Math.min(total - size, position - Math.floor(size / 2)));
	return { start, end: start + size };
}

/** 隔了这么久再说话，中间画一条时间：回来接着聊的人要知道上面那段是什么时候的事。 */
const PAUSE_MS = 30 * 60_000;

/** 哪几句人说的话上面要画时间：会话第一句、和上一条隔了半小时以上、或者跨了天。 */
export function timeSeparators(messages: readonly Message[]): Set<number> {
	const result = new Set<number>();
	let previous: number | undefined;
	for (const [index, message] of messages.entries()) {
		if (!readable(message)) continue;
		if (message.role === "user" && !message.synthetic) {
			if (
				previous === undefined ||
				message.timestamp - previous >= PAUSE_MS ||
				new Date(previous).toDateString() !== new Date(message.timestamp).toDateString()
			)
				result.add(index);
		}
		// 界面替人说的话不算人回来过。
		if (message.role === "user" && message.synthetic) continue;
		previous = message.timestamp;
	}
	return result;
}

/** 时间线上那一句：「今天 14:28」「昨天 9:05」「3月2日 9:05」，不是今年的带上年份。 */
export function conversationTime(timestamp: number, now: number, locale: string, labels: { today: string; yesterday: string }): string {
	const date = new Date(timestamp);
	const today = new Date(now);
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const day =
		date.toDateString() === today.toDateString()
			? labels.today
			: date.toDateString() === yesterday.toDateString()
				? labels.yesterday
				: date.toLocaleDateString(locale, { month: "long", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
	// 这一行一直写 9:05，不写 09:05：用 `numeric`，不跟消息底下那行的小时写法。
	return `${day} ${date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}`;
}
