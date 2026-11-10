/** 给人看的文字，两种界面语言写在一起；界面入口用 @plume/ui 的 useI18n() 取当前语言，逻辑入口按 ctx.locale()。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	title: "需要你的意见",
	fullAccessNote: "这是业务提问。完全访问免除操作审批，仍需你决定问题的答案。",
	fromChild: (title: string) => `来自「${title}」的请求`,
	childUntitled: "未命名",
	recommended: "推荐",
	other: "其他",
	custom: "自定义回答",
	customPlaceholder: "说说你的想法",
	selectOne: "选择一项",
	selectMany: "可选择多项",
	skip: "跳过此步",
	cancel: "取消",
	confirm: "确认选择",
	sendAnswer: "发送回答",
	skipDefault: (choice: string) => `跳过将采用：${choice}`,
	verb: "征询",
	gone: "这个问题已经不等回答了",
	invalid: "回答和问题对不上",
};

export type Messages = typeof zhCN;

export const MESSAGES: Record<Locale, Messages> = {
	"zh-CN": zhCN,
	en: {
		title: "Your input is needed",
		fullAccessNote: "This asks for your decision. Full access skips action approvals; it does not answer questions for you.",
		fromChild: (title: string) => `Requested by “${title}”`,
		childUntitled: "untitled",
		recommended: "Recommended",
		other: "Other",
		custom: "Write your own answer",
		customPlaceholder: "Say what you think",
		selectOne: "Select one option",
		selectMany: "Select one or more options",
		skip: "Skip question",
		cancel: "Cancel",
		confirm: "Confirm selection",
		sendAnswer: "Send the answer",
		skipDefault: (choice: string) => `Skipping uses: ${choice}`,
		verb: "Asked",
		gone: "This question is no longer waiting for an answer",
		invalid: "The answer does not fit the question",
	},
};
