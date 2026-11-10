import assert from "node:assert/strict";
import { test } from "node:test";
import { readableInk } from "../src/renderer/settings/readable-ink.ts";
import { CODE_FONTS, codeFontMenu, matchCodeFont } from "../src/renderer/settings/code-fonts.ts";

function luminance(hex: string): number {
	const channels = [1, 3, 5].map((start) => {
		const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

test("自动行内字色在饱和黄、橄榄绿和灰阶上仍满足正文对比度", () => {
	for (const background of ["#D6C300", "#828C0A", "#B34700", "#777777", "#FFFFFF", "#000000", "#FFDDEE"]) {
		const foreground = readableInk(background);
		const bright = Math.max(luminance(background), luminance(foreground));
		const dim = Math.min(luminance(background), luminance(foreground));
		assert.ok((bright + 0.05) / (dim + 0.05) >= 4.5, `${background} / ${foreground}`);
	}
});

test("字体菜单识别系统栈与本机字体，卸载后仍保留当前选择", () => {
	const system = CODE_FONTS[0]!;
	assert.equal(matchCodeFont(system.stack), system);
	const chosen = matchCodeFont('"Example Mono", ui-monospace, Menlo, "PingFang SC", monospace');
	assert.equal(chosen?.family, "Example Mono");
	assert.deepEqual(codeFontMenu({ families: new Set(), extra: [] }, chosen), [system, chosen]);
	assert.equal(matchCodeFont('"Custom Face", monospace'), null);
});
