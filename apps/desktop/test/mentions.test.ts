import assert from "node:assert/strict";
import { test } from "node:test";
import { findMentionRanges, formatMention, parseMentionTrigger, rankMentions } from "../src/renderer/composer/mentions.ts";
import { parseInvocation } from "../src/renderer/composer/commands.ts";
import { withSessionReferences } from "../src/renderer/composer/session-references.ts";

test("@ 只在词首触发；邮箱、选区和已加引号的路径不打开菜单", () => {
	assert.deepEqual(parseMentionTrigger("看看 @src", 7, 7), { term: "src", start: 3, end: 7 });
	for (const text of ["a@example.com", '@"src"', "@'目录'"]) assert.equal(parseMentionTrigger(text, text.length, text.length), null);
	assert.equal(parseMentionTrigger("@src", 0, 4), null);
});
test("带空格、引号和 Windows 反斜线的文件引用可以往返", () => {
	for (const path of ["src/a.ts", 'C:\\work\\a "test".ts', "目录/空 格.md"]) {
		const token = formatMention(path);
		assert.deepEqual(findMentionRanges(`看 ${token} 然后 @reviewer`), [
			{ start: 2, end: 2 + token.length, inner: path },
			{ start: 6 + token.length, end: 15 + token.length, inner: "reviewer" },
		]);
	}
});
test("引用按可见名字和描述搜索，保留分组顺序；compact 只在行首执行", () => {
	const items = [
		{ id: "pick-file", kind: "action" as const, title: "选择文件" },
		{ id: "agent", kind: "agent" as const, title: "reviewer", description: "代码审查" },
	];
	assert.equal(rankMentions("文件", items)[0]?.id, "pick-file");
	assert.equal(rankMentions("审查", items)[0]?.id, "agent");
	assert.deepEqual(parseInvocation("@compact 保留接口\n约束"), parseInvocation("/compact 保留接口\n约束"));
	assert.equal(parseInvocation("解释 @compact"), null);
});
test("会话引用只传资源入口和参考材料说明，去重并保留显示文本和附件", () => {
	const message = { content: [{ type: "text" as const, text: "继续" }], displayText: "继续", attachments: [{ name: "readme.md" }] };
	const ref = { id: "old-session", title: '标题 "词"' };
	const sent = withSessionReferences(message, [ref, ref]);
	assert.equal(sent.displayText, "继续");
	assert.deepEqual(sent.attachments, message.attachments);
	assert.deepEqual(sent.sessionRefs, [ref]);
	assert.match(JSON.stringify(sent.content), /session:\/\/old-session/);
	assert.match(JSON.stringify(sent.content), /reference material/);
	assert.equal(withSessionReferences(message, []), message);
});
