/**
 * plume.terminal 自带的文字（两种语言要一起给）：逻辑入口写进起不来的标签里的原因，界面入口的面板标题、说明和面板里的字。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	title: "终端",
	description: "在会话工作区运行命令",
	unavailable: "终端无法启动：原生组件 node-pty 没能加载。Plume 的其他功能不受影响。",
	tab: (n: number) => `终端 ${n}`,
	gone: "这里没有终端了。",
	new: "新建终端",
	closeRunning: (process: string) => `结束 ${process} 并关闭终端？`,
	closeRunningDetail: (process: string) => `这个终端里的 ${process} 还在运行，关闭终端会把它一起结束。`,
	closeRunningConfirm: "关闭终端",
	shellExitedCode: (code: number) => `shell 已退出（代码 ${code}）。`,
	findPlaceholder: "在终端中查找",
	findNone: "无结果",
	previous: "上一个",
	next: "下一个",
	close: "关闭",
	copy: "复制",
	paste: "粘贴",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		title: "Terminal",
		description: "Run commands in the session's workspace",
		unavailable: "The terminal cannot start: its native component, node-pty, failed to load. The rest of Plume is unaffected.",
		tab: (n) => `Terminal ${n}`,
		gone: "There is no terminal here any more.",
		new: "New terminal",
		closeRunning: (process) => `End ${process} and close the terminal?`,
		closeRunningDetail: (process) => `${process} is still running in this terminal. Closing the terminal ends it too.`,
		closeRunningConfirm: "Close terminal",
		shellExitedCode: (code) => `The shell exited (code ${code}).`,
		findPlaceholder: "Find in terminal",
		findNone: "No results",
		previous: "Previous",
		next: "Next",
		close: "Close",
		copy: "Copy",
		paste: "Paste",
	},
};
