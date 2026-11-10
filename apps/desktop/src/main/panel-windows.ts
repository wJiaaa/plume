/** 面板窗口的身份、启动握手和收回；页面只交接标签信息，不交接文件内容或读取权限。 */
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import iconPath from "../assets/icon.png?asset";
import type { Appearance } from "../shared/appearance.ts";
import type { PanelWindowTarget, PanelWindowReveal, PanelWindowsBridge } from "../shared/panel-window.ts";
import { guardWebviews } from "./web-pages.ts";
import { panelQuoteFrom } from "./panel-quote.ts";
import { bareWindowChrome } from "./session-windows.ts";

/** 还要连 agent、加载插件界面，不能只等 HTML 下载完。 */
const READY_TIMEOUT_MS = 30_000;
type Change = Parameters<Parameters<PanelWindowsBridge["onChanged"]>[0]>[0];

interface PanelWindow {
	window: BrowserWindow;
	target: PanelWindowTarget;
	opened: boolean;
	docked: boolean;
	closing: boolean;
	ready: Promise<boolean>;
	listening(): void;
}

/** 面板窗口交回来的草稿的上限：一段长提示词、几张截图（base64），挡住失控的插件把主窗口撑爆。 */
const DRAFT_TEXT = 1_000_000;
const DRAFT_IMAGES = 8;
const DRAFT_IMAGE = 20_000_000;

function text(value: unknown, max = 1024): value is string {
	return typeof value === "string" && value.length <= max && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function targetFrom(value: unknown): PanelWindowTarget | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const target = value as Record<string, unknown>;
	if (!text(target.scope) || !text(target.tab) || !text(target.panel)) return null;
	if (target.title !== undefined && !text(target.title)) return null;
	if (target.owner !== undefined && !text(target.owner)) return null;
	let file: PanelWindowTarget["file"];
	if (target.file !== undefined) {
		if (!target.file || typeof target.file !== "object" || Array.isArray(target.file)) return null;
		const candidate = target.file as Record<string, unknown>;
		if (!text(candidate.path, 32768) || !text(candidate.sessionId)) return null;
		file = { path: candidate.path, sessionId: candidate.sessionId };
	}
	if (target.panel === "plume/file" && !file) return null;
	return {
		scope: target.scope,
		tab: target.tab,
		panel: target.panel,
		...(target.title !== undefined ? { title: target.title } : {}),
		...(target.owner !== undefined ? { owner: target.owner } : {}),
		...(file ? { file } : {}),
	};
}

function alive(window: BrowserWindow): boolean {
	return !window.isDestroyed() && !window.webContents.isDestroyed();
}

