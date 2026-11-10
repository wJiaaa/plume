/**
 * 回复里指着本机文件的链接：地址拆成路径和行号、签上写什么、哪些行内代码算路径。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileLinkCaption, filePathInCode, filePathInUrl, splitLineSuffix } from "../src/renderer/markdown/file-link.ts";

test("写成路径的文字，签上留文件名，路径进提示", () => {
	const long = "docs/issue/2026-09-16-2220-01-tasklist-false-paused-on-unfinished-plan.md";
	assert.deepEqual(fileLinkCaption(long, `/tmp/${long}`), {
		text: "2026-09-16-2220-01-tasklist-false-paused-on-unfinished-plan.md",
		tip: long,
		lines: null,
		line: null,
	});
});

test("人写的说明留在签上", () => {
	assert.deepEqual(fileLinkCaption("实现说明", "/project/docs/result.md"), {
		text: "实现说明",
		tip: "/project/docs/result.md",
		lines: null,
		line: null,
	});
});

test("裸文件名不动", () => {
	assert.deepEqual(fileLinkCaption("README.md", "/project/README.md"), {
		text: "README.md",
		tip: "README.md",
		lines: null,
		line: null,
	});
});

test("链接地址上的行号画在文件名后面，打开时也带着", () => {
	assert.deepEqual(fileLinkCaption("SopEventHandler.java", "/p/SopEventHandler.java", { from: 88, to: 88 }), {
		text: "SopEventHandler.java",
		tip: "SopEventHandler.java:88",
		lines: { from: 88, to: 88 },
		line: "88",
	});
	// 行内代码 `src/a.ts:3-9`：文字和地址是同一串，行号只画一次。
	assert.deepEqual(fileLinkCaption("src/a.ts:3-9", "/p/src/a.ts", { from: 3, to: 9 }), {
		text: "a.ts",
		tip: "src/a.ts:3-9",
		lines: { from: 3, to: 9 },
		line: "3-9",
	});
});

test("只写在文字上的行号也算，但只在文字是路径时", () => {
	assert.deepEqual(fileLinkCaption("a.ts:42", "/p/a.ts").lines, { from: 42, to: 42 });
	assert.deepEqual(fileLinkCaption("端口 8080:3000", "/p/a.ts"), { text: "端口 8080", tip: "/p/a.ts", lines: null, line: null });
});

test("人写的说明保留原文，行号只进提示", () => {
	assert.deepEqual(fileLinkCaption("入口逻辑", "/p/a.ts", { from: 42, to: 42 }), {
		text: "入口逻辑",
		tip: "/p/a.ts:42",
		lines: { from: 42, to: 42 },
		line: null,
	});
});

test("行号后缀从路径上拆下；:0 不算行号，倒着写的范围按正序读", () => {
	assert.deepEqual(splitLineSuffix("src/a.ts:42"), { path: "src/a.ts", lines: { from: 42, to: 42 } });
	assert.deepEqual(splitLineSuffix("/abs/a.ts:50-42"), { path: "/abs/a.ts", lines: { from: 42, to: 50 } });
	assert.deepEqual(splitLineSuffix("a.ts:0"), { path: "a.ts", lines: null });
	assert.deepEqual(splitLineSuffix("C:\\repo\\a.ts"), { path: "C:\\repo\\a.ts", lines: null });
});

test("GitHub 的行锚点算行号；别的锚点去掉，目录名里的 # 留着", () => {
	assert.deepEqual(splitLineSuffix("backend/pricing.go#L449"), { path: "backend/pricing.go", lines: { from: 449, to: 449 } });
	assert.deepEqual(splitLineSuffix("a.ts#L50-L42"), { path: "a.ts", lines: { from: 42, to: 50 } });
	assert.deepEqual(splitLineSuffix("docs/routing.md#long_context_pricing"), { path: "docs/routing.md", lines: null });
	assert.deepEqual(splitLineSuffix("src/C#/a.cs"), { path: "src/C#/a.cs", lines: null });
});

test("写着文件的行内代码认出来，行号后缀保留", () => {
	for (const path of ["src/runBatch.js", "test/runBatch.test.js", "README.md", "packages/core/src/prompt/system.ts:148", "/Users/me/app/index.ts:3-9"]) {
		assert.equal(filePathInCode(path), path);
	}
	// 带目录的相对路径不论像不像文件都交出去，由 `Link` 去磁盘上确认：`origin/main` 找不到，就留作代码。
	for (const path of ["src/", "packages/ui/src", ".github/workflows", "origin/main", "feature/v1.2"]) {
		assert.equal(filePathInCode(path), path);
	}
	for (const code of [
		"runBatch",
		"node:test",
		"npm test",
		'"type": "module"',
		"console.log",
		"process.env",
		"foo.bar()",
		"/Users/me/app/",
		"/usr/local/bin",
		"a//b",
		"~/notes",
		"https://example.com/a.js",
	]) {
		assert.equal(filePathInCode(code), null, code);
	}
});

test("本机的 file:// 地址读成路径；共享和别的协议不算", () => {
	assert.equal(filePathInUrl("file:///Users/a/dist/index.js"), "/Users/a/dist/index.js");
	assert.equal(filePathInUrl("file://localhost/Users/a/b.md"), "/Users/a/b.md");
	// 盘符前那道斜杠属于地址。
	assert.equal(filePathInUrl("file:///C:/proj/a.ts"), "C:/proj/a.ts");
	// 不解码：`resolveAsset` 会解一次。
	assert.equal(filePathInUrl("file:///Users/a/my%20notes.md"), "/Users/a/my%20notes.md");
	assert.equal(filePathInUrl("file://server/share/a.md"), null);
	assert.equal(filePathInUrl("https://example.com/a.md"), null);
	assert.equal(filePathInUrl("/Users/a/b.md"), null);
});
