/**
 * 上下文用量那一格的数：从会话的消息里读出上一次请求把上下文窗口占了多少。
 * 都是纯函数，`ContextMeter` 只管画。
 */

import type { CompactionRun, Message } from "@plume/contract";

/** 上一次请求的上下文有多满。`tight` 是到了 80%：压缩在窗口真满之前就开始，提醒要早一些。 */
export interface ContextReading {
	used: number;
	limit: number;
	percent: number;
	tight: boolean;
}

/**
 * 最近一条写完的回复背后那次请求，按服务商报的数，一共占了多少上下文：输入 + 缓存读取 + 缓存写入 + 输出。
 *
 * 前三项是整次请求发出去的全部（系统提示词、工具表都在里面），输出下一轮也要原样带回去，所以一起算。
 * 取 `lastAttemptUsage`：`usage` 还记着重试时丢掉的那几次的账，它们并不共用这一个窗口。
 * 回复报了 0（中途断了、出错了）就往前找上一条。一条都没有时是 null。
 * `from` 之前的回复不算（见 `rewrittenFrom`）：它们量的是压缩前那份历史，压完还拿它充数，读数就停在压缩前那么满。
 */
export function contextUsed(messages: readonly Message[], from = 0): number | null {
	for (let i = messages.length - 1; i >= from; i--) {
		const message = messages[i];
		if (message?.role !== "assistant" || message.stopReason === "pending") continue;
		const usage = message.lastAttemptUsage ?? message.usage;
		const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
		if (total > 0) return total;
	}
	return null;
}

/**
 * 最近一次改写了发给模型的历史的压缩（换成摘要）落在转录的第几条：`CompactionRun.at`。这之前的回复量的是改写前的
 * 历史，和 agent 进程算有多满时的 `staleAt` 是同一条线。没有时是 0。
 */
export function rewrittenFrom(runs: readonly CompactionRun[]): number {
	return runs.reduce((from, run) => (run.code === "done" ? Math.max(from, run.at) : from), 0);
}

export function contextReading(messages: readonly Message[], limit: number, from = 0): ContextReading | null {
	if (!(limit > 0)) return null;
	const used = contextUsed(messages, from);
	return used === null ? null : readingOf(used, limit);
}

/** 压完还没发下一次请求时，`used` 是 agent 进程按压缩后的历史估的（`ContextBreakdown.used`）。 */
export function readingOf(used: number, limit: number): ContextReading {
	const ratio = Math.min(1, used / limit);
	return { used, limit, percent: Math.round(ratio * 100), tight: ratio >= 0.8 };
}
