/**
 * 截屏的宿主能力（插件经 `ui.screen`、`ui.screenOverlay`、`ui.pinnedShot` 用，类型见 @plume/contract/ui 的 `ScreenCapture`）：
 * 拍屏幕、盖住屏幕的浮层窗口（overlay.ts）、钉在桌面上的窗口（pin.ts）、系统剪贴板、按插件注册的全局快捷键。
 * 插件跑在 agent 进程和渲染进程里，碰不到这些主进程的 API。选区、标注、工具栏和截屏的设置都是插件的，宿主没有截屏设置。
 *
 * 通道名和预加载脚本（preload/index.ts 的 `screen`、`pin`）一一对应。浮层、钉图窗口发来的消息按发消息的页面认，
 * 别的页面发来的不理：插件的界面代码在主窗口里也跑着，不该能收起、钉住一次不属于它的截屏。
 */

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, type OpenDialogOptions } from "electron";
import type { ScreenRect } from "@plume/contract/ui";
import { normalizeShortcut } from "./accelerator.ts";
import {
	closeOverlay,
	copyImage,
	destroyOverlay,
	dismissStrayOverlay,
	finishCapture,
	isOverlay,
	isOverlayPage,
	overlayListening,
	overlayReady,
	passThrough,
	showWindowsPutAside,
	startCapture,
	warmOverlay,
} from "./overlay.ts";
import { beginPinDrag, closePin, destroyPins, dragPin, isPinWindow, pinnedImage, pinShot, revealPin } from "./pin.ts";

/** 启动后多久预热浮层：等应用起完、空闲下来。 */
const WARM_AFTER_LAUNCH_MS = 3_000;

/** 插件名 → 它注册着的快捷键（规整过的写法）。 */
const shortcuts = new Map<string, string>();

function startFromShortcut(): void {
	startCapture().catch((error: unknown) => console.error("[screen] 快捷键触发的截屏失败：", error));
}

function isRect(value: unknown): value is ScreenRect {
	const rect = value as ScreenRect | null;
	return typeof rect === "object" && rect !== null && [rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === "number" && Number.isFinite(n));
}

