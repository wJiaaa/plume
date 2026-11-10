/**
 * 窗口顶行两端各让给系统多少（renderer/titlebar.ts），以及哪些平台顶上另有一条带子（shared/window-chrome.ts）。
 *
 * 系统按钮画在页面上方，文档里量不到，每个数都只能定下来。定错了不难发现：Windows 上卡片的按钮压在关闭按钮底下，
 * 画得出来却按不动；侧栏开关在左端白让 86px，给只有 macOS 才有的红绿灯。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { hasHeaderBar, NATIVE_HEADER_HEIGHT, TOOLBAR_EDGE, TOP_ROW_HEIGHT, TRAFFIC_LIGHTS_END, windowChrome } from "../src/shared/window-chrome.ts";
import { OVERLAY_FALLBACK, overlayReserved, titlebarInsets } from "../src/renderer/titlebar.ts";

/** 两端都没有系统按钮。 */
const NONE = { start: 0, end: 0 };

test("macOS 在左端给红绿灯留位，右端不留", () => {
	assert.deepEqual(titlebarInsets("darwin", false, NONE), { start: TRAFFIC_LIGHTS_END, end: 0 });
});

test("原生全屏不画红绿灯，留的位也跟着收回", () => {
	assert.deepEqual(titlebarInsets("darwin", true, NONE), { start: TOOLBAR_EDGE, end: 0 });
});

test("Windows 从窗口边距开始，右端让开系统按钮", () => {
	assert.deepEqual(titlebarInsets("win32", false, { start: 0, end: 138 }), { start: TOOLBAR_EDGE, end: 138 });
});

test("Linux 和 Windows 一样：右端一块 overlay，左端什么都没有", () => {
	assert.deepEqual(titlebarInsets("linux", false, { start: 0, end: 92 }), { start: TOOLBAR_EDGE, end: 92 });
});

test("overlay 报多宽就让多宽：显示缩放会改它，不是固定的三颗按钮", () => {
	assert.deepEqual(titlebarInsets("win32", false, { start: 0, end: 207 }), { start: TOOLBAR_EDGE, end: 207 });
});

test("overlay 看不见时什么都不让：Windows 全屏时不画系统按钮", () => {
	assert.deepEqual(overlayReserved({ visible: false, getTitlebarAreaRect: () => ({ x: 0, right: 0, width: 0 }) }, 1200), NONE);
	assert.deepEqual(overlayReserved(undefined, 1200), NONE);
});

test("系统占的是留给页面那一段以外的部分", () => {
	const overlay = { visible: true, getTitlebarAreaRect: () => ({ x: 0, right: 1062, width: 1062 }) };
	assert.deepEqual(overlayReserved(overlay, 1200), { start: 0, end: 138 });
});

test("overlay 开着但还没量出大小时先按常见的宽度让，不当成什么都不用让", () => {
	// 第一次几何信息到达之前 Chromium 回的是全 0 的矩形；当成不用让，那一刻卡片的控件就压在关闭按钮底下。
	const overlay = { visible: true, getTitlebarAreaRect: () => ({ x: 0, right: 0, width: 0 }) };
	assert.deepEqual(overlayReserved(overlay, 1200), { start: 0, end: OVERLAY_FALLBACK });
});

test("矩形比窗口还宽时不让出负数", () => {
	const overlay = { visible: true, getTitlebarAreaRect: () => ({ x: 0, right: 1400, width: 1400 }) };
	assert.deepEqual(overlayReserved(overlay, 1200), NONE);
});

test("Linux 把窗口按钮放在左边时，顶行从它们后面开始", () => {
	const overlay = { visible: true, getTitlebarAreaRect: () => ({ x: 96, right: 1200, width: 1104 }) };
	assert.deepEqual(overlayReserved(overlay, 1200), { start: 96, end: 0 });
	assert.deepEqual(titlebarInsets("linux", false, { start: 96, end: 0 }), { start: 96, end: 0 });
});

test("两端都有按钮就两端都让", () => {
	const overlay = { visible: true, getTitlebarAreaRect: () => ({ x: 40, right: 1130, width: 1090 }) };
	assert.deepEqual(overlayReserved(overlay, 1200), { start: 40, end: 70 });
	assert.deepEqual(titlebarInsets("linux", false, { start: 40, end: 70 }), { start: 40, end: 70 });
});

test("只有 macOS 没有顶上那条带子", () => {
	assert.equal(hasHeaderBar("darwin"), false);
	assert.equal(hasHeaderBar("win32"), true);
	assert.equal(hasHeaderBar("linux"), true);
});

test("macOS 的窗口外壳一点没变：只留红绿灯，没有 overlay", () => {
	const chrome = windowChrome("darwin", "#f8f8f8");
	assert.equal(chrome.titleBarStyle, "hiddenInset");
	assert.ok(chrome.trafficLightPosition);
	assert.equal(chrome.titleBarOverlay, undefined);
});

test("Windows、Linux 隐藏系统标题栏，系统按钮的高度和带子是同一个数，不是红绿灯的 44", () => {
	for (const platform of ["win32", "linux"]) {
		const chrome = windowChrome(platform, "#171717");
		assert.equal(chrome.titleBarStyle, "hidden");
		assert.equal(chrome.trafficLightPosition, undefined);
		assert.deepEqual(chrome.titleBarOverlay, { color: "#171717", height: NATIVE_HEADER_HEIGHT });
	}
	assert.equal(NATIVE_HEADER_HEIGHT, 32);
	assert.notEqual(NATIVE_HEADER_HEIGHT, TOP_ROW_HEIGHT);
});
