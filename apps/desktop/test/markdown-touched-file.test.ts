/**
 * 回复里的相对路径对上这场对话碰过的文件：对上唯一一个就当场画成签，不等磁盘。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { touchedFile } from "../src/renderer/markdown/touched-file.ts";

const cwd = "/repo";

test("裸名字和带一截目录的写法都对得上碰过的文件", () => {
	const paths = ["packages/core/src/approvals.ts", "/repo/README.md"];
	assert.equal(touchedFile(paths, cwd, [cwd], "approvals.ts"), "/repo/packages/core/src/approvals.ts");
	assert.equal(touchedFile(paths, cwd, [cwd], "src/approvals.ts"), "/repo/packages/core/src/approvals.ts");
	assert.equal(touchedFile(paths, cwd, [cwd], "./README.md"), "/repo/README.md");
});

test("对上不止一个、或一个都没有，交回去找", () => {
	const paths = ["a/index.ts", "b/index.ts"];
	assert.equal(touchedFile(paths, cwd, [cwd], "index.ts"), null);
	assert.equal(touchedFile(paths, cwd, [cwd], "other.ts"), null);
	// 名字的一部分不算：`dex.ts` 不是 `index.ts`。
	assert.equal(touchedFile(["a/index.ts"], cwd, [cwd], "dex.ts"), null);
});

test("工作目录外的文件不认，文件夹不认", () => {
	assert.equal(touchedFile(["/elsewhere/a.ts"], cwd, [cwd], "a.ts"), null);
	assert.equal(touchedFile(["src/a.ts"], cwd, [cwd], "src/"), null);
});