export function registerScreenshot(): void {
	const launchedAt = Date.now();
	let warmScheduled = false;
	/**
	 * 预热要另开一个渲染进程、加载整页和所有插件的界面入口，没有插件用截屏时不值得。插件设了全局快捷键，就是它要截屏的信号；
	 * 只用按钮截屏的插件第一次截屏慢一些。
	 */
	const scheduleWarm = () => {
		if (warmScheduled) return;
		warmScheduled = true;
		setTimeout(warmOverlay, Math.max(0, launchedAt + WARM_AFTER_LAUNCH_MS - Date.now()));
	};

	ipcMain.handle("plume:screen:start", () => startCapture());

	/**
	 * 一个插件一个快捷键，后设的替换先设的，null 取消；同一个值再设是 ok、什么也不做。
	 * 只认主窗口发来的：浮层、钉图窗口也装着插件的界面入口、也会跑 apply，由它们来设，开一个钉图窗口就会改一次注册。
	 * 别的窗口发来的回 ok、不动注册。
	 */
	ipcMain.handle("plume:screen:shortcut", (event, plugin: unknown, accelerator: unknown): "ok" | "taken" | "invalid" => {
		const sender = BrowserWindow.fromWebContents(event.sender);
		if (!sender || isOverlay(sender) || isPinWindow(sender)) return "ok";
		if (typeof plugin !== "string" || (accelerator !== null && typeof accelerator !== "string")) return "invalid";
		const shortcut = accelerator === null ? "" : normalizeShortcut(accelerator);
		const current = shortcuts.get(plugin);
		if ((current ?? "") === shortcut) return "ok";
		if (current !== undefined) {
			globalShortcut.unregister(current);
			shortcuts.delete(plugin);
		}
		if (!shortcut) return "ok";
		// 同一个组合 Electron 只认一个回调，被另一个插件占着就和被别的程序占着一样。
		if ([...shortcuts.values()].includes(shortcut)) {
			console.warn(`[screen] ${plugin} 的快捷键 ${shortcut} 已经给了另一个插件`);
			return "taken";
		}
		try {
			// Windows 上 Alt+A 常被微信截图占着；注册失败只是返回 false，记一笔，用户说按了没反应时有据可查。
			if (!globalShortcut.register(shortcut, startFromShortcut)) {
				console.warn(`[screen] ${plugin} 的快捷键注册失败（多半被别的程序占着）：${shortcut}`);
				return "taken";
			}
		} catch (error) {
			console.warn(`[screen] ${plugin} 的快捷键写法不认识：${shortcut}`, error);
			return "invalid";
		}
		shortcuts.set(plugin, shortcut);
		scheduleWarm();
		return "ok";
	});

	ipcMain.handle("plume:screen:pick-directory", async (event, title: unknown): Promise<string | null> => {
		const options: OpenDialogOptions = { title: typeof title === "string" ? title : undefined, properties: ["openDirectory", "createDirectory"] };
		const window = BrowserWindow.fromWebContents(event.sender);
		const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});
	ipcMain.handle("plume:screen:desktop", () => app.getPath("desktop"));

	// 浮层页面 → 主进程。
	ipcMain.on("plume:screen:listening", (event) => overlayListening(event.sender));
	ipcMain.on("plume:screen:ready", (event, session: unknown) => {
		if (isOverlayPage(event.sender)) overlayReady(session);
	});
	ipcMain.handle("plume:screen:finish", async (event, png: unknown) => {
		if (isOverlayPage(event.sender)) await finishCapture(typeof png === "string" ? png : undefined);
	});
	// 取消什么都没产出，就什么都不挪：把 Plume 提到用户正在看的东西前面，和「算了」正相反。
	ipcMain.on("plume:screen:cancel", (event) => {
		if (isOverlayPage(event.sender)) closeOverlay({ foreground: false });
	});
	/**
	 * 钉住：浮层收起，同一时刻在选区原处开钉图窗口，看上去冻结的画面原地换成了一个真窗口。
	 * stepAside: false：从外面发起的截屏结束时本来会把整个应用藏起来，那会把刚开的钉图窗口一起藏掉。
	 */
	ipcMain.handle("plume:screen:pin", (event, png: unknown, at: unknown) => {
		if (!isOverlayPage(event.sender) || typeof png !== "string" || !isRect(at)) return;
		closeOverlay({ foreground: false, stepAside: false });
		pinShot(png, at);
	});
	ipcMain.handle("plume:screen:copy", async (event, png: unknown) => {
		if (isOverlayPage(event.sender) && typeof png === "string") await copyImage(png);
	});
	ipcMain.on("plume:screen:pass-through", (event, on: unknown) => {
		if (isOverlayPage(event.sender)) passThrough(on === true);
	});

	// 钉图页面 → 主进程。页面来要自己的图，而不是由这边推过去（见 pin.ts）。
	ipcMain.handle("plume:pin:request", (event) => pinnedImage(event.sender.id));
	ipcMain.on("plume:pin:ready", (event) => revealPin(event.sender.id));
	ipcMain.on("plume:pin:close", (event) => closePin(event.sender.id));
	ipcMain.on("plume:pin:drag-start", (event) => beginPinDrag(event.sender.id));
	ipcMain.on("plume:pin:drag-move", (event, dx: unknown, dy: unknown) => {
		if (typeof dx === "number" && typeof dy === "number") dragPin(event.sender.id, dx, dy);
	});

	// 应用被激活时系统会恢复它替应用留着的窗口，浮层不能是其中之一（见 dismissStrayOverlay）。
	app.on("did-become-active", dismissStrayOverlay);
	app.on("activate", showWindowsPutAside);
	/**
	 * 浮层一直不关、钉图窗口也不归别处管，有它们在，最后一个主窗口关掉时 window-all-closed 不会触发，进程就留在那里、
	 * 什么都看不见。最后一个主窗口关了就把它们一并放掉，window-all-closed 照常走。
	 */
	app.on("browser-window-created", (_event, created) => {
		created.once("closed", () => {
			const left = BrowserWindow.getAllWindows().filter((window) => window !== created && !window.isDestroyed() && !isOverlay(window) && !isPinWindow(window));
			if (left.length > 0) return;
			destroyOverlay();
			destroyPins();
		});
	});
	app.on("will-quit", () => globalShortcut.unregisterAll());
}
