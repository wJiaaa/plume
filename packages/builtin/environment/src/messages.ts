import type { Locale } from "@plume/contract";

const zhCN = {
	environment: "环境",
	sections: "显示哪些内容",
	chooseSections: "选择显示的内容",
	sectionOpenIn: "打开方式",
	childSessions: "子会话",
	children: "子 Agent",
	backgroundGroup: "后台",
	output: "产出",
	references: "引用",
	more: (n: number) => `还有 ${n} 项`,
	active: "进行中",
	done: "完成",
	paused: "已暂停",
	missingSession: "会话不存在",
};
export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		environment: "Environment",
		sections: "Visible sections",
		chooseSections: "Choose what to show",
		sectionOpenIn: "Open with",
		childSessions: "Sub-sessions",
		children: "Sub-agents",
		backgroundGroup: "Background",
		output: "Output",
		references: "References",
		more: (n: number) => `${n} more`,
		active: "In progress",
		done: "Done",
		paused: "Paused",
		missingSession: "Conversation not found",
	},
};
