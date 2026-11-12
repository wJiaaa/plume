/**
 * 上下文用量那一格的数：从会话的消息里读出上一次请求把上下文窗口占了多少。
 * 都是纯函数，`ContextMeter` 只管画。
 */

import type { Message } from "@plume/contract";

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
 */
export function contextUsed(messages: readonly Message[]): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant" || message.stopReason === "pending") continue;
		const usage = message.lastAttemptUsage ?? message.usage;
		const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
		if (total > 0) return total;
	}
	return null;
}

export function contextReading(messages: readonly Message[], limit: number): ContextReading | null {
	if (!(limit > 0)) return null;
	const used = contextUsed(messages);
	if (used === null) return null;
	const ratio = Math.min(1, used / limit);
	return { used, limit, percent: Math.round(ratio * 100), tight: ratio >= 0.8 };
}
