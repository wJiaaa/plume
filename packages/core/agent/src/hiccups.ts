/**
 * 一次连接上的岔子，从开始到收场，记成一条：等着重试时数着次数，接上了变成一行灰字留在原地，真没救了才是一句失败。
 * 重试和失败本是同一件事的三个阶段，分开记的话，一次自己好了的抖动什么痕迹都不留，而一次没好的要占两行。
 */

import type { Hiccup } from "@plume/contract";
import type { Failure } from "@plume/llm/failure";

export interface RetryInfo {
	/** 这一次中断里第几次重试，从 1 数。 */
	attempt: number;
	delayMs: number;
	reason: string;
	failure?: Failure;
}

export interface RetrySettled {
	outcome: "recovered" | "gave_up" | "stopped" | "switched";
	attempts: number;
	failure?: Failure;
	/** 换成的模型名，见 `Hiccup.switchedTo`。 */
	switchedTo?: string;
}

/** 又要重试一次：还在等的那条接着数，否则是新的一次中断。`at` 是会话此刻有几条消息。 */
export function foldRetry(hiccups: Hiccup[], info: RetryInfo, now: number, at: number): Hiccup[] {
	const last = hiccups.at(-1);
	const waiting = last?.outcome === "waiting" ? last : undefined;
	const fingerprint = info.failure?.fingerprint ?? info.reason;
	const next: Hiccup = {
		id: waiting?.id ?? `hiccup-${now}-${hiccups.length}`,
		// 同一次中断重试几回，说的仍是同一个时刻的事。
		at: waiting?.at ?? at,
		attempts: info.attempt,
		until: now + info.delayMs,
		summary: info.failure?.summary ?? info.reason,
		...(info.failure?.detail ? { detail: info.failure.detail } : {}),
		kind: info.failure?.kind ?? "network",
		fingerprint,
		// 一字不差地重复好几次，说明不是在排队等一个会好起来的东西；不替人决定停不停，只把事实摆出来。
		repeated: waiting && waiting.fingerprint === fingerprint ? waiting.repeated + 1 : 1,
		outcome: "waiting",
		...(info.failure?.hint ? { hint: info.failure.hint } : {}),
	};
	return waiting ? [...hiccups.slice(0, -1), next] : [...hiccups, next];
}

/** 那条等着的记录收场了。一次都没重试就失败的（密钥不对、模型名写错）也补一条，否则屏幕上只剩一片安静。 */
export function settleHiccups(hiccups: Hiccup[], settled: RetrySettled, at: number): Hiccup[] {
	const last = hiccups.at(-1);
	const failure = settled.failure;
	if (last?.outcome !== "waiting") {
		if (settled.outcome !== "gave_up" || !failure) return hiccups;
		return [
			...hiccups,
			{
				id: `hiccup-fatal-${hiccups.length}-${failure.fingerprint}`,
				at,
				attempts: settled.attempts,
				until: 0,
				summary: failure.summary,
				...(failure.detail ? { detail: failure.detail } : {}),
				kind: failure.kind,
				fingerprint: failure.fingerprint,
				repeated: 1,
				outcome: "gave_up",
				...(failure.hint ? { hint: failure.hint } : {}),
			},
		];
	}
	// 放弃时以最后那个失败为准：等待途中报的可能只是过程里的一个。
	const summary = failure?.summary ?? last.summary;
	const detail = failure?.detail ?? last.detail;
	const hint = failure?.hint ?? last.hint;
	return [
		...hiccups.slice(0, -1),
		{
			...last,
			outcome: settled.outcome,
			attempts: Math.max(last.attempts, settled.attempts),
			summary,
			...(detail ? { detail } : {}),
			...(hint ? { hint } : {}),
			...(settled.switchedTo ? { switchedTo: settled.switchedTo } : {}),
		},
	];
}
