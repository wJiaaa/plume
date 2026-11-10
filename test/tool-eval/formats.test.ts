/**
 * 应用器决定一次编辑算不算通过，所以在跑任何模型之前先测它们。这里有 bug 的话，表现出来是某种格式「更差」——
 * 而那正是整个评测最不能误得的结论。
 *
 *   node --test --experimental-transform-types test/tool-eval/formats.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FORMATS, parseHunkText, snapshotTag } from "./formats.ts";

const FILE = "a\nb\nc\nd\ne\n";
const TAG = snapshotTag(FILE);

const hunkText = FORMATS["hunk-text"];
const hunkJson = FORMATS["hunk-json"];
const strReplace = FORMATS["str-replace"];
const production = FORMATS.production;

test("snapshotTag 稳定，且随内容变", () => {
	assert.equal(snapshotTag(FILE), snapshotTag(FILE));
	assert.notEqual(snapshotTag(FILE), snapshotTag("a\nb\nc\nd\nE\n"));
	assert.match(snapshotTag(FILE), /^[0-9A-F]{4}$/);
});

test("hunk-text：替换一行", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 2-2\n+B" }, FILE, TAG);
	assert.equal(r.ok, true);
	assert.equal(r.content, "a\nB\nc\nd\ne\n");
});

test("hunk-text：用不同行数替换一段", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 2-3\n+X\n+Y\n+Z" }, FILE, TAG);
	assert.equal(r.ok, true);
	assert.equal(r.content, "a\nX\nY\nZ\nd\ne\n");
});

test("hunk-text：INSERT AFTER，AFTER 0 是文件开头", async () => {
	assert.equal((await hunkText.apply({ path: "x", tag: TAG, patch: "INSERT AFTER 2\n+new" }, FILE, TAG)).content, "a\nb\nnew\nc\nd\ne\n");
	assert.equal((await hunkText.apply({ path: "x", tag: TAG, patch: "INSERT AFTER 0\n+top" }, FILE, TAG)).content, "top\na\nb\nc\nd\ne\n");
});

test("hunk-text：删除", async () => {
	assert.equal((await hunkText.apply({ path: "x", tag: TAG, patch: "DELETE 2-3" }, FILE, TAG)).content, "a\nd\ne\n");
});

test("hunk-text：行号是原始行号，几个 hunk 互不挪动", async () => {
	// 两段都写原始行号。从上往下天真地应用，第二段会落错地方。
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 1-1\n+A1\n+A2\nREPLACE 4-4\n+D" }, FILE, TAG);
	assert.equal(r.ok, true);
	assert.equal(r.content, "A1\nA2\nb\nc\nD\ne\n");
});

test("hunk-text：内容行原样保留行首空白", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 2-2\n+\t\tindented" }, FILE, TAG);
	assert.equal(r.content, "a\n\t\tindented\nc\nd\ne\n");
});

test("hunk-text：单独一个 + 是空行", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 2-2\n+\n+after blank" }, FILE, TAG);
	assert.equal(r.content, "a\n\nafter blank\nc\nd\ne\n");
});

test("hunk-text：过期的 tag 被拒", async () => {
	const r = await hunkText.apply({ path: "x", tag: "0000", patch: "REPLACE 2-2\n+B" }, FILE, TAG);
	assert.equal(r.ok, false);
	assert.match(r.error!, /stale tag/);
});

test("hunk-text：重叠的范围被拒", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 2-3\n+X\nREPLACE 3-4\n+Y" }, FILE, TAG);
	assert.equal(r.ok, false);
	assert.match(r.error!, /more than one hunk/);
});

test("hunk-text：越界被拒", async () => {
	assert.equal((await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 9-9\n+X" }, FILE, TAG)).ok, false);
	assert.equal((await hunkText.apply({ path: "x", tag: TAG, patch: "INSERT AFTER 99\n+X" }, FILE, TAG)).ok, false);
});

test("hunk-text：空内容的 REPLACE 被拒，不当成删除", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 2-2\n" }, FILE, TAG);
	assert.equal(r.ok, false);
	assert.match(r.error!, /use DELETE/);
});

test("hunk-text：没有操作头的内容行被拒", () => {
	const r = parseHunkText("+orphan");
	assert.equal(r.ok, false);
});

test("hunk-text：末尾有没有换行，两种都保持", async () => {
	assert.equal((await hunkText.apply({ path: "x", tag: snapshotTag("a\nb"), patch: "REPLACE 2-2\n+B" }, "a\nb", snapshotTag("a\nb"))).content, "a\nB");
	assert.equal((await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 5-5\n+E" }, FILE, TAG)).content, "a\nb\nc\nd\nE\n");
});

test("hunk-json：语义和 hunk-text 一样", async () => {
	const r = await hunkJson.apply(
		{
			path: "x",
			tag: TAG,
			hunks: [
				{ op: "replace", start: 1, end: 1, lines: ["A1", "A2"] },
				{ op: "delete", start: 4, end: 4 },
			],
		},
		FILE,
		TAG,
	);
	assert.equal(r.ok, true);
	assert.equal(r.content, "A1\nA2\nb\nc\ne\n");
});

test("hunk-json：没有 lines 的 replace 被拒", async () => {
	const r = await hunkJson.apply({ path: "x", tag: TAG, hunks: [{ op: "replace", start: 1, end: 1, lines: [] }] }, FILE, TAG);
	assert.equal(r.ok, false);
});

test("str-replace：唯一匹配时应用", async () => {
	assert.equal((await strReplace.apply({ path: "x", old_string: "b", new_string: "B" }, FILE, TAG)).content, "a\nB\nc\nd\ne\n");
});

test("str-replace：不加 replace_all 时多处匹配被拒", async () => {
	const dup = "x\nx\n";
	const r = await strReplace.apply({ path: "x", old_string: "x", new_string: "y" }, dup, TAG);
	assert.equal(r.ok, false);
	assert.match(r.error!, /not unique/);
	assert.equal((await strReplace.apply({ path: "x", old_string: "x", new_string: "y", replace_all: true }, dup, TAG)).content, "y\ny\n");
});

test("str-replace：找不到锚点被拒", async () => {
	assert.equal((await strReplace.apply({ path: "x", old_string: "nope", new_string: "y" }, FILE, TAG)).ok, false);
});

test("str-replace：新文字里的 $ 原样写入，不当成替换模式", async () => {
	assert.equal((await strReplace.apply({ path: "x", old_string: "b", new_string: "$&$1" }, FILE, TAG)).content, "a\n$&$1\nc\nd\ne\n");
});

// ---------------------------------------------------------------------------
// 回归：内容行漏了开头的 `+`
//
// 2026-09-04 在 gemini-2.5-flash-lite 上量的：hunk-text 最常见的失败是编辑本身对、只是漏了前缀。容忍它没有真实代价——
// 一行内容只有恰好符合操作头语法时才有歧义，源码行不会那样。
// ---------------------------------------------------------------------------

test("hunk-text：不带 + 的内容行照样能解析", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "INSERT AFTER 1\n\t\tconst startedAt = Date.now();" }, FILE, TAG);
	assert.equal(r.ok, true);
	assert.equal(r.content, "a\n\t\tconst startedAt = Date.now();\nb\nc\nd\ne\n");
});

test("hunk-text：带 + 和不带 + 的内容行混着", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 2-2\n+first\nsecond" }, FILE, TAG);
	assert.equal(r.content, "a\nfirst\nsecond\nc\nd\ne\n");
});

test("hunk-text：后面的操作头照样结束上一段内容", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 1-1\nA\nDELETE 3-3" }, FILE, TAG);
	assert.equal(r.ok, true);
	assert.equal(r.content, "A\nb\nd\ne\n");
});

test("hunk-text：末尾的空行不算内容", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 2-2\n+B\n\n" }, FILE, TAG);
	assert.equal(r.content, "a\nB\nc\nd\ne\n");
});

test("hunk-text：单独一个 + 仍是空行，不会被丢掉", async () => {
	const r = await hunkText.apply({ path: "x", tag: TAG, patch: "REPLACE 2-2\n+\n+x" }, FILE, TAG);
	assert.equal(r.content, "a\n\nx\nc\nd\ne\n");
});

// ---------------------------------------------------------------------------
// production：跑的是 plume.tools 真的 read 和 edit，这里只确认接线——判分拿到的是工具写进文件的内容和它报的错。
// ---------------------------------------------------------------------------

test("production：说明和参数取自 plume.tools 的 edit", () => {
	assert.equal(production.spec.name, "edit");
	assert.deepEqual(Object.keys(production.spec.parameters.properties ?? {}).sort(), ["new_string", "old_string", "path", "replace_all"]);
});

test("production：唯一匹配时写进文件", async () => {
	const r = await production.apply({ path: "src/x.ts", old_string: "b", new_string: "B" }, FILE, TAG);
	assert.equal(r.ok, true);
	assert.equal(r.content, "a\nB\nc\nd\ne\n");
});

test("production：多处匹配时报工具自己的错", async () => {
	const r = await production.apply({ path: "src/x.ts", old_string: "x", new_string: "y" }, "x\nx\n", TAG);
	assert.equal(r.ok, false);
	assert.match(r.error!, /appears 2 times/);
});
