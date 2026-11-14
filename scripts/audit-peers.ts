/**
 * 第 15 节：会话之间的消息到底怎么用、成没成。单拿出来是为了能测：`session-audit.ts` 一 import 就去读会话库。
 *
 * 工具由插件 plume.sessions 提供。消息是单向的：`send_message` 的结果只说寄没寄出去，对方回没回看它之后寄回来的信。
 */

export const PEER_TOOLS = ["list_sessions", "read_session", "send_message"] as const;

/** 一次会话间工具调用和它的结果，只留分类要用的几样。 */
export interface PeerCall {
	name: string;
	isError: boolean;
	/** 结果的 `details.kind`：寄出去的才有（`session_message`）。 */
	kind?: string;
}

/** 收到的一条来信消息（几封信可能并成一条）。 */
export interface PeerArrival {
	/** 插进了正在跑的那一轮；否则是为它开的一轮。 */
	steered: boolean;
	letters: unknown[];
}

export interface PeerSession {
	calls: PeerCall[];
	arrivals: PeerArrival[];
}

/** 一次调用的结果归哪类：寄出去的按 `details.kind`；被拦下的（找不到人、限速、不在主会话里）一律是 `refused`。 */
export function peerOutcome(call: PeerCall): string {
	if (call.kind) return call.kind;
	return call.isError ? "refused" : "other";
}

function bump(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

export function peerStats(sessions: PeerSession[]) {
	const calls: Record<string, number> = {};
	const outcomes: Record<string, number> = {};
	let letters = 0;
	let steered = 0;
	let opened = 0;
	let involved = 0;
	for (const session of sessions) {
		const peerCalls = session.calls.filter((call) => (PEER_TOOLS as readonly string[]).includes(call.name));
		if (peerCalls.length > 0 || session.arrivals.length > 0) involved++;
		for (const call of peerCalls) {
			bump(calls, call.name);
			if (call.name !== "list_sessions" && call.name !== "read_session") bump(outcomes, peerOutcome(call));
		}
		for (const arrival of session.arrivals) {
			if (arrival.steered) steered++;
			else opened++;
			letters += arrival.letters.length;
		}
	}
	return {
		involvedSessions: involved,
		calls,
		outcomes,
		letters,
		arrivals: { steered, opened },
		messagesPerInvolvedSession: involved ? +((calls.send_message ?? 0) / involved).toFixed(2) : 0,
	};
}
