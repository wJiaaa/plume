import type { Locale } from "@plume/contract";

// i18n-exempt：这里是逻辑入口专用的中英文案目录，界面入口有独立的 messages.ts。
const zhCN = {
	missingSession: "找不到对应的会话。",
	missingTurn: "找不到对应轮次的最后回答。",
	invalidPath: "撤销路径必须是非空的文件路径。",
	noReport: "这一轮没有可打开的实现与验证记录。",
	collectFailed: (reason: string) => `变更快照不可用：${reason}`,
	reportFailed: (reason: string) => `无法保存本轮实现与验证记录：${reason}`,
	title: "本轮实现与验证记录",
	time: (value: string) => `时间：${value}`,
	project: (cwd: string) => `项目：${cwd}`,
	request: "用户需求",
	answer: "Agent 交付说明",
	files: "实际文件变更",
	file: (path: string, added: number, removed: number) => `- ${path}：+${added} −${removed}`,
	warnings: "未覆盖的记录",
	diff: "文件差异",
	noChanges: (path: string) => `${path}：没有变更`,
	unrecorded: "有改动没有记录下来，没法完整退回。",
};

const en: typeof zhCN = {
	missingSession: "The requested session was not found.",
	missingTurn: "The final answer for the requested turn was not found.",
	invalidPath: "The undo path must be a nonempty file path.",
	noReport: "This turn has no implementation and verification record to open.",
	collectFailed: (reason) => `Change snapshots are unavailable: ${reason}`,
	reportFailed: (reason) => `Could not save this turn's implementation and verification record: ${reason}`,
	title: "Implementation and verification record for this turn",
	time: (value) => `Time: ${value}`,
	project: (cwd) => `Project: ${cwd}`,
	request: "User request",
	answer: "Agent delivery notes",
	files: "Actual file changes",
	file: (path, added, removed) => `- ${path}: +${added} −${removed}`,
	warnings: "Uncovered records",
	diff: "File differences",
	noChanges: (path) => `${path}: no changes`,
	unrecorded: "Some changes weren't recorded, so the files can't be fully put back.",
};

export const MESSAGES: Record<Locale, typeof zhCN> = { "zh-CN": zhCN, en };
