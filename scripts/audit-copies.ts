// 审计脚本读会话时，分叉抄来的那段怎么认。单拿出来是为了能测：`session-audit.ts` 一 import 就去读会话库。

import type { Message, SessionSummary } from "../packages/contract/src/index.ts";

/**
 * 分叉开头抄来的消息有几条。
 *
 * 分叉把原会话的前一段原样拷进新会话（`forkSession`），消息保留原来的时间戳，新会话的 `createdAt` 是分叉那一刻；之后进会话的消息都
 * 不早于它。所以开头那段早于 `createdAt` 的就是抄来的：那些回复在原会话里已经付过钱、发生过，在分叉里再数一遍就是重复。
 * 压缩记录里抄来的那几次压缩、那几行同理，按各自的时刻认（见 `session-audit.ts`）。
 */
export function copiedCount(summary: Pick<SessionSummary, "createdAt" | "forkedFrom">, messages: readonly Pick<Message, "timestamp">[]): number {
	if (!summary.forkedFrom) return 0;
	const own = messages.findIndex((message) => message.timestamp >= summary.createdAt);
	return own < 0 ? messages.length : own;
}
