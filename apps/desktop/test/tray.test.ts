/**
 * 菜单栏图标的菜单（main/tray-menu.ts）和 plume:// 链接（main/deep-link.ts）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { SessionSummary } from "@plume/contract";
import { APP_SCHEME, sessionFromUrl } from "../src/main/deep-link.ts";
import { RECENT_LIMIT, type TrayItem, trayMenu, trayTitle } from "../src/main/tray-menu.ts";

function session(id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
	return { id, title: id, cwd: "/tmp", createdAt: 0, updatedAt, running: false, ...extra };
}

function recentOf(items: TrayItem[]): TrayItem[] {
	const submenu = items.find((item) => item.type === "submenu");
	assert.ok(submenu?.type === "submenu");
	return submenu.items;
}

test("最近会话：去掉归档的和子会话，按最后活动排，最多五个", () => {
	const sessions = [
		session("old", 1),
		session("archived", 50, { archived: true }),
		session("child", 60, { parentId: "old" }),
		...Array.from({ length: 6 }, (_, i) => session(`s${i}`, 10 + i)),
	];
	const recent = recentOf(trayMenu({ windowVisible: true, sessions, launchAtLogin: false, locale: "zh-CN" }));
	assert.equal(recent.length, RECENT_LIMIT);
	assert.deepEqual(
		recent.map((item) => item.type === "item" && item.action),
		["s5", "s4", "s3", "s2", "s1"].map((id) => ({ kind: "command", command: `open-session:${id}` })),
	);
});

test("没有会话时是一行灰掉的字，不是空菜单", () => {
	const recent = recentOf(trayMenu({ windowVisible: false, sessions: [], launchAtLogin: false, locale: "en" }));
	assert.deepEqual(recent, [{ type: "item", label: "No chats yet", action: { kind: "toggle-window" }, enabled: false }]);
});

test("第一项写按下去做什么，文字跟着界面语言", () => {
	const first = (windowVisible: boolean, locale: "zh-CN" | "en") => trayMenu({ windowVisible, sessions: [], launchAtLogin: true, locale })[0];
	assert.deepEqual(first(true, "zh-CN"), { type: "item", label: "隐藏 Plume", action: { kind: "toggle-window" } });
	assert.equal(first(false, "en")?.type === "item" && first(false, "en")?.label, "Open Plume");
});

test("标题截成一行，空标题用「新对话」", () => {
	assert.equal(trayTitle("  ", "新对话"), "新对话");
	assert.equal(trayTitle("短标题", "新对话"), "短标题");
	assert.equal(trayTitle("一".repeat(40), "新对话"), `${"一".repeat(27)}…`);
});

test("plume:// 链接只认 open-session 和会话 id 用得到的字符", () => {
	assert.equal(sessionFromUrl("plume://open-session?id=2f1c9a3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b"), "2f1c9a3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b");
	assert.equal(sessionFromUrl("plume://open-session?id=a:b"), null);
	assert.equal(sessionFromUrl("plume://open-session"), null);
	assert.equal(sessionFromUrl("plume://settings?id=abc"), null);
	assert.equal(sessionFromUrl("other://open-session?id=abc"), null);
	assert.equal(sessionFromUrl("not a url"), null);
});

test("scheme 和安装包里声明的一致，不然系统不会把地址送过来", () => {
	const yml = readFileSync(join(import.meta.dirname, "../electron-builder.yml"), "utf8");
	assert.match(yml, new RegExp(`schemes:\\s*\\[${APP_SCHEME}\\]`));
});
