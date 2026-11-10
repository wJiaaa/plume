/**
 * 第 15 节：会话之间的消息到底怎么用、成没成。单拿出来是为了能测：`session-audit.ts` 一 import 就去读会话库。
 *
 * 工具由插件 plume.sessions 提供。问是发出即返回，答复作为一封 `answer` 信送回提问方，所以「问成没成」看收到的信，
 * 不看 `ask_session` 的结果；后者只说寄没寄出去。
 */

export const PEER_TOOLS = ["list_sessions", "read_session", "ask_session", "reply_session", "notify_session"] as const;

/** 一次会话间工具调用和它的结果，只留分类要用的几样。 */
export interface PeerCall {
	name: string;
	isError: boolean;
	/** 结果的 `details.kind`：寄出去的那几种才有（`session_ask` 之类）。 */
	kind?: string;
}

/** 收到的一条来信消息（几封信可能并成一条）。 */
export interface PeerArrival {
	/** 插进了正在跑的那一轮；否则是为它开的一轮。 */
	steered: boolean;
	letters: { request?: boolean; answer?: string }[];
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
	const letters: Record<string, number> = {};
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
			for (const letter of arrival.letters) bump(letters, letter.answer ? `answer:${letter.answer}` : letter.request ? "request" : "notice");
		}
	}
	return {
		involvedSessions: involved,
		calls,
		outcomes,
		letters,
		arrivals: { steered, opened },
		noticesPerInvolvedSession: involved ? +((calls.notify_session ?? 0) / involved).toFixed(2) : 0,
	};
}
