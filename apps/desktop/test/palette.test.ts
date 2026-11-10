import assert from "node:assert/strict";
import { test } from "node:test";
import { rankEntries, scoreEntry } from "../src/renderer/sidebar/palette.ts";

test("命令名精确匹配高于会话里包含该词，同分保持最近顺序", () => {
	const entries = [{ label: "修复终端问题" }, { label: "终端" }, { label: "旧终端" }, { label: "另一个" }];
	assert.deepEqual(rankEntries(entries, "终端"), [entries[1], entries[0], entries[2]]);
	assert.equal(scoreEntry({ label: "Git", keywords: ["面板"] }, "git 面板"), 60);
	assert.equal(scoreEntry({ label: "深色", keywords: ["dark"] }, " DARK "), 110);
	assert.equal(scoreEntry({ label: "设置" }, "未知"), null);
	assert.deepEqual(rankEntries(entries, ""), entries);
});
