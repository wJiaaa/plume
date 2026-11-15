import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseNotesProblems } from "../check-release-notes.mjs";

const changelog = (body: string) => `# 更新日志\n\n## [0.6.0] - 2026-11-20\n\n${body}\n\n## [0.5.0] - 2026-11-15\n\n<!-- plume:notes en -->\nold\n`;

test("中英两段都写了才算写完", () => {
	assert.deepEqual(releaseNotesProblems(changelog("<!-- plume:notes en -->\n### Changes\n- a\n\n<!-- plume:notes zh-CN -->\n### 改动\n- 甲"), "0.6.0"), []);
});

test("只有 git-cliff 生成的提交列表时两段都缺", () => {
	assert.equal(releaseNotesProblems(changelog("### Features\n\n- **core:** 加了一样东西"), "0.6.0").length, 2);
});

test("标记要独占一行、后面要有内容，不看别的版本那一节", () => {
	const problems = releaseNotesProblems(changelog("说到 <!-- plume:notes en --> 的一句\n<!-- plume:notes zh-CN -->\n"), "0.6.0");
	assert.deepEqual(problems, ["0.6.0 这一节没有 <!-- plume:notes en --> 那一段", "0.6.0 这一节的 <!-- plume:notes zh-CN --> 那一段是空的"]);
	assert.deepEqual(releaseNotesProblems(changelog(""), "0.7.0"), ["CHANGELOG.md 里没有 0.7.0 这一节"]);
});
