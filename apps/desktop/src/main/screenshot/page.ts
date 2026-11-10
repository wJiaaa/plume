/**
 * 截屏浮层和钉图窗口加载的页面：和主窗口同一份页面、同一个预加载脚本、同样的沙箱，地址后面带上 hash，
 * 页面按 hash 只画插件注册的那个组件（见 renderer/screen.tsx）。
 */

import { join } from "node:path";
import type { BrowserWindow, WebPreferences } from "electron";

export function screenPagePreferences(): WebPreferences {
	return {
		preload: join(import.meta.dirname, "../preload/index.cjs"),
		sandbox: true,
		contextIsolation: true,
		// 这两种窗口要在 Plume 不在前面时照常响应（浮层大部分时间藏着、一亮出来就要跟手；钉图窗口在别的应用上面被拖），
		// 节流了的渲染进程醒得慢，计时器和动画帧都会掉。
		backgroundThrottling: false,
	};
}

export function loadScreenPage(window: BrowserWindow, hash: "screen-overlay" | "pinned-shot"): Promise<void> {
	// 页面里跑着插件的代码，又带着预加载脚本：只许是这一页，不许被导航走或开新窗口。
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	const devServer = process.env.ELECTRON_RENDERER_URL;
	return devServer ? window.loadURL(`${devServer}#${hash}`) : window.loadFile(join(import.meta.dirname, "../renderer/index.html"), { hash });
}
