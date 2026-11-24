import assert from "node:assert/strict";
import { test } from "vitest";
import { formatStatCount, splitPath } from "../src/diff/format.ts";

test("splitPath：拆分目录和文件名，保留未跟踪目录末尾斜杠", () => {
	assert.deepEqual(splitPath(".gitignore"), { dir: "", name: ".gitignore" });
	assert.deepEqual(splitPath("tests/FooCheck.java"), { dir: "tests", name: "FooCheck.java" });
	assert.deepEqual(splitPath("a/b/c.ts"), { dir: "a/b", name: "c.ts" });
	assert.deepEqual(splitPath("untracked/"), { dir: "", name: "untracked/" });
	assert.deepEqual(splitPath("a/untracked/"), { dir: "a", name: "untracked/" });
	assert.deepEqual(splitPath("src\\win\\x.ts"), { dir: "src\\win", name: "x.ts" });
});

test("formatStatCount：万以内精确展示，大数缩写", () => {
	assert.equal(formatStatCount(5), "5");
	assert.equal(formatStatCount(391), "391");
	assert.equal(formatStatCount(9999), "9999");
	assert.equal(formatStatCount(12_340), "12.3k");
	assert.equal(formatStatCount(120_000), "120k");
	assert.equal(formatStatCount(1_234_567), "1.2m");
});
