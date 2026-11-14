/**
 * 预加载脚本：只暴露这几件事——上报共享模块的导出名、取得与 agent 进程通信的 MessagePort、选文件夹、得知 agent 进程退出，
 * 以及画窗口外壳要用的平台、毛玻璃、原生全屏和最小化状态、系统按钮的配色，外观设置、界面语言的读写和会话背景图的选、读、删。
 * 还有插件市场（读目录、装、卸、更新、读介绍、打开目录）、在浏览器里打开链接，和供应商导入导出时选文件，以及截屏的浮层和钉图窗口；附件的路径和打开、在文件夹中显示、复制；菜单栏图标和 plume:// 链接叫界面做的事。
 * 不暴露通用 IPC，也不暴露 Node 能力；会话和循环相关的调用都走那一个 MessagePort。
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { PanelWindowsBridge } from "../shared/panel-window.ts";
import type { SessionWindowsBridge } from "../shared/session-window.ts";
import { hasVibrancy } from "../shared/window-chrome.ts";

const vibrancy = hasVibrancy(process.platform);
const appearance = ipcRenderer.sendSync("plume:appearance") as { vibrancy?: boolean };

/** 给 <html> 打标记。预加载脚本跑的时候文档可能还没有根元素，那就等它出现。 */
function markRoot(mark: (root: HTMLElement) => void): void {
	if (document.documentElement) mark(document.documentElement);
	else document.addEventListener("readystatechange", () => mark(document.documentElement), { once: true });
}

// 平台也在第一帧之前标上：样式表按它换平台自己的写法（Windows 上的加粗字重），见 markdown.css。
markRoot((root) => (root.dataset.platform = process.platform));

// 毛玻璃要在第一帧之前标上：样式表一加载 body 就是不透明的底色，等页面脚本再改会先闪一帧实色。
if (vibrancy) markRoot((root) => (root.dataset.vibrancy = appearance.vibrancy === false ? "off" : "on"));

// 最小化时停掉动画：CSS 动画看 styles.css 里的 data-minimized，JS 驱动的动画由页面订阅 onMinimizedChange。
let minimized = false;
const minimizedListeners = new Set<(minimized: boolean) => void>();
ipcRenderer.on("plume:minimized", (_event, value: boolean) => {
	minimized = value;
	markRoot((root) => root.toggleAttribute("data-minimized", value));
	for (const listener of minimizedListeners) listener(value);
});

// 页面连上 agent 进程之后才订阅全屏状态，那时主进程在 did-finish-load 报的那一次可能已经过去了，所以这里先记下最新值。
let fullScreen = false;
const fullScreenListeners = new Set<(full: boolean) => void>();
ipcRenderer.on("plume:fullscreen", (_event, full: boolean) => {
	fullScreen = full;
	for (const listener of fullScreenListeners) listener(full);
});

const panelWindowListeners = new Set<Parameters<PanelWindowsBridge["onChanged"]>[0]>();
ipcRenderer.on("plume:panel-windows:changed", (_event, change: Parameters<Parameters<PanelWindowsBridge["onChanged"]>[0]>[0]) => {
	if (change.reason !== "closing") {
		for (const listener of panelWindowListeners) listener(change);
		return;
	}
	// 异步确认须返回 Promise；取消无需调用 close，监听结束后即可再次按关闭。
	void Promise.allSettled(Array.from(panelWindowListeners, async (listener) => listener(change))).then((results) => {
		for (const result of results) {
			if (result.status === "rejected") console.error("面板关闭处理失败：", result.reason);
		}
		ipcRenderer.send("plume:panel-windows:closing-handled");
	});
});

const panelWindows: PanelWindowsBridge = {
	boot: ipcRenderer.sendSync("plume:panel-windows:boot"),
	open: (target) => ipcRenderer.invoke("plume:panel-windows:open", target),
	dock: () => ipcRenderer.invoke("plume:panel-windows:dock"),
	close: () => ipcRenderer.invoke("plume:panel-windows:close"),
	list: () => ipcRenderer.invoke("plume:panel-windows:list"),
	keepOnTop: (enabled) => ipcRenderer.invoke("plume:panel-windows:keep-on-top", enabled),
	reveal: (request) => ipcRenderer.invoke("plume:panel-windows:reveal", request),
	onReveal: (listener) => {
		const receive = (_event: unknown, value: Parameters<typeof listener>[0]) => listener(value);
		ipcRenderer.on("plume:panel-windows:reveal", receive);
		return () => {
			ipcRenderer.removeListener("plume:panel-windows:reveal", receive);
		};
	},
	onChanged: (listener) => {
		panelWindowListeners.add(listener);
		// 订阅发生在页面初始化之后；宿主不能在标签交接之前就宣告打开成功。
		ipcRenderer.send("plume:panel-windows:listening");
		return () => {
			panelWindowListeners.delete(listener);
		};
	},
};

