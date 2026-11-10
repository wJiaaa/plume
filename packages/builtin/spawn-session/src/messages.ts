/** 建议新会话、归档会话给人看的文字，两种界面语言写在一起。发给模型的在 `prompt.ts`。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	suggesting: "建议新会话",
	suggested: "建议的新会话",
	noted: "建议了新会话",
	dismissed: "已收起",
	dismiss: "收起这条建议",
	start: "开始",
	startTip: "在这个项目里另开一个会话去做，当前对话不动",
	startFailed: (reason: string) => `没能开始这个会话：${reason}`,
	newSession: "新会话",
	started: "已开始",
	running: "进行中",
	done: "已完成",
	failed: "没跑完",
	reportBack: "交回这里",
	reportBackOn: "跑完第一轮后，把它的回复交回这个对话",
	reportBackOff: "不交回：做完就停在它自己的会话里",
	pending: (n: number) => `${n} 条建议的新会话等你决定`,
	gone: "这条建议不在记录里了",
	parentGone: "提建议的对话已经不在了",
	archived: "归档会话",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		suggesting: "Suggesting a chat",
		suggested: "Suggested chat",
		noted: "Suggested a chat",
		dismissed: "Dismissed",
		dismiss: "Dismiss suggestion",
		start: "Start",
		startTip: "Runs it as a separate chat in this project. You stay where you are.",
		startFailed: (reason: string) => `Couldn’t start the chat: ${reason}`,
		newSession: "New chat",
		started: "Started",
		running: "Running",
		done: "Done",
		failed: "Stopped short",
		reportBack: "Report back",
		reportBackOn: "When its first turn finishes, its reply comes back to this chat",
		reportBackOff: "Doesn’t report back: it finishes in its own chat",
		pending: (n: number) => `${n} suggested chat${n === 1 ? "" : "s"} waiting on you`,
		gone: "This suggestion is no longer in the conversation",
		parentGone: "The chat that suggested it is gone",
		archived: "Archived the chat",
	},
};
