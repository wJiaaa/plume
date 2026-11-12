/** 上下文用量那一格给人看的文字，两种界面语言写在一起；界面入口用 @plume/ui 的 useI18n() 取当前语言。 */

import type { ContextSegmentKey, Locale } from "@plume/contract";

const zhCN = {
	usedPercent: "上下文占用 {percent}%",
	windowUsage: "上下文窗口用量",
	window: "上下文窗口",
	usedOfLimit: "{used} / {limit}（{percent}%）",
	nearLimit: "接近上限，较早的消息会被自动摘要压缩。开新对话可以拿回全部窗口。",
	used: "上一次请求",
	remaining: "剩余空间",
	memoryFiles: "记忆文件",
	noMemoryFiles: "当前未加载项目指令或记忆",
	/** 工具表在 Plume 都来自插件，MCP 服务的单列一段，其余的不叫「内置工具」。 */
	segments: {
		messages: "对话消息",
		tools: "工具",
		mcpTools: "MCP 工具",
		skills: "技能目录",
		systemPrompt: "系统提示词",
		conventions: "项目指令",
		memory: "记忆",
	} satisfies Record<ContextSegmentKey, string>,
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		usedPercent: "Context {percent}% full",
		windowUsage: "Context window usage",
		window: "Context window",
		usedOfLimit: "{used} / {limit} ({percent}%)",
		nearLimit: "Near the limit — older messages get summarised away. A new conversation gets the whole window back.",
		used: "Last request",
		remaining: "Room left",
		memoryFiles: "Memory files",
		noMemoryFiles: "No project instructions or memory are loaded",
		segments: {
			messages: "Messages",
			tools: "Tools",
			mcpTools: "MCP tools",
			skills: "Skill catalogue",
			systemPrompt: "System prompt",
			conventions: "Project instructions",
			memory: "Memory",
		},
	},
};

/** 把 `{name}` 换成对应的值。 */
export function fill(template: string, values: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
