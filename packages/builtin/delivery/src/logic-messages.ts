import type { Locale } from "@plume/contract";

// i18n-exempt：这里是逻辑入口专用的中英文案目录，界面入口有独立的 messages.ts。
const zhCN = {
	missingSession: "找不到对应的会话。",
	missingTurn: "找不到对应轮次的最后回答。",
	invalidPath: "撤销路径必须是非空的文件路径。",
	collectFailed: (reason: string) => `变更快照不可用：${reason}`,
};

const en: typeof zhCN = {
	missingSession: "The requested session was not found.",
	missingTurn: "The final answer for the requested turn was not found.",
	invalidPath: "The undo path must be a nonempty file path.",
	collectFailed: (reason) => `Change snapshots are unavailable: ${reason}`,
};

export const MESSAGES: Record<Locale, typeof zhCN> = { "zh-CN": zhCN, en };
