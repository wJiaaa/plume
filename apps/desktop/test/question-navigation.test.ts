/**
 * 问题导航和时间线：认出人问了哪几句、哪两句隔得久，引文怎么拼回正文。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/contract";
import { questionsIn, questionWindow, timeSeparators } from "../src/renderer/conversation/question-navigation.ts";
import { withQuotes } from "../src/renderer/conversation/quote.ts";
import { markdownExcerpt } from "../src/renderer/markdown/excerpt.ts";

const MINUTE = 60_000;
const at = (hour: number, minute = 0) => new Date(2026, 10, 5, hour, minute).getTime();
const user = (text: string, timestamp: number, extra: Record<string, unknown> = {}): Message =>
	({ role: "user", content: [{ type: "text", text }], timestamp, ...extra }) as Message;
const reply = (text: string, timestamp: number): Message =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp,
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	}) as Message;

test("问题是人说的每一句，带着后面回答的开头；界面替人说的「继续」不算，只带图的用替代说法", () => {
	const messages = [
		user("第一问", at(9)),
		reply("答一", at(9, 1)),
		user("继续", at(9, 2), { synthetic: true }),
		reply("又答", at(9, 3)),
		{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }], timestamp: at(9, 4) } as Message,
	];
	assert.deepEqual(questionsIn(messages, "图片消息"), [
		{ index: 0, text: "第一问", answer: "又答" },
		{ index: 4, text: "图片消息", answer: "" },
	]);
});

test("时间线画在第一句、隔了半小时以上和跨了天的那句上；界面替人说的话不算人回来过", () => {
	const messages = [
		user("早", at(9)),
		reply("嗯", at(9, 1)),
		user("接着", at(9, 20)),
		reply("好", at(9, 21)),
		user("继续", at(10, 10), { synthetic: true }),
		user("过了一阵", at(10, 0) + 31 * MINUTE),
	];
	assert.deepEqual([...timeSeparators(messages)], [0, 5]);
	assert.deepEqual([...timeSeparators([user("昨晚", new Date(2026, 10, 4, 23, 50).getTime()), user("今早", at(0, 5))])], [0, 1]);
});

test("导航一次排出的那一段长度固定，两头贴着头尾", () => {
	assert.deepEqual(questionWindow(5, 4), { start: 0, end: 5 });
	assert.deepEqual(questionWindow(40, 0), { start: 0, end: 15 });
	assert.deepEqual(questionWindow(40, 39), { start: 25, end: 40 });
	assert.deepEqual(questionWindow(40, 20), { start: 13, end: 28 });
});

test("引文拼成引用块排在要说的话前面，只有引文时不留末尾空行", () => {
	assert.equal(withQuotes("为什么", [{ text: "第一行\n\n第二行" }]), "> 第一行\n>\n> 第二行\n\n为什么");
	assert.equal(withQuotes("", [{ text: "只引" }]), "> 只引");
	assert.equal(withQuotes("原样", []), "原样");
});

test("预览摘录把 Markdown 压成一行能读的字", () => {
	assert.equal(markdownExcerpt("# 标题\n\n- **一** 项\n- `二`\n\n---\n\n[链接](https://a.b)"), "标题 一 项 二 链接");
});
