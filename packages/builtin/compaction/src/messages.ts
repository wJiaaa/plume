import type { Locale } from "@plume/contract";

// i18n-exempt：插件自己的中英文案目录，逻辑入口和界面入口共用。
const zhCN = {
	command: "压缩上下文",
	argumentHint: "可选：希望摘要保留的内容",
	noSession: "还没有可压缩的对话。",
	tooBig: "摘要请求放不进当前模型的上下文窗口，原上下文保持不变。可以缩短压缩说明后再试。",
	cancelled: "压缩已取消。",
	empty: "模型返回的摘要为空，原上下文保持不变。",
	recallVerb: "回忆",
};

const en: typeof zhCN = {
	command: "Compact the context",
	argumentHint: "Optional: what the summary should keep",
	noSession: "There is no conversation to compact yet.",
	tooBig: "The summary request doesn't fit in this model's context window, so the context is unchanged. Try a shorter compaction note.",
	cancelled: "Compaction cancelled.",
	empty: "The model returned an empty summary, so the context is unchanged.",
	recallVerb: "Recalled",
};

export const MESSAGES: Record<Locale, typeof zhCN> = { "zh-CN": zhCN, en };
