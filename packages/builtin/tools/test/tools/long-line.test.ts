/**
 * 长行的字符窗口：窗口落在命中处而不是行首，UTF-8 字节偏移换算成字符下标。
 */

import { expect, it } from "vitest";
import { charWindow, formatCharWindow, matchWindow, utf8ByteOffsetsToIndices } from "../../src/tools/long-line.ts";

it("从第 2000 个字之后开的窗口里仍有要找的字", () => {
	const needle = "NEEDLE";
	const text = `${"a".repeat(80_000)}${needle}${"b".repeat(80_000)}`;
	const window = charWindow(text, 79_900);
	expect(window.text.includes(needle)).toBe(true);
	expect(window.start >= 79_000).toBe(true);
	expect(window.end - window.start <= 2000).toBe(true);
});

it("命中窗口优先落在命中处，不是行首", () => {
	const needle = "MID-LINE-NEEDLE";
	const text = `${"a".repeat(80_000)}${needle}${"b".repeat(80_000)}`;
	const window = matchWindow(text, needle);
	expect(window.text.includes(needle)).toBe(true);
	expect(window.start > 0, "不能是行首").toBe(true);
	expect(formatCharWindow(text, window.start)).toMatch(/char_offset=/);
});

it("UTF-8 字节偏移对 ASCII、中日韩字符和表情落在 JS indexOf 的同一个字上，不管给的先后", () => {
	const text = "ab中c😀d";
	expect(utf8ByteOffsetsToIndices(text, [5, 0, 2, 10])).toEqual([3, 0, 2, text.indexOf("d")]);
});
