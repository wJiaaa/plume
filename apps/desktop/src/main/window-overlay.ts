/**
 * Windows、Linux 上系统画在页面右上角的最小化、最大化、关闭（`titleBarOverlay`）的颜色。页面里没有它们，
 * 颜色只能由页面算好送过来：带子的底色和符号色随主题、皮肤变，有遮罩压暗窗口时跟着变暗（见 renderer/window-overlay.ts）。
 * macOS 的红绿灯不归页面管，那里没有这回事。
 */

import { BrowserWindow, ipcMain } from "electron";
import { NATIVE_HEADER_HEIGHT } from "../shared/window-chrome.ts";

const HEX = /^#[0-9a-f]{6}$/i;

export function registerWindowOverlayIpc(): void {
	if (process.platform === "darwin") return;
	ipcMain.on("plume:window:overlay", (event, colors: unknown) => {
		const { color, symbolColor } = (colors ?? {}) as { color?: unknown; symbolColor?: unknown };
		if (typeof color !== "string" || !HEX.test(color) || typeof symbolColor !== "string" || !HEX.test(symbolColor)) return;
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window || window.isDestroyed()) return;
		try {
			// 高度和建窗时那次一致，漏了的话换一次主题按钮就变成另一个尺寸。
			window.setTitleBarOverlay({ color, symbolColor, height: NATIVE_HEADER_HEIGHT });
		} catch {
			// 截屏浮层、钉图窗口没有 overlay，Electron 会抛错；它们也不该有这几颗按钮。
		}
	});
}
