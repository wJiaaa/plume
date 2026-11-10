/**
 * todo 插件界面上的文字，两种界面语言写在一起。第三方插件拿不到产品的文案目录，自带一份，
 * 用 @plume/ui 的 useI18n() 取当前语言。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	pause: "暂停",
	retryStep: "重试这一步",
	resume: "继续",
	/** 点「重试这一步」时替人说的话，发给模型。 */
	retryStepDetail: "重试刚才失败的那一步。",
	/** 点「继续」又说不出这一轮是怎么停的时替人说的话，发给模型。 */
	resumeDetail: "继续，从暂停的地方接着做。",
	pausedAt: "已暂停 · {step}",
	stalledAt: "停在 · {step}",
	notStarted: "待开始",
	pending: "{n} 项待处理",
	failed: "失败",
	paused: "已暂停",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		pause: "Pause",
		retryStep: "Try this step again",
		resume: "Carry on",
		retryStepDetail: "Run the step that just failed again.",
		resumeDetail: "Pick up where it paused.",
		pausedAt: "Paused · {step}",
		stalledAt: "Stopped at · {step}",
		notStarted: "Not started",
		pending: "{n} to go",
		failed: "Failed",
		paused: "Paused",
	},
};

/** 把 `{name}` 换成对应的值。 */
export function fill(template: string, values: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
