/**
 * plume.web 给人看的文字（设置分区、转录里工具的说法），两种界面语言写在一起；界面入口用 @plume/ui 的 useI18n() 取当前语言。
 * 牌子名（Tavily、Brave Search……）不翻译，写在 ui 那边。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	title: "网页搜索",
	toolFetch: "抓取网页",
	toolSearch: "搜索网络",
	/** `{tool}` 画成等宽的工具名，`{strong}` 画成加粗的 `introStrong`；位置由译文定。 */
	intro: "给 agent 一个 {tool} 工具。说实话：{strong} —— 免配置那两个要么被限流，要么只认英文词条。下面四家里三家有免费额度，日常用量够；DeepSeek 按次计费。",
	introStrong: "中文搜索想好用，得填一个 key",
	which: "用哪一个",
	apiKey: "API key",
	needsKey1000: "需要 API key · 每月 1000 次免费",
	tavily: "为 agent 设计的搜索，会连带返回一段总结，通常是这里最省事的选择。",
	needsKeyPaid: "需要 API key · 按次计费",
	deepseek: "DeepSeek 自研搜索引擎，中文结果好，认识 site:、lang:、after: 这类搜索语法。每 1000 次 5 元。",
	needsKey2000: "需要 API key · 每月 2000 次免费",
	brave: "独立索引，不转手给别家。免费额度是这几个里最大的。",
	needsKeyFree: "需要 API key · 有免费额度",
	exa: "语义检索，找概念和相似内容比找关键词强。",
	ddgInstant: "DuckDuckGo 速答",
	noSetupStable: "免配置 · 稳定",
	/** `**…**` 之间的画成加粗。 */
	ddgInstantDetail: "官方接口，不用注册也不会被限流。但只有百科式答案，不是网页结果列表，而且**基本只对英文词条有效** —— 中文提问多半查不到东西。",
	noSetupLimited: "免配置 · 经常被限流",
	ddgScrapeDetail: "不用注册任何账号，直接抓它的无脚本页面。但它会挡自动访问 —— 拿不到结果时不是这里坏了，是对方在限流，隔一阵子才好。当正经搜索用不可靠。",
	keySet: "已填 key",
	keyMissing: "未填 key",
	pasteKey: "粘贴 API key",
	keySaved: "已保存，留空则不修改",
	apply: "申请",
	clear: "清除",
	show: "显示",
	hide: "隐藏",
	trustNote: "搜索会把你的问题发给选中的服务商。结果和网页一样按不可信内容处理 —— agent 不会把搜到的文字当成给它的指令。",
	loadFailed: (reason: string) => `读不到搜索设置：${reason}`,
	saveFailed: (reason: string) => `搜索设置没存上：${reason}`,
	openFailed: (reason: string) => `打不开申请页面：${reason}`,
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		title: "Web search",
		toolFetch: "Fetched pages",
		toolSearch: "Searched the web",
		intro:
			"Gives the agent a {tool} tool. Honestly: {strong} — the two that need no setup are either rate-limited or English-only. Three of the four below have a free tier that covers ordinary use; DeepSeek charges per search.",
		introStrong: "good non-English search needs a key",
		which: "Which one",
		apiKey: "API key",
		needsKey1000: "Needs an API key · 1,000 free a month",
		tavily: "Search built for agents; it returns a summary along with the results, and is usually the least trouble here.",
		needsKeyPaid: "Needs an API key · pay per search",
		deepseek: "DeepSeek's own search index, strong on Chinese results, and it understands site:, lang: and after:. ¥5 per 1,000 searches.",
		needsKey2000: "Needs an API key · 2,000 free a month",
		brave: "Its own index, not resold from someone else's. The largest free tier of the lot.",
		needsKeyFree: "Needs an API key · has a free tier",
		exa: "Semantic search — better at concepts and things like this than at keywords.",
		ddgInstant: "DuckDuckGo Instant Answer",
		noSetupStable: "No setup · steady",
		ddgInstantDetail:
			"The official endpoint: no signup, no rate limits. But it answers encyclopaedically rather than listing web results, and **it really only works for English entries** — a question in another language usually finds nothing.",
		noSetupLimited: "No setup · often rate-limited",
		ddgScrapeDetail:
			"No account at all — it reads their no-script page directly. But they block automated access, so an empty result is not something broken here; it is their rate limit, and it clears after a while. Not dependable as your real search.",
		keySet: "Key set",
		keyMissing: "No key",
		pasteKey: "Paste the API key",
		keySaved: "Saved — leave blank to keep it",
		apply: "Get one",
		clear: "Clear",
		show: "Show",
		hide: "Hide",
		trustNote:
			"Searching sends your question to the provider you picked. What comes back is treated as untrusted, the same as any web page — the agent does not take the text it finds as instructions to itself.",
		loadFailed: (reason: string) => `Couldn't read the search settings: ${reason}`,
		saveFailed: (reason: string) => `Search settings weren't saved: ${reason}`,
		openFailed: (reason: string) => `Couldn't open the signup page: ${reason}`,
	},
};
