import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiffLine } from "../src/api.ts";
import { MESSAGES } from "../src/messages.ts";
import { commentPlace, diffCommentPrompt, diffComments } from "../src/panel/diff-comments.ts";
import type { Translate } from "../src/panel/i18n.ts";

const t: Translate = (key, variables) => {
	const message = MESSAGES["zh-CN"][key];
	const template = typeof message === "string" ? message : message.other;
	return template.replace(/\{([^}]+)\}/g, (match, name: string) => String(variables?.[name] ?? match));
};

const add = (newLine: number, text: string): DiffLine => ({ type: "add", text, newLine });
const remove = (oldLine: number, text: string): DiffLine => ({ type: "remove", text, oldLine });

test("diffComments：按文件、再按行排，改一条不换位置以外的东西，清掉整个仓库", () => {
	const cwd = "/repo-sort";
	diffComments.save(cwd, { path: "b.ts", lines: [add(3, "b")], text: "第二个文件" });
	diffComments.save(cwd, { path: "a.ts", lines: [add(9, "late")], text: "后面" });
	diffComments.save(cwd, { path: "a.ts", lines: [add(2, "early")], text: "前面" });
	assert.deepEqual(
		diffComments.get(cwd).map((comment) => comment.text),
		["前面", "后面", "第二个文件"],
	);

	const [first] = diffComments.get(cwd);
	diffComments.save(cwd, { id: first!.id, path: "a.ts", lines: first!.lines, text: "改过" });
	assert.equal(diffComments.get(cwd)[0]?.text, "改过");
	assert.equal(diffComments.get(cwd)[0]?.id, first!.id);

	diffComments.remove(cwd, first!.id);
	assert.equal(diffComments.get(cwd).length, 2);
	diffComments.clear(cwd);
	assert.deepEqual(diffComments.get(cwd), []);
});

test("diffComments：只通知订阅者，取消以后不再通知", () => {
	let calls = 0;
	const stop = diffComments.subscribe(() => calls++);
	diffComments.save("/repo-listen", { path: "a.ts", lines: [add(1, "x")], text: "x" });
	stop();
	diffComments.clear("/repo-listen");
	assert.equal(calls, 1);
});

test("commentPlace：新行号写成区间，只评了删掉的行时说是改动前的第几行", () => {
	assert.equal(commentPlace(t, { path: "a.ts", lines: [add(12, "x"), add(14, "y")] }), "a.ts:12-14");
	assert.equal(commentPlace(t, { path: "a.ts", lines: [remove(5, "x")] }), "a.ts 改动前的第 5 行");
});

test("diffCommentPrompt：带工作区、序号、unified 前缀，围栏比代码里的反引号长", () => {
	const prompt = diffCommentPrompt(t, "/repo", [
		{ id: "1", path: "a.ts", lines: [remove(3, "old"), add(3, "new ```")], text: " 换个名字 " },
		{ id: "2", path: "b.ts", lines: [{ type: "context", text: "same", oldLine: 1, newLine: 1 }], text: "这里也是" },
	]);
	assert.equal(
		prompt,
		[
			"按下面这几条评论改代码，每条附着评论的那几行 diff：",
			'工作区: "/repo"',
			"(1) `a.ts:3`\n````diff\n-old\n+new ```\n````\n换个名字",
			"(2) `b.ts:1`\n```diff\n same\n```\n这里也是",
		].join("\n\n"),
	);
});