/** 返回外观更新入口；截屏、钉图窗口不在这份注册表里。 */
export function registerPanelWindowsIpc(
	main: BrowserWindow,
	initialAppearance: Appearance,
	backgroundColor: (appearance: Appearance) => string,
	/** 会话窗口也没有面板区：它要开的面板、文件同样交给主窗口，开在那段会话旁边。 */
	sessionOf: (sender: WebContents) => string | undefined,
): (appearance: Appearance) => void {
	const panels = new Map<number, PanelWindow>();
	let appearance = initialAppearance;
	const opaque = (value: Appearance) => backgroundColor({ ...value, vibrancy: false });
	let stopping = false;
	const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame;
	const fromPanel = (event: IpcMainEvent | IpcMainInvokeEvent) => (trusted(event) ? panels.get(event.sender.id) : undefined);
	const fromMain = (event: IpcMainEvent | IpcMainInvokeEvent) => !stopping && alive(main) && trusted(event) && event.sender === main.webContents;
	const broadcast = (change: Change) => {
		if (stopping) return;
		for (const window of [main, ...Array.from(panels.values(), (panel) => panel.window)]) {
			if (alive(window)) window.webContents.send("plume:panel-windows:changed", change);
		}
	};

	ipcMain.handle("plume:panel-windows:reveal", (event, value: unknown) => {
		const scope = fromPanel(event)?.target.scope ?? (trusted(event) ? sessionOf(event.sender) : undefined);
		if (scope === undefined || !alive(main) || !value || typeof value !== "object") return;
		const data = value as Record<string, unknown>;
		let request: PanelWindowReveal;
		if (text(data.panel) && (data.sessionId === undefined || text(data.sessionId))) {
			request = { panel: data.panel, ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}) };
		} else if (data.file && typeof data.file === "object") {
			const file = data.file as Record<string, unknown>;
			if (!text(file.path, 32768) || !text(file.sessionId)) return;
			let lines: { from: number; to: number } | undefined;
			if (file.lines !== undefined) {
				if (!file.lines || typeof file.lines !== "object") return;
				const range = file.lines as { from: number; to: number };
				if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 1 || range.to < range.from) return;
				lines = { from: range.from, to: range.to };
			}
			request = { file: { path: file.path, sessionId: file.sessionId, ...(lines ? { lines } : {}) } };
		} else if (data.quote !== undefined) {
			const quote = panelQuoteFrom(data.quote, scope);
			if (!quote) return;
			request = { quote };
		} else if (data.draft && typeof data.draft === "object") {
			const draft = data.draft as Record<string, unknown>;
			if (
				typeof draft.text !== "string" ||
				draft.text.length > DRAFT_TEXT ||
				typeof draft.append !== "boolean" ||
				(draft.send !== undefined && typeof draft.send !== "boolean") ||
				!Array.isArray(draft.images) ||
				draft.images.length > DRAFT_IMAGES
			)
				return;
			const images = draft.images as Array<{ data?: unknown; mimeType?: unknown }>;
			if (
				!images.every(
					(image) =>
						typeof image?.data === "string" &&
						image.data.length <= DRAFT_IMAGE &&
						typeof image.mimeType === "string" &&
						/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType),
				)
			)
				return;
			request = {
				draft: {
					text: draft.text,
					append: draft.append,
					images: images.map((image) => ({ data: image.data as string, mimeType: image.mimeType as string })),
					...(draft.send ? { send: true } : {}),
				},
			};
		} else return;
		main.webContents.send("plume:panel-windows:reveal", { scope, request });
		// 请求总是另一扇窗口里点出来的：主窗口收在程序坞里时，打开的东西人看不见，和什么都没发生一样。
		if (main.isMinimized()) main.restore();
		main.show();
		main.focus();
	});
	ipcMain.on("plume:panel-windows:boot", (event) => {
		event.returnValue = fromPanel(event)?.target ?? null;
	});
	ipcMain.on("plume:panel-windows:listening", (event) => fromPanel(event)?.listening());
	ipcMain.on("plume:panel-windows:closing-handled", (event) => {
		const panel = fromPanel(event);
		if (panel) panel.closing = false;
	});
	ipcMain.handle("plume:panel-windows:close", (event) => {
		const panel = fromPanel(event);
		if (panel?.opened && !panel.docked && alive(panel.window)) panel.window.destroy();
	});
	ipcMain.handle("plume:panel-windows:keep-on-top", (event, value: unknown) => {
		const panel = fromPanel(event);
		if (!panel || !alive(panel.window)) return false;
		if (typeof value === "boolean") panel.window.setAlwaysOnTop(value);
		return panel.window.isAlwaysOnTop();
	});
	ipcMain.handle("plume:panel-windows:list", (event): PanelWindowTarget[] => {
		if (!fromMain(event) && !fromPanel(event)) return [];
		return Array.from(panels.values())
			.filter((panel) => panel.opened && alive(panel.window))
			.map((panel) => panel.target);
	});
	ipcMain.handle("plume:panel-windows:dock", (event) => {
		const panel = fromPanel(event);
		if (!panel?.opened || panel.docked || !alive(panel.window)) return;
		panel.docked = true;
		// 先让来源恢复标签，再关窗；closed 不能再被读成删除标签。
		broadcast({ target: panel.target, reason: "docked" });
		panel.window.destroy();
	});
	ipcMain.handle("plume:panel-windows:open", (event, value: unknown): Promise<boolean> | boolean => {
		if (!fromMain(event)) return false;
		const target = targetFrom(value);
		if (!target) return false;
		for (const panel of panels.values()) {
			if (panel.target.scope !== target.scope || panel.target.tab !== target.tab || !alive(panel.window)) continue;
			if (panel.opened) {
				if (panel.window.isMinimized()) panel.window.restore();
				panel.window.show();
				panel.window.focus();
			}
			return panel.ready;
		}

		let window: BrowserWindow;
		try {
			window = new BrowserWindow({
				width: 780,
				height: 640,
				minWidth: 420,
				minHeight: 380,
				title: target.title ?? "Plume",
				icon: iconPath,
				show: false,
				backgroundColor: opaque(appearance),
				...bareWindowChrome(opaque(appearance)),
				webPreferences: {
					preload: join(import.meta.dirname, "../preload/index.cjs"),
					sandbox: true,
					contextIsolation: true,
					nodeIntegration: false,
					backgroundThrottling: false,
					// 弹出来的浏览器标签在这里画 `<webview>`，和主窗口一样由 guardWebviews 加固。
					webviewTag: true,
				},
			});
		} catch {
			return false;
		}
		const page = window.webContents;
		guardWebviews(page);
		const id = page.id;
		let loaded = false;
		let painted = false;
		let listening = false;
		let settled = false;
		let resolveReady!: (opened: boolean) => void;
		const ready = new Promise<boolean>((resolve) => {
			resolveReady = resolve;
		});
		const settle = (opened: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolveReady(opened);
		};
		const finish = () => {
			if (settled || !loaded || !painted || !listening || stopping || !alive(main) || !alive(window)) return;
			panel.opened = true;
			window.show();
			window.focus();
			broadcast({ target, reason: "opened" });
			settle(true);
		};
		const fail = () => {
			settle(false);
			// 崩溃不是用户确认关闭：原资源还在，必须把标签交回而不是删除恢复入口。
			if (panel.opened && !panel.docked && !stopping) {
				panel.docked = true;
				broadcast({ target, reason: "docked" });
			}
			if (!window.isDestroyed()) window.destroy();
		};
		const panel: PanelWindow = {
			window,
			target,
			opened: false,
			docked: false,
			closing: false,
			ready,
			listening: () => {
				listening = true;
				finish();
			},
		};
		const timeout = setTimeout(fail, READY_TIMEOUT_MS);
		panels.set(id, panel);
		window.on("close", (closing) => {
			closing.preventDefault();
			if (stopping || !panel.opened) {
				fail();
				return;
			}
			if (panel.closing || !alive(window)) return;
			panel.closing = true;
			page.send("plume:panel-windows:changed", { target, reason: "closing" } satisfies Change);
		});
		window.once("closed", () => {
			panels.delete(id);
			settle(false);
			if (panel.opened && !panel.docked) broadcast({ target, reason: "closed" });
		});
		window.once("ready-to-show", () => {
			painted = true;
			finish();
		});
		page.on("will-navigate", (navigation) => navigation.preventDefault());
		page.on("will-redirect", (navigation) => navigation.preventDefault());
		page.setWindowOpenHandler(() => ({ action: "deny" }));
		page.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
			if (isMainFrame) fail();
		});
		page.on("render-process-gone", fail);
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
		try {
			const loading = process.env.ELECTRON_RENDERER_URL
				? window.loadURL(process.env.ELECTRON_RENDERER_URL)
				: window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
			void loading
				.then(() => {
					loaded = true;
					finish();
				})
				.catch(fail);
		} catch {
			fail();
		}
		return ready;
	});

	const destroyPanels = () => {
		stopping = true;
		for (const { window } of panels.values()) {
			if (!window.isDestroyed()) window.destroy();
		}
		panels.clear();
	};
	main.once("closed", destroyPanels);
	app.on("before-quit", destroyPanels);
	return (next) => {
		appearance = next;
		for (const { window } of panels.values()) if (alive(window)) window.setBackgroundColor(opaque(next));
	};
}
