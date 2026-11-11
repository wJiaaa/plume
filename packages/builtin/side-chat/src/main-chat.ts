/**
 * 侧边聊天看主会话的两条路：每一问附上主会话上次之后的新内容（`mainChatContext`），更早的、被截掉的经工具
 * `read_main_chat` 自己翻（`readHistory`）。
 *
 * 只附增量，写进侧边聊天的记录：每次附一份完整快照的话，快照一份份叠上去；只在请求时附上不写进记录的话，前缀每次都不一样，
 * 缓存一次也命中不了。增量写进记录、只说新的，前缀稳定，同一段话也不会出现两次。
 */

import type { Message } from "@plume/contract";

/** 每一问附上多少字的主会话；更多的经 `read_main_chat` 翻。 */
const MAIN_CHAT_BUDGET = 12_000;

/** 上一问读到主会话的哪里：读过几条，最后一条的时刻（同一个位置换了别的消息时认得出来）。 */
export interface Mark {
	seen: number;
	lastAt: number;
}

/**
 * 每一问读到哪里，按问的时候侧边聊天已有几条消息（`at`）记一份。编辑重问截掉这一问和之后的，下一问的 `at` 落回原处，
 * 用的就是这一问之前那份，截掉的那几问附过的主会话进展这次照样附上；只记最新一份的话，重问会以为已经看过。
 */
export type MarkLog = readonly { at: number; mark: Mark }[];

/** 侧边聊天有 `at` 条消息时，上一问读到了哪里：记在它前面的最后一份。 */
export function markBefore(log: MarkLog, at: number): Mark | undefined {
	return log.findLast((entry) => entry.at < at)?.mark;
}

/** 这一问读到了 `mark`：截掉的那几问（`at` 不在它前面的）一起丢掉。 */
export function withMark(log: MarkLog, at: number, mark: Mark): MarkLog {
	return [...log.filter((entry) => entry.at < at), { at, mark }];
}

// i18n-exempt：这个文件里的字都是发给模型的。

/** 一条消息原样写成文字，不丢东西；图片只说那里有一张。 */
function messageText(message: Message): string {
	const who =
		message.role === "toolResult" ? `tool result ${message.toolName}` : message.role === "assistant" ? "assistant" : message.synthetic ? "system note" : "user";
	const blocks = message.content.map((block) => {
		switch (block.type) {
			case "text":
				return block.text;
			case "image":
				return "[image]";
			case "thinking":
				return block.thinking ? `[thinking]\n${block.thinking}` : "[no visible thinking]";
			case "toolCall":
				return `[tool call ${block.name}]\n${JSON.stringify(block.arguments)}`;
			default:
				return "";
		}
	});
	return `[${who}]\n${blocks.join("\n")}`;
}

/** 主会话从第 `from` 条起，放不下时留最新的；序号是主会话自己的，之后 `read_main_chat` 从漏掉的地方接着读。 */
export function mainChatExcerpt(messages: readonly Message[], from: number, budget = MAIN_CHAT_BUDGET): string {
	const parts: string[] = [];
	let remaining = budget;
	let start = messages.length;
	let clipped = false;
	while (start > from && remaining > 0) {
		start--;
		const text = `message ${start}\n${messageText(messages[start] as Message)}`;
		parts.unshift(text.slice(-remaining));
		clipped ||= text.length > remaining;
		remaining -= text.length;
	}
	const partial = start > from || clipped;
	return (
		(partial
			? `Only the most recent part is shown (from around message ${start}); use read_main_chat for messages ${from}–${start} and anything cut off.\n\n`
			: "") + parts.join("\n\n")
	);
}

/** 这一问附上的主会话进展，和读到了哪里。读过的那一段还是原样就接着读；被删、被换过就从头读。 */
export function mainChatContext(
	messages: readonly Message[],
	running: boolean,
	mark: Mark | undefined,
	budget = MAIN_CHAT_BUDGET,
): { text: string; mark: Mark } {
	const intact = mark !== undefined && mark.seen <= messages.length && (mark.seen === 0 || messages[mark.seen - 1]?.timestamp === mark.lastAt);
	const from = intact ? mark.seen : 0;
	const lines = [
		`The main session is ${running ? "running" : "idle"} and has ${messages.length} messages (indexes from 0).`,
		"",
		from === messages.length
			? "Nothing new in the main chat since your previous question."
			: mark && !intact
				? `The main chat was rewound or rewritten since your previous question. Current record:\n\n${mainChatExcerpt(messages, 0, budget)}`
				: `${mark ? "New in the main chat since your previous question" : "The main chat so far"}:\n\n${mainChatExcerpt(messages, from, budget)}`,
	];
	return { text: `<main-session>\n${lines.join("\n")}\n</main-session>`, mark: { seen: messages.length, lastAt: messages.at(-1)?.timestamp ?? 0 } };
}

export interface HistoryArgs {
	start?: number;
	offset?: number;
	limit?: number;
	maxChars?: number;
	query?: string;
}

export const HISTORY_PARAMETERS = {
	type: "object",
	properties: {
		start: { type: "integer", minimum: 0 },
		offset: { type: "integer", minimum: 0 },
		limit: { type: "integer", minimum: 1, maximum: 30 },
		maxChars: { type: "integer", minimum: 1, maximum: MAIN_CHAT_BUDGET },
		query: { type: "string" },
	},
	additionalProperties: false,
};

/** 参数不对时给模型的话；对的返回 undefined。 */
export function invalidHistoryArgs(args: Record<string, unknown>): string | undefined {
	for (const key of ["start", "offset", "limit", "maxChars"] as const) {
		const value = args[key];
		if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < (key === "limit" || key === "maxChars" ? 1 : 0))) {
			return `${key} must be a non-negative integer (limit and maxChars at least 1).`;
		}
	}
	if (args.query !== undefined && typeof args.query !== "string") return "query must be a string.";
	return undefined;
}

/**
 * 主会话此刻的一页：从第 `start` 条起，或者只看含 `query` 的，最多 `charLimit` 字；`next` 说从哪接着读。
 * 读的是调用这一刻的原文：侧边聊天最常被问的就是「它现在在干什么」。
 */
export function readHistory(sessionId: string, messages: readonly Message[], args: HistoryArgs, charLimit = MAIN_CHAT_BUDGET): string {
	const start = args.start ?? 0;
	const query = args.query?.trim().toLowerCase();
	const entries: { index: number; role: Message["role"]; offset: number; totalChars: number; text: string }[] = [];
	let remaining = Math.min(args.maxChars ?? charLimit, charLimit);
	let next: { start: number; offset?: number; query?: string } | null = null;
	for (let index = start; index < messages.length; index++) {
		const text = messageText(messages[index] as Message);
		const match = query ? text.toLowerCase().indexOf(query) : 0;
		if (match < 0) continue;
		const offset = index === start && args.offset !== undefined ? args.offset : Math.max(0, match - 160);
		const excerpt = text.slice(offset, offset + remaining);
		entries.push({ index, role: (messages[index] as Message).role, offset, totalChars: text.length, text: excerpt });
		remaining -= excerpt.length;
		if (offset + excerpt.length < text.length) {
			next = { start: index, offset: offset + excerpt.length, ...(query ? { query } : {}) };
			break;
		}
		if (remaining === 0 || entries.length >= Math.min(args.limit ?? 10, 30)) {
			if (index + 1 < messages.length) next = { start: index + 1, ...(query ? { query } : {}) };
			break;
		}
	}
	return JSON.stringify({ sessionId, totalMessages: messages.length, messages: entries, next });
}
