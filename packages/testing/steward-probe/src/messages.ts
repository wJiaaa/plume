/** 面板上给人看的文字，两种界面语言写在一起。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	title: "代管探针",
	description: "开一个由本插件代管的会话，往里转话、替人答卡",
	openHint: "写下第一句话，开一个由本插件代管的新会话。",
	open: "开代管会话",
	stewarded: "本插件代管着这个会话",
	notStewarded: "本插件没有代管这个会话",
	post: "转进会话",
	pending: "弹着的卡",
	noPending: "没有等人答的卡",
	fromChild: "这张卡是挂在这个会话下面的子会话弹的",
	allow: "允许这一次",
	reject: "拒绝",
	answer: "交回",
	answerHint: "要交回的数据：JSON，或一句话（交成 { answer: 这句话 }）",
	replies: "模型的回复",
	noReplies: "还没有回复",
	missed: "那张卡已经不在了",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		title: "Steward probe",
		description: "Open a session stewarded by this plugin, post into it and answer its cards",
		openHint: "Write the first message to open a new session stewarded by this plugin.",
		open: "Open stewarded session",
		stewarded: "This plugin stewards this session",
		notStewarded: "This plugin does not steward this session",
		post: "Post into session",
		pending: "Pending card",
		noPending: "No card is waiting for an answer",
		fromChild: "This card comes from a child session under this session",
		allow: "Allow once",
		reject: "Reject",
		answer: "Answer",
		answerHint: "Data to answer with: JSON, or a sentence (sent as { answer: sentence })",
		replies: "Model replies",
		noReplies: "No replies yet",
		missed: "That card is gone",
	},
};
