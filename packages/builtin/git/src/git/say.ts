/**
 * 逻辑入口给人看的文字按哪种语言。
 *
 * git 的各个模块都可能要说一句话（失败原因、读不了的说明），一路把语言当参数传下去太绕，
 * 所以由 `apply` 把 `ctx.locale` 交给这里，用到时再问——界面语言随时会换，问的是当下。
 * 没交过（测试里）就用中文。
 */

import type { Locale } from "@plume/contract";
import { LOGIC_MESSAGES, type LogicMessages } from "../messages.ts";

let locale: () => Locale = () => "zh-CN";

export function setLocaleSource(source: () => Locale): void {
	locale = source;
}

/** 当下的界面语言：工作树那一半的文案也按它选。 */
export function currentLocale(): Locale {
	return locale();
}

export function say(): LogicMessages {
	return LOGIC_MESSAGES[locale()];
}
