import assert from "node:assert/strict";
import test from "node:test";
import { matchingToolCards } from "../src/renderer/tool-card-matching.ts";

test("精确卡片优先于动态工具族；前缀按 order、注册顺序排列并能撤销", () => {
	const exactCard = { order: 100, seq: 0 };
	const family = { order: 0, seq: 1 };
	const override = { order: -1, seq: 2 };
	const later = { order: 0, seq: 3 };
	const exact = new Map([["mcp__docs__read", [exactCard]]]);
	const prefixes = new Map([
		["mcp__", [family]],
		["mcp__docs__", [override, later]],
	]);
	assert.deepEqual(matchingToolCards("mcp__docs__read", exact, prefixes), [exactCard, override, later, family]);
	assert.deepEqual(matchingToolCards("mcp__other__read", exact, prefixes), [family]);
	assert.deepEqual(matchingToolCards("read", exact, prefixes), []);
	prefixes.delete("mcp__docs__");
	assert.deepEqual(matchingToolCards("mcp__docs__read", exact, prefixes), [exactCard, family]);
	prefixes.clear();
	assert.deepEqual(matchingToolCards("mcp__other__read", exact, prefixes), []);
});
