import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanAppearance, patchAppearance, resetAppearancePatch, type Appearance } from "../src/shared/appearance.ts";
import { codePalette } from "../src/renderer/code-appearance.ts";
import { DARK_CODE_THEMES, LIGHT_CODE_THEMES, findCodeTheme } from "../../../packages/client/ui/src/lib/code/themes.ts";

test("外观校验保留合法偏好，夹紧尺寸，拒绝非有限数和非法值", () => {
	assert.deepEqual(
		cleanAppearance({
			pointerCursor: true,
			reduceMotion: "off",
			vibrancy: false,
			uiFontSize: 30,
			codeFontSize: 2,
			codeLineHeight: 9,
			codeLetterSpacing: -2,
			inlineCode: "custom",
			inlineCodeBorder: true,
			inlineCodeLightBg: "#aabbcc",
			codeDarkTheme: "github-dark",
			codeLightTheme: "<style>",
			codeFont: "",
			uiFont: 42,
			accent: "red",
			unknown: true,
		}),
		{
			inlineCodeLightBg: "#AABBCC",
			uiFontSize: 20,
			codeFontSize: 10,
			codeLineHeight: 3,
			codeLetterSpacing: -0.1,
			pointerCursor: true,
			reduceMotion: "off",
			vibrancy: false,
			inlineCode: "custom",
			inlineCodeBorder: true,
			codeDarkTheme: "github-dark",
		},
	);
	assert.deepEqual(cleanAppearance({ uiFontSize: NaN, codeFontSize: Infinity, codeLineHeight: -Infinity, reduceMotion: true, pointerCursor: "true" }), {});
});

test("外观补丁能往返 JSON，并按范围恢复默认", () => {
	const original: Appearance = {
		theme: "dark",
		accent: "#AABBCC",
		uiFontSize: 17,
		pointerCursor: true,
		reduceMotion: "on",
		vibrancy: false,
		codeLightTheme: "solarized-light",
		codeDarkTheme: "github-dark",
		codeFont: '"Menlo", monospace',
		codeFontSize: 15,
		codeLineHeight: 1.8,
		codeLetterSpacing: 0.02,
		inlineCode: "custom",
		inlineCodeLightBg: "#FFEEDD",
		inlineCodeLightFg: "#112233",
		inlineCodeDarkBg: "#112233",
		inlineCodeDarkFg: "#FFEEDD",
		inlineCodeBorder: true,
		chatBackground: "chat-123.png",
	};
	assert.deepEqual(cleanAppearance(JSON.parse(JSON.stringify(original))), original);
	const resetCode = patchAppearance(original, resetAppearancePatch(original, true));
	assert.deepEqual(resetCode, {
		theme: "dark",
		accent: "#AABBCC",
		uiFontSize: 17,
		pointerCursor: true,
		reduceMotion: "on",
		vibrancy: false,
		chatBackground: "chat-123.png",
	});
	assert.deepEqual(patchAppearance(original, resetAppearancePatch(original)), {});
	assert.deepEqual(patchAppearance({ uiFontSize: 16 }, { uiFontSize: null }), {});
});

test("未选择主题不压过皮肤，指定主题覆盖底色字色和语法", () => {
	assert.deepEqual(codePalette({}, findCodeTheme(undefined, "light"), false), {});
	const theme = findCodeTheme("solarized-light", "light");
	const palette = codePalette({ codeLightTheme: theme.id }, theme, false);
	assert.equal(palette["code-bg"], theme.background);
	assert.equal(palette["code-fg"], theme.foreground);
	assert.equal(palette["syntax-operator"], theme.tokens?.operator);
	assert.equal(palette["diff-add"], theme.addedBg);
	const inherited = codePalette({ codeDarkTheme: "plume-dark" }, findCodeTheme("plume-dark", "dark"), true);
	assert.equal(inherited["code-bg"], "var(--plume-bg)");
	assert.equal(inherited["code-fg"], "var(--plume-ink)");
});

test("行内代码三档、深浅自定义颜色与描边互相独立", () => {
	const theme = findCodeTheme(undefined, "dark");
	assert.equal(codePalette({ inlineCode: "app" }, theme, true)["inline-code-bg"], "var(--plume-card-hover)");
	assert.equal(codePalette({ inlineCode: "syntax" }, theme, true)["inline-code-fg"], "var(--plume-code-fg)");
	const appearance: Appearance = { inlineCode: "custom", inlineCodeDarkBg: "#112233", inlineCodeLightBg: "#FFEEDD", inlineCodeBorder: true };
	assert.equal(codePalette(appearance, theme, true)["inline-code-bg"], "#112233");
	assert.equal(codePalette(appearance, theme, false)["inline-code-bg"], "#FFEEDD");
	assert.match(codePalette(appearance, theme, true)["inline-code-ring"]!, /22%/);
	assert.equal(codePalette({ inlineCodeBorder: false }, theme, true)["inline-code-ring"], "transparent");
});

test("所有代码主题数据完整、标识唯一且模式匹配", () => {
	assert.equal(LIGHT_CODE_THEMES.length, 9);
	assert.equal(DARK_CODE_THEMES.length, 10);
	const themes = [...LIGHT_CODE_THEMES, ...DARK_CODE_THEMES];
	assert.equal(new Set(themes.map((theme) => theme.id)).size, themes.length);
	for (const theme of themes) {
		assert.equal(findCodeTheme(theme.id, theme.mode), theme);
		assert.match(theme.background!, /^#[\da-f]{6}$/i);
		assert.match(theme.foreground!, /^#[\da-f]{6}$/i);
		assert.equal(Object.keys(theme.tokens!).length, 11);
		assert.ok(theme.addedBg && theme.removedBg);
	}
	assert.equal(findCodeTheme("missing", "light").id, "plume-light");
});
