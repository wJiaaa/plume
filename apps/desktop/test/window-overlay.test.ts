/**
 * Windows、Linux 上系统画在页面右上角那几颗按钮的颜色跟着遮罩变暗（renderer/window-overlay-colors.ts）。
 *
 * 在 Windows 11 上开着确认框量过：遮罩底下的页面是 #bfbfbf，角上最小化、最大化、关闭那一块还是 #f3f3f3——
 * 屏幕上最亮的一块，因为它画在页面之外，颜色是主题上一次给的。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tintedOverlay } from "../src/renderer/window-overlay-colors.ts";

const LIGHT = { color: "#f3f3f3", symbolColor: "#9a9a9a" };
const read = (...parts: string[]) => readFileSync(join(import.meta.dirname, "..", ...parts), "utf8");

test("对话框的遮罩底下，带子和符号和周围的页面一样暗", () => {
	const tinted = tintedOverlay(LIGHT, [{ color: "#000000", alpha: 0.22 }]);
	assert.equal(tinted.color, "#bebebe", "243 × 0.78");
	assert.equal(tinted.symbolColor, "#787878");
	assert.deepEqual(tintedOverlay(LIGHT, []), LIGHT);
});

test("重遮罩底下带子变暗，符号按深色主题的样子画，还读得清", () => {
	// 看图器的 72%：符号跟着一起变暗的话是 #444444 上的 #2b2b2b。
	const viewer = tintedOverlay(LIGHT, [{ color: "#000000", alpha: 0.72 }]);
	assert.deepEqual(viewer, { color: "#444444", symbolColor: "#b4b4b4" });
	const video = tintedOverlay(LIGHT, [{ color: "#000000", alpha: 1 }]);
	assert.deepEqual(video, { color: "#000000", symbolColor: "#999999" });
});

test("不是 #rrggbb 的颜色原样留着，不混出一个错的", () => {
	assert.deepEqual(tintedOverlay({ color: "transparent", symbolColor: "#9a9a9a" }, [{ color: "#000000", alpha: 0.22 }]), {
		color: "transparent",
		symbolColor: "#787878",
	});
});

test("系统按钮的底色量的就是那条带子：送出去的颜色和它画的是同一处", () => {
	/*
	 * 两边各有出处就会差色，窗口右上角浮出一块深浅不同的补丁。这里守的是「从带子本身量」：
	 * `useWindowOverlay` 读的是传进来的那个元素，而 `WindowHeader` 传的是自己。
	 */
	const header = read("src", "renderer", "window-controls.tsx");
	assert.match(header, /useWindowOverlay\(band, symbol\)/);
	assert.match(header, /ref=\{band\}/);
	const overlay = read("src", "renderer", "window-overlay.ts");
	assert.match(overlay, /getComputedStyle\(header\.current\)\.backgroundColor/);
});

test("主进程改按钮颜色时高度和建窗时是同一个常量，换一次主题按钮不会变大小", () => {
	const main = read("src", "main", "window-overlay.ts");
	assert.match(main, /setTitleBarOverlay\(\{ color, symbolColor, height: NATIVE_HEADER_HEIGHT \}\)/);
	const chrome = read("src", "shared", "window-chrome.ts");
	assert.match(chrome, /titleBarOverlay: \{ color, height: NATIVE_HEADER_HEIGHT \}/);
});
