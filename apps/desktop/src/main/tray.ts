/**
 * 菜单栏图标：不经过窗口也能用到应用。
 *
 * 一轮 agent 一跑就是几分钟，窗口大半时间关在后面或被别的挡着，「想问它一件事」不该从找窗口开始。
 * 菜单里有什么见 tray-menu.ts；这里管图标、怎么弹出来、每一项按下去做什么。
 *
 * macOS 和 Windows 上建。两个平台都是左键开关窗口、右键弹菜单，弹法不同：
 * - macOS 上 `setContextMenu` 会把单击整个接走，图标就只能弹菜单、不能开关窗口了，所以菜单在右键那一刻现做现弹，
 *   也就总是新的（最近会话、语言、开机启动）。
 * - Windows 上菜单经 `setContextMenu` 交给系统弹，左键照样发 `click`；自己接 `right-click` 会和系统对右键的处理抢。
 *   系统弹的是事先交过去的那一份，所以菜单里的东西可能变了的时候（窗口显隐、指针移到图标上）重做一份交过去。
 *
 * 图标也分平台：macOS 是 template 图，Windows 的通知区域本来就是彩色的，用彩色图（见 trayIcon）。
 */

import type { SessionSummary } from "@plume/contract";
import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions, type NativeImage, nativeImage, Tray } from "electron";
import tray125 from "../assets/tray/tray@1.25x.png?asset";
import tray150 from "../assets/tray/tray@1.5x.png?asset";
import tray2x from "../assets/tray/tray@2x.png?asset";
import tray1x from "../assets/tray/tray.png?asset";
import trayTemplate2x from "../assets/tray/trayTemplate@2x.png?asset";
import trayTemplate from "../assets/tray/trayTemplate.png?asset";
import type { AppCommand } from "../shared/app-command.ts";
import { resolvedLocale } from "./locale.ts";
import { type TrayAction, type TrayItem, trayMenu } from "./tray-menu.ts";

export interface TrayActions {
	window(): BrowserWindow;
	/** 把主窗口拿到前面来。 */
	reveal(): void;
	/** 把主窗口收起来，和关窗口一样（见 index.ts 的 hideMainWindow）。 */
	hide(): void;
	send(command: AppCommand): void;
	/** 会话摘要在 agent 进程里，弹菜单时问一次。 */
	sessions(): Promise<SessionSummary[]>;
}

let tray: Tray | null = null;

/** 两次重做 Windows 菜单至少隔多久：指针在图标上移动时一直有事件，最近会话要问一次 agent 进程。 */
const MENU_REFRESH_MS = 1_000;

/** 一张图按缩放比各给一份，系统按显示器挑最合适的那份，不现场缩放。 */
function scaledIcon(representations: [scaleFactor: number, path: string][]): NativeImage {
	const image = nativeImage.createEmpty();
	for (const [scaleFactor, path] of representations) {
		const source = nativeImage.createFromPath(path);
		if (!source.isEmpty()) image.addRepresentation({ scaleFactor, buffer: source.toPNG() });
	}
	return image;
}

/**
 * 菜单栏、通知区域的图标在 `build/tray/`。
 *
 * macOS 用 template 图：只看透明度，颜色由系统按菜单栏当时的前景色填，浅色、深色菜单栏、菜单拉下来时都对。
 * Windows 的通知区域本来就是彩色的，用彩色的那份，另备 125%、150%、200%：这几档是 Windows 笔记本最常见的缩放，
 * 没有正好那个尺寸的图时系统拿 16 或 32 的去缩，小图缩一下就糊了。
 */
function trayIcon(): NativeImage {
	if (process.platform === "darwin") {
		const image = scaledIcon([
			[1, trayTemplate],
			[2, trayTemplate2x],
		]);
		image.setTemplateImage(true);
		return image;
	}
	return scaledIcon([
		[1, tray1x],
		[1.25, tray125],
		[1.5, tray150],
		[2, tray2x],
	]);
}

function launchAtLogin(): boolean {
	try {
		return app.getLoginItemSettings().openAtLogin;
	} catch {
		return false;
	}
}

async function buildMenu(actions: TrayActions): Promise<Menu> {
	const sessions = await actions.sessions().catch(() => []);
	const menu = trayMenu({ windowVisible: actions.window().isVisible(), sessions, launchAtLogin: launchAtLogin(), locale: resolvedLocale() });
	return Menu.buildFromTemplate(toTemplate(menu, actions));
}

let lastRefresh = 0;

/** Windows：重做菜单交给系统。macOS 的菜单是弹的那一刻现做的，不用。 */
function refreshMenu(actions: TrayActions, force = true): void {
	if (!tray || process.platform === "darwin") return;
	const now = Date.now();
	if (!force && now - lastRefresh < MENU_REFRESH_MS) return;
	lastRefresh = now;
	void buildMenu(actions).then((menu) => tray?.setContextMenu(menu));
}

function perform(action: TrayAction, actions: TrayActions): void {
	switch (action.kind) {
		case "toggle-window": {
			const window = actions.window();
			if (window.isVisible() && !window.isMinimized()) actions.hide();
			else actions.reveal();
			break;
		}
		case "command":
			actions.send(action.command);
			break;
		case "toggle-login":
			try {
				app.setLoginItemSettings({ openAtLogin: !launchAtLogin() });
			} catch {
				// 菜单项没地方报错，勾就停在原来的样子。
			}
			refreshMenu(actions);
			break;
		case "quit":
			// quit 而不是 exit：before-quit 还要让 agent 进程收尾。
			app.quit();
			break;
	}
}

function toTemplate(items: TrayItem[], actions: TrayActions): MenuItemConstructorOptions[] {
	return items.map((item) => {
		if (item.type === "separator") return { type: "separator" };
		if (item.type === "submenu") return { label: item.label, submenu: toTemplate(item.items, actions) };
		return {
			label: item.label,
			...(item.checked === undefined ? {} : { type: "checkbox" as const, checked: item.checked }),
			...(item.enabled === false ? { enabled: false } : {}),
			click: () => perform(item.action, actions),
		};
	});
}

/** 在主窗口建好之后调：菜单里每一项最后都落到界面上，界面还没有时能点的菜单只会什么都不做。 */
export function createTray(actions: TrayActions): void {
	if (tray || (process.platform !== "darwin" && process.platform !== "win32")) return;
	const image = trayIcon();
	// 空图也能建出图标，只是看不见、也点不回来，和没建一样却更难查。
	if (image.isEmpty()) {
		console.warn("[tray] 菜单栏图标读不出来，不建菜单栏图标。");
		return;
	}
	tray = new Tray(image);
	tray.setToolTip("Plume");
	tray.on("click", () => perform({ kind: "toggle-window" }, actions));
	if (process.platform === "darwin") {
		tray.on("right-click", () => {
			void buildMenu(actions).then((menu) => tray?.popUpContextMenu(menu));
		});
	} else {
		// 「打开 / 隐藏」跟着窗口走；最近会话在指针移到图标上时重问一次，右键时交给系统的那份就是新的。
		const window = actions.window();
		window.on("show", () => refreshMenu(actions));
		window.on("hide", () => refreshMenu(actions));
		tray.on("mouse-move", () => refreshMenu(actions, false));
		refreshMenu(actions);
	}
	app.on("will-quit", () => {
		tray?.destroy();
		tray = null;
	});
}

/**
 * 有没有人看得见的图标。没有就别把关窗口当成收起来：Windows 上没有 Dock，图标是收起来以后唯一回去的路，
 * 图标没建出来时收起来的窗口就找不回了。
 */
export function hasTray(): boolean {
	return tray !== null;
}
