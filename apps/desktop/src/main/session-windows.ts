/**
 * 会话独立窗口（会话菜单的「新窗口」）：一段会话一个窗口，再开同一段就把那个窗口拿到前面来。主窗口看着名单点亮侧栏，
 * 会话窗口能置顶、回到主窗口。窗口只知道会话 id，正文照样经自己的 MessagePort 向 agent 进程要。
 */
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import iconPath from "../assets/icon.png?asset";
import type { Appearance } from "../shared/appearance.ts";
import { ROW_OFFSET, windowChrome } from "../shared/window-chrome.ts";
import { guardWebviews } from "./web-pages.ts";

/** 是一段对话，不是第二个工作区：比主窗口小，放得下一列转录和输入框。 */
const SIZE = { width: 780, height: 640 };
const MIN = { width: 420, height: 380 };
/** 新窗口相对主窗口错开多少，不正好盖住主窗口的标题栏。 */
const CASCADE = 52;

function alive(window: BrowserWindow): boolean {
	return !window.isDestroyed() && !window.webContents.isDestroyed();
}

/**
 * 独立窗口（会话窗口、面板窗口）没有浮起的卡片，整面是内容的底色，标题栏贴着窗口顶：红绿灯不跟着卡片往下挪那 5px。
 * 也不铺毛玻璃——整面不透明，材质透不出来，只会在快速拉边时露出一条。
 */
export function bareWindowChrome(color: string): ReturnType<typeof windowChrome> {
	const base = windowChrome(process.platform, color);
	const lights = base.trafficLightPosition;
	return lights ? { ...base, trafficLightPosition: { x: lights.x, y: lights.y - ROW_OFFSET } } : base;
}

function sessionIdFrom(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

/** 挨着主窗口错开一点，放不下就收进主窗口所在屏幕的可用区域。 */
function boundsNear(main: BrowserWindow): Electron.Rectangle {
	if (main.isDestroyed()) return { x: 80, y: 80, ...SIZE };
	const origin = main.getBounds();
	const area = screen.getDisplayMatching(origin).workArea;
	const width = Math.min(SIZE.width, Math.max(MIN.width, area.width - 24));
	const height = Math.min(SIZE.height, Math.max(MIN.height, area.height - 24));
	return {
		x: Math.max(area.x, Math.min(origin.x + CASCADE, area.x + area.width - width)),
		y: Math.max(area.y, Math.min(origin.y + CASCADE, area.y + area.height - height)),
		width,
		height,
	};
}

export interface SessionWindows {
	/** 发消息的是哪段会话的窗口；不是会话窗口是 undefined。面板请求经它交给主窗口。 */
	sessionOf(sender: WebContents): string | undefined;
	setAppearance(next: Appearance): void;
}

export function registerSessionWindowsIpc(
	main: BrowserWindow,
	initialAppearance: Appearance,
	backgroundColor: (appearance: Appearance) => string,
): SessionWindows {
	/** 键是窗口页面的 webContents id。 */
	const windows = new Map<number, { window: BrowserWindow; sessionId: string }>();
	let appearance = initialAppearance;
	const opaque = (value: Appearance) => backgroundColor({ ...value, vibrancy: false });
	let stopping = false;
	const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame;
	const fromMain = (event: IpcMainEvent | IpcMainInvokeEvent) => !stopping && alive(main) && trusted(event) && event.sender === main.webContents;
	const fromSession = (event: IpcMainEvent | IpcMainInvokeEvent) => (trusted(event) ? windows.get(event.sender.id) : undefined);
	const ids = () => Array.from(windows.values(), (entry) => entry.sessionId);
	const broadcast = () => {
		if (!stopping && alive(main)) main.webContents.send("plume:session-windows:changed", ids());
	};
	const revealMain = () => {
		if (!alive(main)) return;
		if (main.isMinimized()) main.restore();
		main.show();
		main.focus();
	};

	const open = (sessionId: string) => {
		for (const { window, sessionId: id } of windows.values()) {
			if (id !== sessionId || !alive(window)) continue;
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
			return;
		}
		const window = new BrowserWindow({
			...boundsNear(main),
			minWidth: MIN.width,
			minHeight: MIN.height,
			title: "Plume",
			icon: iconPath,
			show: false,
			backgroundColor: opaque(appearance),
			...bareWindowChrome(opaque(appearance)),
			webPreferences: {
				preload: join(import.meta.dirname, "../preload/index.cjs"),
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				// 和主窗口一样：被挡住时对话照常往下画。
				backgroundThrottling: false,
				// 插件的卡片可能画网页，和主窗口一样由 guardWebviews 加固。
				webviewTag: true,
			},
		});
		const page = window.webContents;
		guardWebviews(page);
		const id = page.id;
		windows.set(id, { window, sessionId });
		window.once("ready-to-show", () => {
			window.show();
			window.focus();
		});
		window.once("closed", () => {
			windows.delete(id);
			broadcast();
		});
		page.on("will-navigate", (navigation) => navigation.preventDefault());
		page.on("will-redirect", (navigation) => navigation.preventDefault());
		page.setWindowOpenHandler(() => ({ action: "deny" }));
		page.on("render-process-gone", () => {
			if (!window.isDestroyed()) window.destroy();
		});
		const reportFullScreen = () => {
			if (alive(window)) page.send("plume:fullscreen", window.isFullScreen());
		};
		window.on("enter-full-screen", reportFullScreen);
		window.on("leave-full-screen", reportFullScreen);
		page.on("did-finish-load", reportFullScreen);
		const reportMinimized = () => {
			if (alive(window)) page.send("plume:minimized", window.isMinimized());
		};
		window.on("minimize", reportMinimized);
		window.on("restore", reportMinimized);
		const loading = process.env.ELECTRON_RENDERER_URL
			? window.loadURL(process.env.ELECTRON_RENDERER_URL)
			: window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
		void loading.catch(() => {
			if (!window.isDestroyed()) window.destroy();
		});
		broadcast();
	};

	ipcMain.on("plume:session-windows:boot", (event) => {
		event.returnValue = fromSession(event)?.sessionId ?? null;
	});
	ipcMain.handle("plume:session-windows:open", (event, value: unknown) => {
		const sessionId = sessionIdFrom(value);
		if (fromMain(event) && sessionId) open(sessionId);
	});
	ipcMain.handle("plume:session-windows:list", (event) => (fromMain(event) ? ids() : []));
	ipcMain.handle("plume:session-windows:open-in-main", (event) => {
		const source = fromSession(event);
		if (!source || stopping || !alive(main)) return;
		main.webContents.send("plume:session-windows:show", source.sessionId);
		revealMain();
		source.window.destroy();
	});
	ipcMain.handle("plume:session-windows:keep-on-top", (event, value: unknown) => {
		const source = fromSession(event);
		if (!source || !alive(source.window)) return false;
		if (typeof value === "boolean") source.window.setAlwaysOnTop(value);
		return source.window.isAlwaysOnTop();
	});

	const destroyAll = () => {
		stopping = true;
		for (const { window } of windows.values()) if (!window.isDestroyed()) window.destroy();
		windows.clear();
	};
	main.once("closed", destroyAll);
	app.on("before-quit", destroyAll);

	return {
		sessionOf: (sender) => windows.get(sender.id)?.sessionId,
		setAppearance(next) {
			appearance = next;
			for (const { window } of windows.values()) if (alive(window)) window.setBackgroundColor(opaque(next));
		},
	};
}