const sessionWindows: SessionWindowsBridge = {
	boot: ipcRenderer.sendSync("plume:session-windows:boot"),
	open: (sessionId) => ipcRenderer.invoke("plume:session-windows:open", sessionId),
	list: () => ipcRenderer.invoke("plume:session-windows:list"),
	onChanged: (listener) => {
		const receive = (_event: unknown, ids: string[]) => listener(ids);
		ipcRenderer.on("plume:session-windows:changed", receive);
		return () => {
			ipcRenderer.removeListener("plume:session-windows:changed", receive);
		};
	},
	onShow: (listener) => {
		const receive = (_event: unknown, sessionId: string) => listener(sessionId);
		ipcRenderer.on("plume:session-windows:show", receive);
		return () => {
			ipcRenderer.removeListener("plume:session-windows:show", receive);
		};
	},
	openInMain: () => ipcRenderer.invoke("plume:session-windows:open-in-main"),
	keepOnTop: (enabled) => ipcRenderer.invoke("plume:session-windows:keep-on-top", enabled),
};

contextBridge.exposeInMainWorld("plume", {
	platform: process.platform,
	version: ipcRenderer.sendSync("plume:version") as string,
	panelWindows,
	sessionWindows,
	vibrancy,
	// 同步取：页面第一帧之前就要按用户的配色画。
	appearance,
	saveAppearance: (patch: unknown) => ipcRenderer.invoke("plume:appearance:save", patch),
	onAppearanceChanged: (listener: (appearance: unknown) => void) => {
		ipcRenderer.on("plume:appearance:changed", (_event, value: unknown) => listener(value));
	},
	setThemeOverride: (mode: "system" | "light" | "dark" | null) => ipcRenderer.invoke("plume:appearance:theme-override", mode),
	// 同步取：第一帧的文字就要是用户选的语言。
	locale: ipcRenderer.sendSync("plume:locale") as unknown,
	saveLocale: (locale: string) => ipcRenderer.invoke("plume:locale:save", locale),
	keepAwake: {
		get: () => ipcRenderer.sendSync("plume:keep-awake") as boolean,
		set: (on: boolean) => ipcRenderer.invoke("plume:keep-awake:save", on),
	},
	chatBackground: {
		pick: (title?: string) => ipcRenderer.invoke("plume:chat-background:pick", title),
		import: (bytes: Uint8Array, name: string) => ipcRenderer.invoke("plume:chat-background:import", bytes, name),
		read: (name: string) => ipcRenderer.invoke("plume:chat-background:read", name),
	},
	registerShared: (exports: Record<string, string[]>) => ipcRenderer.invoke("plume:shared", exports),
	connect: () => ipcRenderer.send("plume:connect"),
	pickFolder: (title?: string) => ipcRenderer.invoke("plume:pick-folder", title),
	providerFile: {
		save: (title: string, name: string) => ipcRenderer.invoke("plume:providers:save-path", title, name),
		open: (title: string) => ipcRenderer.invoke("plume:providers:open-path", title),
	},
	sessionsExportPath: (title: string, name: string, format?: "database" | "markdown") => ipcRenderer.invoke("plume:sessions:save-path", title, name, format),
	captureWindow: (rect: { x: number; y: number; width: number; height: number }): Promise<string> => ipcRenderer.invoke("plume:window:capture", rect),
	openExternal: (url: string) => ipcRenderer.invoke("plume:open-external", url),
	defaultBrowser: () => ipcRenderer.invoke("plume:default-browser"),
	files: {
		pickReference: (directory: boolean) => ipcRenderer.invoke("plume:files:pick-reference", directory),
		remoteImage: (url: string) => ipcRenderer.invoke("plume:files:remote-image", url),
		// 同步取，在拿到 File 的那一刻：拖放事件返回后 DataTransfer 就空了。不是文件（剪贴板里的截图）时是空串。
		pathFor: (file: File) => webUtils.getPathForFile(file),
		exists: (path: string) => ipcRenderer.invoke("plume:files:exists", path),
		open: (path: string) => ipcRenderer.invoke("plume:files:open", path),
		reveal: (path: string) => ipcRenderer.invoke("plume:files:reveal", path),
		openIn: (target: string, path: string) => ipcRenderer.invoke("plume:files:open-in", target, path),
		targets: () => ipcRenderer.invoke("plume:open-targets"),
		copyText: (text: string) => ipcRenderer.invoke("plume:files:copy-text", text),
		readText: (): Promise<string> => ipcRenderer.invoke("plume:files:read-text"),
		copyImage: (dataUrl: string) => ipcRenderer.invoke("plume:files:copy-image", dataUrl),
	},
	market: {
		read: () => ipcRenderer.invoke("plume:market:read"),
		install: (id: string) => ipcRenderer.invoke("plume:market:install", id),
		installFolder: (dir: string) => ipcRenderer.invoke("plume:market:install-folder", dir),
		uninstall: (id: string) => ipcRenderer.invoke("plume:market:uninstall", id),
		update: (ids?: string[]) => ipcRenderer.invoke("plume:market:update", ids),
		setAutoUpdate: (auto: boolean) => ipcRenderer.invoke("plume:market:auto-update", auto),
		readme: (id: string) => ipcRenderer.invoke("plume:market:readme", id),
		readmeImage: (id: string, path: string) => ipcRenderer.invoke("plume:market:readme-image", id, path),
		openFolder: (id: string) => ipcRenderer.invoke("plume:market:open-folder", id),
		onChanged: (listener: (state: unknown) => void) => {
			ipcRenderer.on("plume:market:changed", (_event, state: unknown) => listener(state));
		},
	},
	/** 应用更新，见 main/update/updates.ts。下载的进度广播给每个窗口；退订用返回的函数。 */
	updates: {
		check: (force?: boolean) => ipcRenderer.invoke("plume:updates:check", force),
		state: () => ipcRenderer.invoke("plume:updates:state"),
		download: (version: string) => ipcRenderer.invoke("plume:updates:download", version),
		pause: () => ipcRenderer.invoke("plume:updates:pause"),
		cancel: () => ipcRenderer.invoke("plume:updates:cancel"),
		relaunch: () => ipcRenderer.invoke("plume:updates:relaunch"),
		open: (url: string) => ipcRenderer.invoke("plume:updates:open", url),
		onProgress: (listener: (phase: unknown) => void) => {
			const handler = (_event: unknown, phase: unknown) => listener(phase);
			ipcRenderer.on("plume:updates:progress", handler);
			return () => {
				ipcRenderer.removeListener("plume:updates:progress", handler);
			};
		},
	},
	/** 主进程叫界面做的事（菜单栏图标、plume:// 链接）。订阅的同时告诉主进程，它才把之前攒着的送过来。 */
	onCommand: (listener: (command: string) => void) => {
		ipcRenderer.on("plume:command", (_event, command: string) => listener(command));
		ipcRenderer.send("plume:command:listening");
	},
	onAgentExit: (listener: (code: number) => void) => {
		ipcRenderer.on("plume:agent-exited", (_event, code: number) => listener(code));
	},
	/** 订阅时先按当前状态调一次。 */
	onFullScreenChange: (listener: (full: boolean) => void) => {
		fullScreenListeners.add(listener);
		listener(fullScreen);
	},
	/** 订阅时先按当前状态调一次。 */
	onMinimizedChange: (listener: (minimized: boolean) => void) => {
		minimizedListeners.add(listener);
		listener(minimized);
	},
	/** Windows、Linux 上系统画在页面右上角那几颗按钮的底色和符号色，见 main/window-overlay.ts。 */
	setWindowOverlay: (colors: { color: string; symbolColor: string }) => ipcRenderer.send("plume:window:overlay", colors),
	/**
	 * 截屏（插件经 ui.screen 调的宿主能力）。前四个给主窗口；session 往下给截屏浮层窗口，pin 给钉在桌面上的小窗口。
	 * 浮层、钉图窗口是哪一个由主进程按发消息的窗口认，这里不传 id。
	 */
	screen: {
		start: () => ipcRenderer.invoke("plume:screen:start"),
		setShortcut: (plugin: string, accelerator: string | null) => ipcRenderer.invoke("plume:screen:shortcut", plugin, accelerator),
		pickDirectory: (title: string) => ipcRenderer.invoke("plume:screen:pick-directory", title),
		desktopDirectory: () => ipcRenderer.invoke("plume:screen:desktop"),
		onSession: (listener: (session: unknown) => void) => {
			ipcRenderer.on("plume:screen:session", (_event, session: unknown) => listener(session));
			// 页面连上 agent、装好插件界面才订阅，比 did-finish-load 晚得多；主进程等这一声才把 session 发过来，不然会被丢掉。
			ipcRenderer.send("plume:screen:listening");
		},
		onEscape: (listener: () => void) => {
			ipcRenderer.on("plume:screen:escape", () => listener());
		},
		onHidden: (listener: () => void) => {
			ipcRenderer.on("plume:screen:hidden", () => listener());
		},
		ready: (session: number) => ipcRenderer.send("plume:screen:ready", session),
		finish: (png?: string) => ipcRenderer.invoke("plume:screen:finish", png),
		cancel: () => ipcRenderer.send("plume:screen:cancel"),
		pin: (png: string, at: unknown) => ipcRenderer.invoke("plume:screen:pin", png, at),
		copy: (png: string) => ipcRenderer.invoke("plume:screen:copy", png),
		passThrough: (on: boolean) => ipcRenderer.send("plume:screen:pass-through", on),
	},
	pin: {
		request: () => ipcRenderer.invoke("plume:pin:request"),
		ready: () => ipcRenderer.send("plume:pin:ready"),
		close: () => ipcRenderer.send("plume:pin:close"),
		dragStart: () => ipcRenderer.send("plume:pin:drag-start"),
		dragMove: (dx: number, dy: number) => ipcRenderer.send("plume:pin:drag-move", dx, dy),
	},
});

// MessagePort 不能经 contextBridge 传递，按 Electron 的做法用 window.postMessage 转交给页面。
ipcRenderer.on("plume:port", (event) => {
	window.postMessage("plume:port", "*", event.ports);
});
