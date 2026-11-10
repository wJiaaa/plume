import assert from "node:assert/strict";
import { test } from "node:test";
import { panelArrangement, panelHeightFor, panelWidthFor, readPanelPrefs, readPanelTabs, writePanelTabs } from "../src/renderer/layout.ts";
import { panelGeometry } from "../src/renderer/panel-layout.ts";

const options = { width: 1200, height: 800, preferred: 450, share: 0.4, compact: false, maximized: false, shown: true };

test("面板宽度按工作区夹住，空间不足时上下排列，不改宽度偏好", () => {
	const wide = panelGeometry(options);
	assert.equal(wide.arrangement, "row");
	assert.equal(wide.panelWidth, 450);
	assert.equal(wide.chat.right, 454);
	const clamped = panelGeometry({ ...options, width: 850, preferred: 900 });
	assert.equal(850 - Number(clamped.chat.right), 420);
	const narrow = panelGeometry({ ...options, width: 590 });
	assert.equal(narrow.arrangement, "column");
	assert.equal(narrow.panelWidth, 590);
	assert.equal(narrow.chat.bottom, 324);
	assert.equal(panelGeometry(options).panelWidth, 450);
});

test("全屏和窄窗口占满工作区，收起保留面板尺寸并还原对话", () => {
	for (const mode of [{ maximized: true }, { compact: true }]) {
		const full = panelGeometry({ ...options, ...mode });
		assert.equal(full.arrangement, "single");
		assert.equal(full.panel.width, "100%");
		assert.equal(full.panel.height, "100%");
	}
	const hidden = panelGeometry({ ...options, shown: false });
	assert.equal(hidden.panelWidth, 450);
	assert.equal(hidden.chat.right, 0);
	assert.equal(hidden.panel.translate, "calc(100% + 4px) 0");
});

test("面板没有固定最大宽度，正文仍至少留420px", () => {
	assert.equal(panelWidthFor(900, 1600, 272), 900);
	assert.equal(panelWidthFor(Infinity, 1600, 272), 908);
	assert.equal(panelWidthFor(900, 1100, 272), 408);
	assert.equal(panelWidthFor(900, 1600, 272), 900);
	assert.equal(panelWidthFor(0, 1400, 250), 460);
	assert.equal(panelWidthFor(10, 1100, 272), 300);
});

test("窄窗口切单面板，中等窗口空间不够则上下排列", () => {
	assert.equal(panelArrangement(759, 720, 0), "single");
	assert.equal(panelArrangement(760, 720, 248), "column");
	assert.equal(panelArrangement(1100, 720, 248), "row");
	assert.equal(panelHeightFor(0.01, 720), 150);
	assert.equal(panelHeightFor(0.99, 720), 460);
	assert.equal(panelHeightFor(0.5, 720), 360);
});

test("标签按会话恢复，空白会话不落盘，损坏数据不进入界面", () => {
	const entries = new Map<string, string>();
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => entries.set(key, value),
		},
	});
	try {
		const tabs = { tabs: [{ id: "t", panel: "plume/file", title: "a.ts", sessionId: "child", file: { path: "a.ts", sessionId: "child" } }], active: "t" };
		writePanelTabs({ "": tabs, session: tabs });
		assert.deepEqual(readPanelTabs(), { session: tabs });
		const key = [...entries.keys()][0]!;
		entries.set(key, "null");
		assert.deepEqual(readPanelTabs(), {});
		entries.set(key, JSON.stringify({ a: { tabs: [{ id: 42 }], active: "bad" }, b: { tabs: [{ id: "ok" }], active: "missing" } }));
		assert.deepEqual(readPanelTabs(), {});
		assert.equal(readPanelPrefs().width, 0);
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});
