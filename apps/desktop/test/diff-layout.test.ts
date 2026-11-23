import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChangeHunk, ChangeLine } from "@plume/contract";
import {
	computeInlineDiff,
	computeUnifiedInlineDiffs,
	isSingleSidedDiff,
	mergeInlineTokens,
	pairSplitHunk,
} from "../src/renderer/conversation/detail/diff-layout.ts";

test("isSingleSidedDiff：纯新增或纯删除返回真，混合或含上下文返回假", () => {
	const pureAdd: ChangeHunk[] = [
		{
			oldStart: 0,
			newStart: 1,
			lines: [
				{ type: "add", text: "a", newLine: 1 },
				{ type: "add", text: "b", newLine: 2 },
			],
		},
	];
	const pureRemove: ChangeHunk[] = [
		{
			oldStart: 1,
			newStart: 0,
			lines: [{ type: "remove", text: "old", oldLine: 1 }],
		},
	];
	const mixed: ChangeHunk[] = [
		{
			oldStart: 1,
			newStart: 1,
			lines: [
				{ type: "remove", text: "old", oldLine: 1 },
				{ type: "add", text: "new", newLine: 1 },
			],
		},
	];
	const withContext: ChangeHunk[] = [
		{
			oldStart: 1,
			newStart: 1,
			lines: [
				{ type: "context", text: "same", oldLine: 1, newLine: 1 },
				{ type: "add", text: "new", newLine: 2 },
			],
		},
	];
	assert.equal(isSingleSidedDiff(pureAdd), true);
	assert.equal(isSingleSidedDiff(pureRemove), true);
	assert.equal(isSingleSidedDiff(mixed), false);
	assert.equal(isSingleSidedDiff(withContext), false);
	assert.equal(isSingleSidedDiff([]), false);
});

test("computeInlineDiff：标出公共前后缀中间的改动，完全不同或相同不标", () => {
	const diff = computeInlineDiff("const count = 1;", "const count = 2;");
	assert.deepEqual(diff, {
		oldParts: [
			{ text: "const count = ", changed: false },
			{ text: "1", changed: true },
			{ text: ";", changed: false },
		],
		newParts: [
			{ text: "const count = ", changed: false },
			{ text: "2", changed: true },
			{ text: ";", changed: false },
		],
	});
	assert.equal(computeInlineDiff("same", "same"), null);
	assert.equal(computeInlineDiff("abcdef", "uvwxyz"), null);
});

test("computeUnifiedInlineDiffs：连续删/加块按对标注行内改动", () => {
	const lines: ChangeLine[] = [
		{ type: "context", text: "function f() {", oldLine: 1, newLine: 1 },
		{ type: "remove", text: "  return oldVal;", oldLine: 2 },
		{ type: "add", text: "  return newVal;", newLine: 2 },
		{ type: "context", text: "}", oldLine: 3, newLine: 3 },
	];
	const map = computeUnifiedInlineDiffs(lines);
	assert.equal(map.has(0), false);
	assert.equal(map.has(1), true);
	assert.equal(map.has(2), true);
	assert.equal(
		map.get(1)?.some((p) => p.changed && p.text === "old"),
		true,
	);
	assert.equal(
		map.get(2)?.some((p) => p.changed && p.text === "new"),
		true,
	);
});

test("pairSplitHunk：并排对齐删除与新增，不对称处补空且保留原始行序号", () => {
	const lines: ChangeLine[] = [
		{ type: "context", text: "a", oldLine: 1, newLine: 1 },
		{ type: "remove", text: "old1", oldLine: 2 },
		{ type: "add", text: "new1", newLine: 2 },
		{ type: "add", text: "new2", newLine: 3 },
	];
	const rows = pairSplitHunk(lines);
	assert.equal(rows.length, 3);
	assert.equal(rows[0]?.left?.line.text, "a");
	assert.equal(rows[0]?.right?.line.text, "a");
	assert.equal(rows[1]?.left?.lineIndex, 1);
	assert.equal(rows[1]?.right?.lineIndex, 2);
	assert.equal(rows[2]?.left, null);
	assert.equal(rows[2]?.right?.lineIndex, 3);
});

test("mergeInlineTokens：按行内差异切分语法片段并保留各自类名", () => {
	const tokens = [
		{ text: "return ", className: "tok-kw" },
		{ text: "oldVal", className: "tok-var" },
		{ text: ";", className: "tok-punc" },
	];
	const parts = [
		{ text: "return ", changed: false },
		{ text: "old", changed: true },
		{ text: "Val;", changed: false },
	];
	assert.deepEqual(mergeInlineTokens(tokens, parts), [
		{ changed: false, tokens: [{ text: "return ", className: "tok-kw" }] },
		{ changed: true, tokens: [{ text: "old", className: "tok-var" }] },
		{
			changed: false,
			tokens: [
				{ text: "Val", className: "tok-var" },
				{ text: ";", className: "tok-punc" },
			],
		},
	]);
});
