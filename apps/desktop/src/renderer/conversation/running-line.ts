/**
 * 运行行该不该露面、怎么读数：这一轮跑了多久，末尾在流的正文是不是该让它让开。
 */

import type { Message } from "@plume/contract";

/** 跑了多久：`42s`、`3m 05s`、`1h 12m`。 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** 一个 token 数一眼读出来：812、12.3k、4.1M。 */
export function formatTokens(count: number): string {
	if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

/**
 * 末尾正在流的这段正文像不像结论。像，运行行就让开：挂在结论底下，字每折一行它就往下跳一行。
 *
 * 流到一半没有确定的信号，所以看长相：开场白多半几十个字、不换行；结论多半写到第一段末尾就出现换行或超过 150 字。
 * 判错一次只是运行行早一点、晚一点让开，工具调用一到它就回来。
 */
const ANSWER_CHARS = 150;

export function looksLikeAnswer(messages: readonly Message[]): boolean {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return false;
	const block = last.content[last.content.length - 1];
	// 标了 commentary 的一定是开场白，这一个信号是确定的。
	if (block?.type !== "text" || block.phase === "commentary") return false;
	const text = block.text.trim();
	return text.includes("\n") || text.length > ANSWER_CHARS;
}

/**
 * 末尾在流的是这一轮第一次调工具之前的话：不管它是结论还是开场白，运行行都让开。不让的话第一个字一来它就被推下去一行。
 * 只管第一次调工具之前：之后每批调用之间的话都让的话，它就围着每一批调用出没。
 */
export function leadsTheTurn(messages: readonly Message[]): boolean {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return false;
	const block = last.content[last.content.length - 1];
	if (block?.type !== "text" || !block.text.trim()) return false;
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at]!;
		if (message.role === "user" && !message.synthetic) return true;
		if (message.role === "assistant" && message.content.some((part) => part.type === "toolCall")) return false;
	}
	return true;
}

/** 最后一条是一段正常写完的回答：以正文收尾、停在 `stop` 上。 */
export function answeredCleanly(messages: readonly Message[]): boolean {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "stop") return false;
	const block = last.content[last.content.length - 1];
	return block?.type === "text" && block.text.trim().length > 0;
}

/**
 * 末尾那段正文此刻的长度：运行行在它一阵子不长了以后回来，见 `RunningRow`。正文写完了（`ended`）、在等这条回复收尾时不算：
 * 有的网关在最后一个字和收尾之间空一两秒，按停住算，运行行就在写完的回答底下冒出来一下又被收走。
 */
export function proseLength(messages: readonly Message[]): number | undefined {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return undefined;
	const block = last.content[last.content.length - 1];
	return block?.type === "text" && !block.ended ? block.text.length : undefined;
}
