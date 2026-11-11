import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/contract";
import { mainChatContext, mainChatExcerpt, markBefore, readHistory, withMark } from "../src/main-chat.ts";

const user = (text: string, timestamp: number): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });

test("每一问只附主会话上次之后的新内容；被删、被换过就从头读", () => {
	const messages = [user("第一句", 1), user("第二句", 2)];
	const first = mainChatContext(messages, true, undefined);
	assert.match(first.text, /The main session is running and has 2 messages/);
	assert.match(first.text, /The main chat so far:[\s\S]*message 0\n\[user\]\n第一句[\s\S]*message 1/);
	assert.deepEqual(first.mark, { seen: 2, lastAt: 2 });

	assert.match(mainChatContext(messages, false, first.mark).text, /Nothing new in the main chat/);
	const more = mainChatContext([...messages, user("第三句", 3)], false, first.mark);
	assert.match(more.text, /New in the main chat since your previous question:\n\nmessage 2\n\[user\]\n第三句/);
	assert.doesNotMatch(more.text, /第一句/);

	const rewritten = mainChatContext([user("第一句", 1), user("换了", 9)], false, first.mark);
	assert.match(rewritten.text, /rewound or rewritten[\s\S]*第一句[\s\S]*换了/);
});

test("编辑重问截掉的那几问读到哪里一起作废，重问照样附上那期间的主会话", () => {
	const main = [user("第一句", 1)];
	// 第一问时侧边聊天还空着，第二问时已有两条（问和答）。
	const first = mainChatContext(main, false, markBefore([], 0));
	let log = withMark([], 0, first.mark);
	main.push(user("第二句", 2));
	const second = mainChatContext(main, false, markBefore(log, 2));
	assert.match(second.text, /New in the main chat[\s\S]*第二句/);
	log = withMark(log, 2, second.mark);
	// 编辑重问第二问：侧边聊天截回两条，读到哪里退回第一问之后，「第二句」再附一次。
	const again = mainChatContext(main, false, markBefore(log, 2));
	assert.match(again.text, /第二句/);
	log = withMark(log, 2, again.mark);
	assert.deepEqual(
		log.map((entry) => entry.at),
		[0, 2],
	);
	// 编辑重问第一问：之后的全作废，从头读。
	assert.equal(markBefore(log, 0), undefined);
	assert.deepEqual(withMark(log, 0, first.mark), [{ at: 0, mark: first.mark }]);
});

test("放不下时留最新的，告诉它从哪接着读", () => {
	const messages = [user("a".repeat(50), 1), user("b".repeat(50), 2)];
	const excerpt = mainChatExcerpt(messages, 0, 60);
	assert.match(excerpt, /^Only the most recent part is shown \(from around message 1\); use read_main_chat for messages 0–1/);
	assert.match(excerpt, /b{43}$/);
	assert.doesNotMatch(excerpt, /a{50}/);
});

test("read_main_chat：分页、按关键词找、给出下一页从哪开始", () => {
	const messages = [user("hello", 1), user("world", 2), user("hello again", 3)];
	const page = JSON.parse(readHistory("main", messages, { limit: 1 }));
	assert.deepEqual(
		page.messages.map((entry: { index: number }) => entry.index),
		[0],
	);
	assert.deepEqual(page.next, { start: 1 });
	const found = JSON.parse(readHistory("main", messages, { query: "HELLO" }));
	assert.deepEqual(
		found.messages.map((entry: { index: number }) => entry.index),
		[0, 2],
	);
	assert.equal(found.next, null);
	const cut = JSON.parse(readHistory("main", messages, { maxChars: 4 }));
	assert.deepEqual(cut.next, { start: 0, offset: 4 });
});
