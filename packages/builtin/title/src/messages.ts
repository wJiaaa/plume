/** 智能标题插件给人看的文字，两种界面语言写在一起。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	switchTitle: "智能标题总结",
	switchDetail: "自动精简长消息标题，模型在设置 → 智能体里选，会产生模型用量。",
	modelTitle: "智能标题模型",
	modelDetail: "把长的第一条消息精简成会话标题",
	followMain: "跟随主会话",
	followMainShort: "随主会话",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		switchTitle: "Automatic chat titles",
		switchDetail: "Shorten long message titles. Pick the model in Settings → Subagents. Uses model tokens.",
		modelTitle: "Smart title model",
		modelDetail: "Shortens a long first message into the session title",
		followMain: "Follow the main session",
		followMainShort: "As the session",
	},
};
