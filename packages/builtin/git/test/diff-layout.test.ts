import assert from "node:assert/strict";
import { test } from "vitest";
import type { DiffFile } from "../src/api.ts";
import { buildCompactTree, formatStatCount, splitPath } from "../src/panel/diff-layout.ts";

test("splitPath：拆分目录和文件名，保留未跟踪目录末尾斜杠", () => {
	assert.deepEqual(splitPath(".gitignore"), { dir: "", name: ".gitignore" });
	assert.deepEqual(splitPath("tests/FooCheck.java"), { dir: "tests/", name: "FooCheck.java" });
	assert.deepEqual(splitPath("a/b/c.ts"), { dir: "a/b/", name: "c.ts" });
	assert.deepEqual(splitPath("untracked/"), { dir: "", name: "untracked/" });
	assert.deepEqual(splitPath("a/untracked/"), { dir: "a/", name: "untracked/" });
});

test("formatStatCount：万以内精确展示，大数缩写", () => {
	assert.equal(formatStatCount(5), "5");
	assert.equal(formatStatCount(391), "391");
	assert.equal(formatStatCount(9999), "9999");
	assert.equal(formatStatCount(12_340), "12.3k");
	assert.equal(formatStatCount(120_000), "120k");
});

test("buildCompactTree：压缩单子目录链并汇总目录增删行数", () => {
	const files: DiffFile[] = [
		{ path: "packages/builtin/git/src/a.ts", status: "modified", added: 10, removed: 3, hunks: [] },
		{ path: "packages/builtin/git/src/b.ts", status: "added", added: 20, removed: 0, hunks: [] },
		{ path: "README.md", status: "modified", added: 2, removed: 1, hunks: [] },
	];
	const tree = buildCompactTree(files);
	assert.equal(tree.children.length, 2);
	const folder = tree.children[0]!;
	assert.equal(folder.isFile, false);
	assert.equal(folder.name, "packages/builtin/git/src");
	assert.equal(folder.added, 30);
	assert.equal(folder.removed, 3);
	assert.equal(folder.fileCount, 2);
	assert.equal(tree.children[1]?.name, "README.md");
});
