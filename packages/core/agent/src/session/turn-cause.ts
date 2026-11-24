/**
 * 一轮是谁引起的（`TurnCause`）：本体在这一轮开头那句写进会话时定下，插件从 `session.cause` 读，不从消息记录里往回猜。
 * 这里只有怎么算；什么时候算由 `turn.ts` 定（开头那句、开头读进的那批送达、一轮做完前又读进的、中途人插的话）。
 */

import type { SessionKind, TurnCause, UserMessage } from "@plume/contract";
import type { Report } from "../background.ts";

/**
 * 一句话（一轮开头那句、中途插进来的）是谁的。界面替人说的「继续」（`synthetic`）、侧边聊天替人交过来的（`origin: "child"`）
 * 是人按的、人交代的，算人。子会话、独立会话（不是 `top`）里的每一轮都是建它的插件跑的，算运行时的事。
 */
export function promptCause(
	prompt: UserMessage,
	session: { kind: SessionKind; launchedBy: string | undefined },
	launched: { has(prompt: UserMessage): boolean },
): TurnCause {
	if (session.kind !== "top") return { by: "runtime" };
	if (prompt.origin === "plugin") return { by: "steward", plugin: prompt.fromPlugin ?? "" };
	if (launched.has(prompt)) return { by: "launch", plugin: session.launchedBy ?? "" };
	return { by: "human" };
}

/**
 * 读进来的一批送达是谁的：有信算寄信的会话（几封信一起到时，有来处 `originId` 的先认它），有开出去的会话交回的算交回的那个，
 * 都没有就是这个会话自己派出去的事回来了——上一轮收尾时还在等它们（`waited`）就沿用上一轮的，否则是运行时的事（挂着的监视、约好的唤醒）。
 */
export function reportsCause(reports: readonly Report[], previous: TurnCause | undefined, waited: boolean, originId?: string): TurnCause {
	const peers = reports.flatMap((report) => ("letter" in report ? [report.letter.peer.sessionId] : []));
	if (peers.length > 0) return { by: "peer", from: originId && peers.includes(originId) ? originId : peers[0]! };
	for (const report of reports) if ("delivery" in report && report.delivery?.sessionId) return { by: "report", from: report.delivery.sessionId };
	return waited && previous ? previous : { by: "runtime" };
}
