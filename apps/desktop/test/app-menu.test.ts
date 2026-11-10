/**
 * 打包好的应用的菜单（main/app-menu.ts）：默认菜单的重载、开发者工具快捷键不能留，编辑菜单（输入框的复制粘贴靠它）
 * 和 ⌘W / Ctrl+W 关窗口要留。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { applicationMenuTemplate } from "../src/main/app-menu.ts";

type Item = { role?: string; type?: string; label?: string; submenu?: Item[] };

function roles(items: Item[]): string[] {
	return items.flatMap((item) => [...(item.role ? [item.role] : []), ...roles(Array.isArray(item.submenu) ? item.submenu : [])]);
}

const GONE = ["reload", "forceReload", "toggleDevTools", "viewMenu"];

for (const platform of ["darwin", "win32"]) {
	test(`${platform}：打包后的菜单里没有重载和开发者工具，编辑、窗口、关闭都在`, () => {
		const template = applicationMenuTemplate({ platform, packaged: true }) as Item[] | null;
		assert.ok(template, "打包后必须设自己的菜单，否则留着 Electron 的默认菜单");
		const present = roles(template);
		for (const role of GONE) assert.ok(!present.includes(role), `${platform} 的菜单里还有 ${role}`);
		assert.ok(present.includes("editMenu"));
		assert.ok(present.includes("windowMenu"));
		assert.ok(present.includes("close"), `${platform} 上按键盘关不了窗口`);
		assert.ok(present.includes("togglefullscreen"));
	});

	test(`${platform}：每一项都是 role，不写哪种语言的名字`, () => {
		const walk = (items: Item[]): void => {
			for (const item of items) {
				assert.ok(item.role || item.type === "separator", `没有 role 的一项：${JSON.stringify(item)}`);
				assert.equal(item.label, undefined);
				if (Array.isArray(item.submenu)) walk(item.submenu);
			}
		};
		walk(applicationMenuTemplate({ platform, packaged: true }) as Item[]);
	});
}

test("macOS 留着应用菜单（退出、隐藏、关于）和 ⌘M 最小化", () => {
	const present = roles(applicationMenuTemplate({ platform: "darwin", packaged: true }) as Item[]);
	assert.ok(present.includes("appMenu"));
	assert.ok(present.includes("minimize"));
});

test("Windows 上 Ctrl+M 不最小化窗口：打字时按到窗口就没了", () => {
	assert.ok(!roles(applicationMenuTemplate({ platform: "win32", packaged: true }) as Item[]).includes("minimize"));
});

test("开发时留着 Electron 的默认菜单", () => {
	assert.equal(applicationMenuTemplate({ platform: "darwin", packaged: false }), null);
	assert.equal(applicationMenuTemplate({ platform: "win32", packaged: false }), null);
});
