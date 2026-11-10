/**
 * 一条连接岔子的那一行字和悬停时多说的几句。三个阶段说三种话：等的时候想知道还要等多久，
 * 接上了想知道那阵子过去了，没救了想知道到底卡在哪。
 */

import type { Hiccup } from "@plume/contract";
import { type MessageKey, translate } from "@plume/ui";

/** 一行放不下时截到多少，原文进悬停和展开。 */
const LINE_MAX = 40;
/** 悬停气泡最宽 360px，塞一页 JSON 只会得到一堵墙。 */
const TIP_MAX = 220;

export function describeHiccup(hiccup: Hiccup, now: number): string {
	if (hiccup.outcome === "recovered") return hiccup.attempts <= 1 ? translate("hiccup.recovered") : translate("hiccup.recoveredAfter", { n: hiccup.attempts });
	if (hiccup.outcome === "gave_up") return clip(hiccup.summary, LINE_MAX);
	if (hiccup.outcome === "switched")
		return hiccup.switchedTo
			? translate("hiccup.switchedTo", { model: hiccup.switchedTo, n: hiccup.attempts })
			: translate("hiccup.switched", { n: hiccup.attempts });
	if (hiccup.outcome === "stopped") return translate("hiccup.stopped", { n: hiccup.attempts });
	const left = Math.ceil((hiccup.until - now) / 1000);
	const wait = left > 0 ? translate("hiccup.retryIn", { n: left }) : translate("hiccup.retrying");
	// 等的时候「还要等多久」比「什么错」要紧；原因在悬停和展开里。
	const what = translate(hiccup.kind === "network" ? "hiccup.dropped" : "hiccup.serverFault");
	// 三次以上一模一样的，说明不是在排队等一个会好起来的东西。
	if (hiccup.repeated >= 3) return translate("hiccup.sameErrorEvery", { what, n: hiccup.attempts });
	return translate("hiccup.attemptN", { what, wait, n: hiccup.attempts });
}

const HINTS: Record<string, MessageKey> = {
	"check-key": "hiccup.hintKey",
	"check-model": "hiccup.hintModel",
	"check-billing": "hiccup.hintQuota",
	"check-request": "hiccup.hintRequest",
	blocked: "hiccup.hintSafety",
};

export function hiccupTip(hiccup: Hiccup): string | undefined {
	const lines: string[] = [];
	if (hiccup.summary) lines.push(clip(hiccup.summary, TIP_MAX));
	if (hiccup.detail && hiccup.detail !== hiccup.summary) lines.push(clip(hiccup.detail, TIP_MAX));
	if (hiccup.outcome === "recovered" && hiccup.attempts > 1) lines.push(translate("hiccup.tookNTries", { n: hiccup.attempts }));
	const hint = hiccup.hint ? HINTS[hiccup.hint] : undefined;
	if (hint) lines.push(translate(hint));
	return lines.filter(Boolean).join("\n") || undefined;
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
