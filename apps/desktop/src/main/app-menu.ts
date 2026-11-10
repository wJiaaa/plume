/**
 * 打包好的应用的菜单。
 *
 * 不设的话是 Electron 的默认菜单：它的「视图」里 Ctrl+R / Ctrl+Shift+R 整个重载界面（写了一半的消息、开着的对话框、
 * 滚动位置都没了），Ctrl+Shift+I 打开开发者工具。Windows 上菜单栏藏着，这些键照样生效，按到了也不知道是怎么回事。
 *
 * 留下的是有东西靠它的：
 *   - 编辑：macOS 上输入框的 ⌘C、⌘V、⌘X、⌘Z、⌘A 经编辑菜单的 role 分派，没有它这些键在应用里哪个输入框都不管用。
 *   - 窗口：「视图」没了，全屏挪到这里（macOS 是 ⌃⌘F，别处 F11）；还有关闭——⌘W / Ctrl+W 本来在默认菜单里，界面自己不处理。
 *   - macOS 上的应用菜单：退出、隐藏、关于都在那里。
 *
 * 只用 role、不写名字：名字由 Electron 按系统语言给，这里不用写哪种语言。开发时返回 null，留着默认菜单（重载、开发者工具都在）。
 *
 * 不引用 electron 的值，测试才能直接加载它。
 */

import type { MenuItemConstructorOptions } from "electron";

export function applicationMenuTemplate(options: { platform: string; packaged: boolean }): MenuItemConstructorOptions[] | null {
	if (!options.packaged) return null;
	if (options.platform === "darwin") {
		return [
			{ role: "appMenu" },
			{ role: "editMenu" },
			{
				role: "windowMenu",
				submenu: [
					{ role: "minimize" },
					{ role: "zoom" },
					{ role: "togglefullscreen" },
					{ type: "separator" },
					// ⌘W，本来在默认的「文件」菜单里。
					{ role: "close" },
					{ role: "front" },
				],
			},
		];
	}
	return [
		{ role: "editMenu" },
		/*
		 * `close` 是 Ctrl+W，默认菜单本来就绑着，留着不算新加的快捷键。
		 *
		 * 不放 `minimize`：菜单栏藏着时一个 role 就只剩它的快捷键，最小化的是 Ctrl+M——从 macOS 的 ⌘M 照搬过来，
		 * Windows 上没有哪个程序用它，打字时按到窗口就缩进任务栏了。Windows 上最小化靠标题栏的按钮和 Win+↓。
		 */
		{ role: "windowMenu", submenu: [{ role: "togglefullscreen" }, { role: "close" }] },
	];
}
