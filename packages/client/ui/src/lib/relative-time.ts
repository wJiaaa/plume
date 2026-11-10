/**
 * 多久以前，用人会用的单位说。
 */

import { activeLocale, translate } from "../i18n/translate.ts";
import type { ResolvedUiLocale } from "../i18n/index.ts";
import { formatDate } from "./date-format.ts";
import { hourStyle } from "./hour-style.ts";

/** 故意说得粗：列表里没人关心一次提交的确切分钟。 */
export function relativeTime(iso: string, now = Date.now()): string {
	const span = spanOf(iso, now);
	// 「刚刚」本身已经是完整的回答，「刚刚前」在哪种语言里都不成话。
	return span && span !== translate("time.justNow") ? translate("time.ago", { span }) : span;
}

/**
 * 同一段时间，不带「前」，给一行的角落用。
 *
 * 列表把它画在一列的右边，这一列还要放标题，这里每多一个字，标题就少一个字。挨着标题时，一段时长
 * 不用说明也读得出是「多久以前」，所以各家代码托管站在同一个位置都这样写。
 *
 * `now` 是参数而不是在里面取，这样组件可以跟着一个共享的时钟重渲染——整个列表一个定时器，而不是每行
 * 一个——也让它保持一个不用冻结时间就能测的函数。
 */
export function shortRelativeTime(iso: string, now = Date.now()): string {
	return spanOf(iso, now);
}

/** 确切的时刻，给取整过的那个当悬停提示。 */
export function exactTime(iso: string, locale: ResolvedUiLocale = activeLocale()): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "";
	return formatDate(at, locale, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: hourStyle(locale),
		minute: "2-digit",
	});
}

function spanOf(iso: string, now: number): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const minutes = Math.round((now - then) / 60_000);
	if (minutes < 1) return translate("time.justNow");
	if (minutes < 60) return translate("time.minutes", { n: minutes });
	const hours = Math.round(minutes / 60);
	if (hours < 24) return translate("time.hours", { n: hours });
	const days = Math.round(hours / 24);
	if (days < 30) return translate("time.days", { n: days });
	/*
	 * 用月和年，不用日期。
	 *
	 * 列表是拿来扫「这个有多旧」的，「2026年7月12日」要读的人自己去做减法——而且旁边一列十几行都要这样减。
	 * 它还宽一倍，会把旁边的标题挤成省略号。
	 */
	const months = Math.round(days / 30);
	if (months < 12) return translate("time.months", { n: months });
	return translate("time.years", { n: Math.round(months / 12) });
}
