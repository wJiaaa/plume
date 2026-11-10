/**
 * 钉在桌面上的截图：一张图一个无边框、透明、置顶的小窗口，里面画插件经 `ui.pinnedShot` 注册的组件，直到它自己关掉。
 *
 * 和浮层分开放，是因为生命周期毫无关系：浮层只有一个、建一次、每次亮几秒；钉图窗口有很多个，截屏结束时建，
 * 按自己的关闭按钮时销毁，比之后的每一次截屏都活得久。
 *
 * 窗口由发消息的页面认（`webContents.id`），页面不传 id，一个钉图窗口也问不到、动不了另一个。
 */

import { BrowserWindow, nativeImage, screen } from "electron";
import type { ScreenRect } from "@plume/contract/ui";
import { loadScreenPage, screenPagePreferences } from "./page.ts";

/** 页面里的组件多久没把图画上（`ready`）就放弃这个窗口。页面要先连上 agent、装好插件的界面入口才画得出来，比单纯加载一页慢。 */
const PAINT_TIMEOUT_MS = 5_000;

interface PinnedImage {
	src: string;
	/** 逻辑像素，也是窗口的大小。 */
	width: number;
	height: number;
}

/** 屏上所有钉住的图。窗口都是置顶的、没有别处管它们，退出和主窗口关掉时要从这里一并放掉。 */
const pinned = new Set<BrowserWindow>();

/**
 * 每个窗口的图，等页面来要。按 `webContents.id` 记；读过也留着：渲染进程崩了重载时还得能再要一次，
 * 否则窗口回来是空的。窗口关掉时一起删。
 */
const images = new Map<number, PinnedImage>();

/** 每个窗口开始拖时在哪。页面给的是离按下点的偏移，按这个原点算。 */
const dragOrigins = new Map<number, { x: number; y: number }>();

export function isPinWindow(window: BrowserWindow): boolean {
	return pinned.has(window);
}

/**
 * 把一张图钉在 `at`（全局坐标、逻辑像素）。
 *
 * 窗口正好开在选区原来的位置、和选区一样大，看上去就是截下来的那一块留在了桌面上。大小以选区为准：
 * 拖出屏幕边的选区裁剪后图可能比框小一两个像素，窗口仍然站在框上，松手的指针还在它上面。
 */
export function pinShot(png: string, at: ScreenRect): void {
	const image = nativeImage.createFromDataURL(png);
	if (image.isEmpty()) {
		console.error("[screen] 要钉住的图解不开，没有开窗口");
		return;
	}
	const display = screen.getDisplayNearestPoint({ x: Math.round(at.x), y: Math.round(at.y) });
	const scale = display.scaleFactor || 1;
	const size = image.getSize();
	const width = Math.max(1, Math.round(at.width || size.width / scale));
	const height = Math.max(1, Math.round(at.height || size.height / scale));

	const window = new BrowserWindow({
		x: Math.round(at.x),
		y: Math.round(at.y),
		width,
		height,
		frame: false,
		transparent: true,
		// 图画上了再显示（`plume:pin:ready`）：之前露出来的是一块带阴影的透明框。
		show: false,
		alwaysOnTop: true,
		// 移动、缩放都由页面管：拖动区会把指针从页面拿走，悬停才出现的关闭按钮就出不来了；
		// 也没有 Dock 图标和窗口菜单可以最小化回去。
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: process.platform !== "darwin",
		// 系统阴影把图和底下的东西分开：白底文档的截图钉在白底文档上，没有阴影就看不出是一块独立的东西。
		hasShadow: true,
		acceptFirstMouse: true,
		// 窗口正好是图的大小，关闭按钮画在图里面：透明窗口按窗口框认点击，四周留一圈透明边会吃掉底下的点击。
		webPreferences: screenPagePreferences(),
	});
	// 在普通窗口之上，但不在菜单栏和别的应用的全屏空间之上：钉着的图不该盖住全屏视频。
	window.setAlwaysOnTop(true, "floating");
	// 切到别的桌面也还在；不跟进别的应用的全屏空间。skipTransformProcessType：不把整个进程切成 UIElement（那会让 Dock 图标消失）。
	// Windows 没有这项。
	if (process.platform !== "win32") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });

	// 现在就读 id：closed 时 webContents 已经销毁，再读会抛错。
	const pageId = window.webContents.id;
	window.on("closed", () => {
		pinned.delete(window);
		images.delete(pageId);
		dragOrigins.delete(pageId);
	});
	pinned.add(window);
	// 等页面来要，而不是 did-finish-load 时推过去：页面的组件要等插件的界面入口装好才订阅，推早了消息没人接，窗口就空着。
	images.set(pageId, { src: png, width, height });
	// 页面一直没画上就销毁，不显示：显示出来是一块看不见、却挡着鼠标的置顶窗口。
	setTimeout(() => {
		if (window.isDestroyed() || window.isVisible()) return;
		console.error(`[screen] 钉图窗口 ${PAINT_TIMEOUT_MS / 1000} 秒内没有画出图，已关掉`);
		window.destroy();
	}, PAINT_TIMEOUT_MS);

	loadScreenPage(window, "pinned-shot").catch((error: unknown) => {
		console.error("[screen] 钉图窗口打不开：", error);
		if (!window.isDestroyed()) window.destroy();
	});
}

function pinFor(pageId: number): BrowserWindow | null {
	for (const window of pinned) if (!window.isDestroyed() && window.webContents.id === pageId) return window;
	return null;
}

/** 页面来要自己的图；不是钉图窗口的页面拿到 null。 */
export function pinnedImage(pageId: number): PinnedImage | null {
	return images.get(pageId) ?? null;
}

/** 图画上了，显示窗口。不抢焦点：钉图发生在截屏结束的那一刻，用户正回到别的东西上。 */
export function revealPin(pageId: number): void {
	pinFor(pageId)?.showInactive();
}

export function closePin(pageId: number): void {
	pinFor(pageId)?.destroy();
}

export function beginPinDrag(pageId: number): void {
	const window = pinFor(pageId);
	if (!window) return;
	const [x = 0, y = 0] = window.getPosition();
	dragOrigins.set(pageId, { x, y });
}

/** 原点加偏移，不在当前位置上累加：累加会把每次的取整误差叠起来，还和还没落地的移动赛跑，窗口越拖越偏离指针。 */
export function dragPin(pageId: number, dx: number, dy: number): void {
	const origin = dragOrigins.get(pageId);
	const window = pinFor(pageId);
	if (!origin || !window || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
	window.setPosition(Math.round(origin.x + dx), Math.round(origin.y + dy));
}

export function destroyPins(): void {
	// 先拷一份：每个 destroy 都会触发窗口自己的 closed，回头改这个集合。
	for (const window of [...pinned]) if (!window.isDestroyed()) window.destroy();
}
