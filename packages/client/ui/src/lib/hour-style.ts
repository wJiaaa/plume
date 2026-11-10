/**
 * 小时要不要补零，取决于这种语言按哪种钟点报时。
 *
 * 24 小时制下「09:05」是通常的写法，中文界面一直这样显示。12 小时制下那个零读起来像打错了——「02:28 PM」——
 * 所以英文不补。
 *
 * 写 `hour: "numeric"` 的格式在每种语言里都不动小时，不用换成这个；换了反而会给一个从来不补零的中文
 * 9:05 补上零。
 *
 * 按语言留着：每一行消息都要问，而答案只随语言变。
 */

import type { ResolvedUiLocale } from "../i18n/index.ts";

const hourStyles = new Map<ResolvedUiLocale, "numeric" | "2-digit">();

export function hourStyle(locale: ResolvedUiLocale): "numeric" | "2-digit" {
	let style = hourStyles.get(locale);
	if (!style) {
		style = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 ? "numeric" : "2-digit";
		hourStyles.set(locale, style);
	}
	return style;
}
