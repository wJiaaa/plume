/**
 * 截屏浮层：拍下指针所在的那块屏幕，用一个无边框、透明、盖住整块屏幕的窗口把快照铺上去，里面画插件经
 * `ui.screenOverlay` 注册的组件（选区、标注、工具栏都是插件的）。这里只管窗口、快照、焦点和剪贴板。
 *
 * 浮层只有一个窗口，建一次，之后整个进程里只藏起、亮出：
 *   - 每次截屏新建窗口、加载页面要一百多毫秒，快照是在这之前拍的，这段时间里屏幕上动了的东西，浮层一盖上就跳回去。
 *   - 收起时销毁窗口，macOS 上 `app.hide()` 不是同步的，窗口没了而应用还没藏好的那一两帧，主窗口会闪出来。
 * 一直留着的窗口两样都没有：亮出来是一次调用，藏起来可以等应用先藏好。
 */

import {
	app,
	BrowserWindow,
	clipboard,
	ClipboardItem,
	desktopCapturer,
	type Display,
	globalShortcut,
	nativeImage,
	screen,
	systemPreferences,
	type WebContents,
} from "electron";
import type { ScreenCaptureSession, ScreenRect } from "@plume/contract/ui";
import { canvasColorSpace, pickDisplaySource } from "./displays.ts";
import { loadScreenPage, screenPagePreferences } from "./page.ts";
import { isPinWindow } from "./pin.ts";

interface Snapshot {
	/** RGBA，物理像素，逐行排。 */
	pixels: Buffer;
	width: number;
	height: number;
	scaleFactor: number;
	colorSpace: "srgb" | "display-p3";
}

let overlay: BrowserWindow | null = null;
/** 浮层页面能接 session 了（见 `ensureOverlay`）。失败时清掉，下一次截屏重建。 */
let overlayLoading: Promise<BrowserWindow> | null = null;
/** 浮层页面订阅上 session 时调；页面在那之前没了就报错，等着它的截屏不会一直挂着。 */
let markListening: { resolve: () => void; reject: (error: Error) => void } | null = null;
/** 每开始一轮截屏加一。上一轮收起时排下的延时动作，看到它变了就不再碰窗口（窗口已经归新的一轮）。 */
let generation = 0;

/**
 * 这一次截屏的全部状态，收在一个对象里：一轮结束该清掉哪些只在 `endCapture` 一处，加字段也有一处明确该改的地方。
 * 逐个字段改，不整体替换：`escapeHeld` 记着全局 Esc 是不是注册着，连同别的字段一起重置会让它注册着却没人记得；
 * 计时器是宿主资源，先 clearTimeout 再丢。
 */
interface Capture {
	/** 第几次截屏，跨轮单调递增；浮层页面按它认「这是新的一次」。 */
	id: number;
	/**
	 * 屏上有一次本该在那里的截屏。记下来而不是问 `overlay.isVisible()`：藏起来的应用里的窗口报不可见，
	 * 跟着应用被系统恢复出来的窗口报可见、背后却没有截屏。`dismissStrayOverlay` 靠这个分辨。
	 */
	active: boolean;
	/** 页面一直不说画好了（ready）时作废这一轮的计时器。 */
	failsafe: NodeJS.Timeout | null;
	/**
	 * 这一轮藏起来的主窗口。浮层一激活就激活了 Plume，macOS 会把应用的所有窗口都提上来，主窗口就压在用户正在截的东西上面、
	 * 藏在冻结画面底下，画面一撤就露出来；浮层点击穿透时它还吃掉所有点击。所以从 Plume 外面发起的截屏期间把它藏起来。
	 */
	steppedAside: BrowserWindow | null;
	/**
	 * 截屏开始时 Plume 在不在前面。决定结束后前台给谁：从 Plume 里发起的，完成后回到 Plume（图要送到这里）；
	 * 在别的应用里按全局快捷键发起的，不该把人拽进 Plume。
	 */
	cameFromApp: boolean;
	/** 截屏开始时有焦点的那个 Plume 窗口，取消时在浮层撤走之前把焦点还给它（见 `hideOnceRefocused`）。 */
	focusedBefore: BrowserWindow | null;
	/**
	 * 截屏期间注册着的全局 Esc。浮层亮出时不抢焦点，页面在被点之前听不到按键，取消得在那之前就能用；
	 * 一结束就放掉，不在别处挡着这个键。注册着时页面自己的 keydown 也听不到 Esc，所以由 `escapePressed` 转给页面。
	 */
	escapeHeld: boolean;
}

const idleCapture = (id: number): Capture => ({
	id,
	active: false,
	failsafe: null,
	steppedAside: null,
	cameFromApp: false,
	focusedBefore: null,
	escapeHeld: false,
});

let capture: Capture = idleCapture(0);

/** 这一轮等着页面说「背景画好了」的亮出动作。页面报的 session id 对不上就不认。 */
let pendingReveal: { session: number; reveal: () => void } | null = null;

/**
 * 「窗口已经上屏、还没画出东西」的状态：`window` 有值时 `fallback` 必须挂着。和 `Capture` 分开，是因为预热那次发生在任何截屏之前。
 */
const paint: { warming: NodeJS.Timeout | null; window: BrowserWindow | null; wait: object | null; fallback: NodeJS.Timeout | null } = {
	warming: null,
	window: null,
	wait: null,
	fallback: null,
};

/** 被截屏藏起来、还没回到屏上的主窗口。点 Dock 图标时由 `showWindowsPutAside` 放回来。 */
const putAside = new Set<BrowserWindow>();

/** 页面画出第一帧的等待上限：等不到也亮出来，不让一个透明的全屏窗口挡着所有点击。 */
const PAINT_FALLBACK_MS = 250;
/** 页面多久没说背景画好了就作废这一轮。防的是插件的浮层组件出错或没调 `ready()`，不是慢。 */
const READY_TIMEOUT_MS = 1_500;
/** 两帧：透明度的变化先上屏，再把窗口撤掉。 */
const TRANSPARENT_BEFORE_HIDE_MS = 34;
/** 两帧：刚拿到焦点的窗口来得及按激活的样子重画。 */
const REFOCUS_REPAINT_MS = 34;
/** 等一个可能永远不来的 focus，最多这么久。 */
const REFOCUS_GIVE_UP_MS = 200;
/** 接管上一轮还开着的浮层时，清空它之后等合成器把它从屏幕上拿掉再拍：拍早了快照里还有上一轮的选框和手柄。 */
const CLEAR_SETTLE_MS = 32;
/** Linux 上浮层是藏起来而不是淡掉，等 unmap 到达 X server / Wayland 合成器并重绘。 */
const HIDE_SETTLE_MS = 80;

/** 在页面里等下一帧：动画帧回调运行时，合成出来的帧已经存在。 */
const NEXT_FRAME = "new Promise((done) => requestAnimationFrame(() => done(true)))";

export function isOverlay(window: BrowserWindow): boolean {
	return overlay !== null && window === overlay;
}

/** 消息是不是浮层页面发的。 */
export function isOverlayPage(sender: WebContents): boolean {
	return overlay !== null && !overlay.isDestroyed() && overlay.webContents === sender;
}

/**
 * Linux 上 `setOpacity` 什么也不做：凡是「先透明再亮」的步骤都会原样显示窗口，接管上一轮时只能把它藏起来；
 * 预热时那次「隐形的首次显示」也会真的显示出来。
 */
const opacityUnsupported = process.platform === "linux";

function clearFailsafe(): void {
	if (capture.failsafe) clearTimeout(capture.failsafe);
	capture.failsafe = null;
	if (paint.fallback) clearTimeout(paint.fallback);
	paint.fallback = null;
	paint.window = null;
	paint.wait = null;
}

/** 这一轮结束了：放掉属于它的东西。`steppedAside` 不在这里，主窗口回不回来取决于怎么结束的，由调用方决定。 */
function endCapture(): void {
	capture.active = false;
	pendingReveal = null;
	holdEscape(false);
	clearFailsafe();
}

function releaseSteppedAside(): BrowserWindow | null {
	const main = capture.steppedAside;
	capture.steppedAside = null;
	if (!main || main.isDestroyed()) return null;
	return main;
}

function holdEscape(on: boolean): void {
	if (on === capture.escapeHeld) return;
	try {
		if (on) capture.escapeHeld = globalShortcut.register("Escape", escapePressed);
		else {
			globalShortcut.unregister("Escape");
			capture.escapeHeld = false;
		}
	} catch {
		capture.escapeHeld = false;
	}
}

/** Esc 交给页面，让它像按取消一样收起（有淡出）；页面已经没了就直接收，不留一块 Esc 撤不掉的全屏窗口。 */
function escapePressed(): void {
	const page = overlay && !overlay.isDestroyed() ? overlay.webContents : null;
	if (!page || page.isDestroyed() || page.isCrashed()) {
		closeOverlay({ foreground: false });
		return;
	}
	page.send("plume:screen:escape");
}

/** Plume 自己的主窗口（不是浮层、不是钉图窗口）。 */
function mainWindow(predicate: (window: BrowserWindow) => boolean = () => true): BrowserWindow | undefined {
	return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window !== overlay && !isPinWindow(window) && predicate(window));
}

/**
 * 拍一块屏幕，交回 RGBA 像素。`thumbnailSize` 给的是物理像素：`desktopCapturer` 会把画面缩到给定的框里，
 * Retina 屏按逻辑尺寸要，回来的就只有一半分辨率。
 */
async function captureDisplay(display: Display): Promise<Snapshot | null> {
	const scaleFactor = display.scaleFactor || 1;
	// 还没给屏幕录制权限是一种状态，不是错误：去拍一次就是请系统弹出它自己的授权提示（那就是全部的说明），
	// 这一次安静地返回。权限给了以后要重启进程才生效，所以授权的结果要到之后的某一次才看得到。
	if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
		await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
		return null;
	}
	try {
		const sources = await desktopCapturer.getSources({
			types: ["screen"],
			thumbnailSize: { width: Math.round(display.bounds.width * scaleFactor), height: Math.round(display.bounds.height * scaleFactor) },
			fetchWindowIcons: false,
		});
		// macOS 拒绝权限时不报错，只是一张也不给；明说出来，否则表现只是快捷键按了没反应。
		if (sources.length === 0) {
			console.error("[screen] 没有拿到任何屏幕画面，多半是没有屏幕录制权限");
			return null;
		}
		const choice = pickDisplaySource(
			sources.map((source) => ({ id: source.id, display_id: source.display_id, size: source.thumbnail.getSize() })),
			screen.getAllDisplays().map((other) => ({ id: other.id, bounds: other.bounds, scaleFactor: other.scaleFactor || 1 })),
			display.id,
		);
		// 多块屏幕又没凭 display_id 挑的（Windows 走 GDI 抓屏时它是空串）记一笔：「截到的是另一块屏幕」时要知道当时凭的是什么。
		if (choice && choice.how !== "display-id" && choice.how !== "only-one") {
			console.info("[screen] 按", choice.how, "挑的画面", {
				wanted: display.id,
				picked: choice.index,
				candidates: sources.map((source) => ({ id: source.id, display_id: source.display_id, size: source.thumbnail.getSize() })),
			});
		}
		const image = choice ? sources[choice.index]!.thumbnail : undefined;
		if (!image || image.isEmpty()) {
			console.error("[screen] 拍到的画面是空的");
			return null;
		}
		const size = image.getSize();
		// 直接给像素，不编码成 PNG：整屏 PNG 编码要上百毫秒，还得在页面里再解一遍，这段时间都算在浮层落下之前。
		// 平台给的是 BGRA，换成 ImageData 要的 RGBA；放在这里换，免得在要画图的那个线程上跑一遍几十 MB 的循环。
		const pixels = image.toBitmap();
		for (let i = 0; i < pixels.length; i += 4) {
			const b = pixels[i]!;
			pixels[i] = pixels[i + 2]!;
			pixels[i + 2] = b;
		}
		const colorSpace = canvasColorSpace(display.colorSpace);
		// 浮层落下前的等待几乎全在这里：getSources 是系统拍照，toBitmap、换通道是 Plume 自己花的。
		return { pixels, width: size.width, height: size.height, scaleFactor, colorSpace };
	} catch (error) {
		console.error("[screen] 拍屏幕失败：", error);
		return null;
	}
}

/**
 * 浮层窗口和它的页面，第一次用时建好，一直留着。
 *
 * 等到页面订阅上 session 才算好，而不是 did-finish-load：页面要先连上 agent、装好插件的界面入口，才开始听，
 * 在这之前发过去的 session 没人接，直接丢掉。
 */
function ensureOverlay(): Promise<BrowserWindow> {
	if (overlay && !overlay.isDestroyed() && overlayLoading) return overlayLoading;

	const bounds = screen.getPrimaryDisplay().bounds;
	const window = new BrowserWindow({
		...bounds,
		frame: false,
		transparent: true,
		// 快照画上了才亮出来（见 `revealOverlay`）；两次截屏之间也一直藏着。
		show: false,
		alwaysOnTop: true,
		skipTaskbar: process.platform !== "darwin",
		resizable: false,
		movable: false,
		fullscreenable: false,
		// 整块屏幕大的窗口，阴影只会落到屏幕外面。
		hasShadow: false,
		// 第一下按在画布上，而不是花在激活应用上。
		acceptFirstMouse: true,
		enableLargerThanScreen: true,
		webPreferences: screenPagePreferences(),
	});
	// screen-saver 层：盖得住别的应用的全屏空间和菜单栏，才拍得了它们。
	window.setAlwaysOnTop(true, "screen-saver");
	// skipTransformProcessType：不然 Electron 会把整个进程切成 UIElement，Dock 图标就没了，而且不会切回来。
	// visibleOnFullScreen 加上面的层级已经够盖住全屏应用。
	window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
	// 再设一次大小：窗口建在工作区里（屏幕减去菜单栏和 Dock），要等上面的层级允许它伸出去，整屏的大小才生效。
	// 必须在建窗口时就设对：窗口第一次上屏时按当时的大小分配画面，短了的那块会被拉伸一两帧，看上去整个屏幕缩放了一下。
	window.setBounds(bounds);

	window.on("closed", () => {
		// i18n-exempt：给插件作者看的报错，经 ui.screen.start() 的 rejection 到插件。
		markListening?.reject(new Error("截屏浮层窗口在页面准备好之前关掉了"));
		markListening = null;
		if (overlay === window) {
			overlay = null;
			overlayLoading = null;
			if (capture.active) endCapture();
		}
	});
	// 渲染进程没了，页面不会再订阅：销毁它，下一次截屏重建，不留一个发什么都没人接的浮层。
	window.webContents.on("render-process-gone", () => {
		if (!window.isDestroyed()) window.destroy();
	});

	overlay = window;
	const loading = new Promise<BrowserWindow>((resolve, reject) => {
		markListening = {
			resolve: () => {
				markListening = null;
				resolve(window);
			},
			reject,
		};
		loadScreenPage(window, "screen-overlay").catch((error: unknown) => {
			// 清掉，下一次截屏重建，而不是去等一个永远不会落定的 promise。
			if (!window.isDestroyed()) window.destroy();
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
	overlayLoading = loading;
	return loading;
}

/** 浮层页面订阅上了 session。 */
export function overlayListening(sender: WebContents): void {
	if (isOverlayPage(sender)) markListening?.resolve();
}

/**
 * 在启动后空闲时把浮层建好，第一次截屏和之后的一样快。
 *
 * Linux 上只建窗口：「隐形的首次显示」靠 setOpacity(0)，那里会真的显示一块全屏窗口；预热的那次拍屏在 Wayland 上
 * 是一个「屏幕共享」对话框，每次启动都弹。
 */
export function warmOverlay(): void {
	ensureOverlay()
		.then((window) => {
			if (!opacityUnsupported) warmFirstPresentation(window);
		})
		.catch((error: unknown) => console.error("[screen] 预热截屏浮层失败：", error));
	if (process.platform !== "linux") void warmCapturePipeline();
}

/**
 * 把浮层隐形地显示一次，让它真正第一次出现时不是第一次。
 *
 * 建好但从没显示过的窗口在窗口服务器上还没有画面，第一次显示要建图层、分配画面、栅格化页面，做完之前没有对的东西可显示。
 * 在没人等的时候以透明度 0 做掉。用透明度而不是挪到屏幕外：停在屏幕外的窗口可能按另一个大小分到画面。
 */
function warmFirstPresentation(window: BrowserWindow): void {
	if (window.isDestroyed() || window.isVisible()) return;
	window.setOpacity(0);
	// 看不见不等于不在：透明的全屏置顶窗口照样吃掉屏幕上的每一下点击，这几帧里它必须不挡鼠标。
	window.setIgnoreMouseEvents(true);
	window.showInactive();
	// 要等合成器出一帧（分配画面的就是这一帧），早藏回去就白做了。
	paint.warming = setTimeout(() => {
		paint.warming = null;
		if (window.isDestroyed()) return;
		window.hide();
		window.setOpacity(1);
	}, 220);
}

/** 真截屏要用窗口了，立刻结束隐形的预热显示：不然 `revealOverlay` 会当它已经亮着，这一次截屏就是一块全透明的窗口。 */
function endWarmPresentation(): void {
	if (!paint.warming) return;
	clearTimeout(paint.warming);
	paint.warming = null;
	if (!overlay || overlay.isDestroyed()) return;
	overlay.hide();
	overlay.setOpacity(1);
}

/**
 * 拍一张没人看的，让第一次真截屏快一些：macOS 第一次建抓屏流要协商配置、分配缓冲区，比之后的每一次慢一百来毫秒，
 * 快照是在这段等待开始时拍的，期间屏幕上动了的东西浮层一落下就跳回去。按整屏大小拍，走的才是真截屏那条路。
 * 只在已经有权限时做：启动三秒后无缘无故弹出授权对话框，比第一次截屏慢一点糟得多。
 */
async function warmCapturePipeline(): Promise<void> {
	if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
		return;
	}
	const display = screen.getPrimaryDisplay();
	const scale = display.scaleFactor || 1;
	await desktopCapturer
		.getSources({
			types: ["screen"],
			thumbnailSize: { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) },
			fetchWindowIcons: false,
		})
		// 预热失败只是第一次截屏没有提前量。
		.catch(() => undefined);
}

/**
 * 开始一次截屏：指针所在的那块屏幕。拿不到快照（没有屏幕录制权限、拍失败）时返回 false，不开浮层。
 */
export async function startCapture(): Promise<boolean> {
	// 在任何东西显示之前问：过一会儿浮层自己就是有焦点的窗口，答案永远是「是」。
	const windows = BrowserWindow.getAllWindows();
	capture.cameFromApp = windows.some((window) => !window.isDestroyed() && window.isFocused());
	capture.focusedBefore = windows.find((window) => window !== overlay && !window.isDestroyed() && window.isFocused()) ?? null;

	generation++;
	endWarmPresentation();
	// 上一轮还开着（连按两次快捷键）：收掉但不交还前台，这一轮马上要接手。
	closeOverlay({ restoreFocus: false });

	const cursor = screen.getCursorScreenPoint();
	const display = screen.getDisplayNearestPoint(cursor);
	const { bounds } = display;
	const takingOver = await clearOverlayForSnapshot();
	// 快照和窗口一起等：浮层落下前的等待就是桌面看上去跳一下的原因。第一次之后窗口早就建好了，剩下的只有拍屏本身。
	const [snapshot, window] = await Promise.all([captureDisplay(display), ensureOverlay()]);
	if (!snapshot || window.isDestroyed()) {
		// 为一张没来的快照清空了的浮层是透明的、在一切之上，不能留着。
		if (takingOver) dropClearedOverlay();
		return false;
	}
	// 从这里起屏上的浮层是有意的。在动窗口之前就记上，亮出的任何安排都不会出现「它在屏上、这里却说没人要它」。
	capture.active = true;
	coverDisplay(window, bounds);
	// 撤掉上一次取色留下的点击穿透和预热留下的透明度：这一次是要被看、被画的。
	window.setIgnoreMouseEvents(false);
	// 接管上一轮时窗口是为这一轮的快照清空的，要等这一轮的画面上去再不透明，否则先闪回上一轮的选区。
	if (!takingOver) window.setOpacity(1);
	return handOff(window, snapshot, bounds, cursor, takingOver);
}

/**
 * 把快照交给页面，并安排它什么时候上屏。页面画好背景会说 ready（`overlayReady`），这时才亮出来。
 */
function handOff(window: BrowserWindow, snapshot: Snapshot, bounds: ScreenRect, cursor: { x: number; y: number }, takingOver: boolean): boolean {
	const id = ++capture.id;
	pendingReveal = { session: id, reveal: () => revealOverlay(window, takingOver) };
	// 页面一直没说 ready（插件的浮层组件出错、或者忘了调）：作废这一轮，而不是亮出一块可能什么都没画的全屏窗口——
	// 它挡着所有点击，Esc 也要靠那个组件来响应。
	capture.failsafe = setTimeout(() => {
		console.error(`[screen] 截屏浮层 ${READY_TIMEOUT_MS} 毫秒内没有说背景画好了（ready），这一次作废`);
		endCapture();
		dropClearedOverlay();
	}, READY_TIMEOUT_MS);

	if (window.webContents.isDestroyed()) {
		endCapture();
		if (takingOver) dropClearedOverlay();
		return false;
	}
	const session: Omit<ScreenCaptureSession, "snapshot"> = {
		id,
		bounds,
		scaleFactor: snapshot.scaleFactor,
		colorSpace: snapshot.colorSpace,
		// 指针已经在哪，换成浮层自己的坐标：不给的话，指针不动就没有 pointermove，页面不知道它在哪。
		cursor: { x: cursor.x - bounds.x, y: cursor.y - bounds.y },
	};
	// 像素经结构化克隆过去，页面那边是 Uint8Array（renderer/screen.tsx 换成 Uint8ClampedArray）。
	window.webContents.send("plume:screen:session", { ...session, snapshot: { pixels: snapshot.pixels, width: snapshot.width, height: snapshot.height } });
	return true;
}

/** 页面说这一轮的背景画好了。别的轮次、或者已经结束的，不认。 */
export function overlayReady(session: unknown): void {
	if (!pendingReveal || pendingReveal.session !== session) return;
	const { reveal } = pendingReveal;
	pendingReveal = null;
	reveal();
}

/**
 * 把浮层送上屏。
 *
 * 已经在屏上（接管了上一轮）：窗口不动，只换了画面；要重新拿焦点——不是 key window 的窗口在 macOS 上收不到 mouseMoved 和按键。
 *
 * 第一次显示：先以透明度 0 上屏，等页面合成出一帧再不透明（`awaitPaint`）；「背景画好了」只说明画进了 canvas 的位图，
 * 不说明合成出来了，没合成好的画面会被拉伸着显示。上屏不抢焦点，隔两帧再激活：`show()` 会激活应用并把应用的其他窗口
 * 从未激活的样子重画成激活的样子，落在浮层第一帧之前就是桌面在眼前动了一下；但激活又必须做，非 key window 收不到指针移动。
 * 等待期间 Esc 由全局快捷键接着。
 */
function revealOverlay(window: BrowserWindow, takingOver: boolean): void {
	clearFailsafe();
	if (window.isDestroyed()) return;
	if (window.isVisible()) {
		holdEscape(true);
		window.focus();
		if (takingOver) awaitPaint(window);
		return;
	}
	window.setOpacity(0);
	window.showInactive();
	holdEscape(true);
	awaitPaint(window);
	setTimeout(() => {
		if (window.isDestroyed()) return;
		window.focus();
	}, 32);
}

/** 窗口透明着，等页面报一帧再显出来；等不到也在 `PAINT_FALLBACK_MS` 后显出来。 */
function awaitPaint(window: BrowserWindow): void {
	const wait = {};
	paint.window = window;
	paint.wait = wait;
	paint.fallback = setTimeout(() => {
		overlayPainted(wait);
	}, PAINT_FALLBACK_MS);
	window.webContents.executeJavaScript(NEXT_FRAME).then(
		() => overlayPainted(wait),
		() => undefined,
	);
}

function overlayPainted(wait: object): void {
	if (paint.wait !== wait) return;
	if (paint.fallback) clearTimeout(paint.fallback);
	paint.fallback = null;
	const window = paint.window;
	paint.window = null;
	paint.wait = null;
	if (!window || window.isDestroyed() || !window.isVisible()) return;
	window.setOpacity(1);
	stepMainAside(window);
}

/**
 * 截屏期间把主窗口藏起来（理由见 `Capture.steppedAside`）。
 *
 * 用 hide 不用透明度：透明的窗口还在窗口列表里、还接点击。在浮层不透明、盖满屏幕之后才藏，否则藏的那一下看得见；
 * 藏窗口会让 macOS 重新分配 key window，浮层会因此丢掉 mouseMoved 和按键，所以立刻把焦点拿回来。
 * 只在 macOS：只有它在激活应用时把兄弟窗口提上来；Windows 上藏起来会连任务栏条目一起没了，取消和外部截屏都不会还回来。
 */
function stepMainAside(window: BrowserWindow): void {
	if (process.platform !== "darwin") return;
	if (capture.cameFromApp || capture.steppedAside) return;
	const main = mainWindow((other) => other.isVisible());
	if (!main) return;
	main.hide();
	capture.steppedAside = main;
	putAside.add(main);
	if (!window.isDestroyed()) window.focus();
}

/**
 * 把浮层挪到这块屏幕上，再确认真到了。跨 DPI 不同的屏幕时 Windows 会按两块屏的缩放比换算一道刚设好的大小，
 * 浮层盖不满，边上留出一条活的桌面；第二次是在新屏幕的 DPI 下设的，不会再被换算。差一个像素不算（来回换算的取整）。
 */
function coverDisplay(window: BrowserWindow, bounds: ScreenRect): void {
	const off = (): boolean => {
		const got = window.getBounds();
		return (
			Math.abs(got.width - bounds.width) > 1 || Math.abs(got.height - bounds.height) > 1 || Math.abs(got.x - bounds.x) > 1 || Math.abs(got.y - bounds.y) > 1
		);
	};
	window.setBounds(bounds);
	if (off()) window.setBounds(bounds);
}

/**
 * 接管上一轮还开着的浮层时，先把它从要拍的画面里拿掉：`desktopCapturer` 拍的是合成后的屏幕，里面有上一轮的选框、
 * 手柄和工具栏，再钉一次就带着它们。用透明度而不是 hide：留在原处的窗口保留着它的画面，藏起来的要重新上屏。
 * 返回做没做，因为之后都得知道：窗口现在看不见、在一切之上、还挡着鼠标（见 `dropClearedOverlay`）。
 */
async function clearOverlayForSnapshot(): Promise<boolean> {
	const window = overlay;
	if (!window || window.isDestroyed() || !window.isVisible()) return false;
	if (opacityUnsupported) {
		window.hide();
		await new Promise((done) => setTimeout(done, HIDE_SETTLE_MS));
		return true;
	}
	window.setOpacity(0);
	await new Promise((done) => setTimeout(done, CLEAR_SETTLE_MS));
	return true;
}

/**
 * 收起一个不会再显示的浮层：放开鼠标、藏起来、恢复透明度，告诉页面丢掉快照。凡是不再往下显示浮层的出路都经过这里——
 * 一块全屏、置顶、看不见却挡着鼠标的窗口，在用户看来就是机器不响应了。
 */
function dropClearedOverlay(): void {
	const window = overlay;
	if (!window || window.isDestroyed()) return;
	window.setIgnoreMouseEvents(true);
	window.hide();
	window.setOpacity(1);
	if (!window.webContents.isDestroyed()) window.webContents.send("plume:screen:hidden");
}

/**
 * 收起浮层，并决定前台给谁。
 *
 * 浮层在 screen-saver 层、所有桌面上都有，撤掉时 macOS 把前台交给底下的应用，可能是 Plume 之前打开的随便什么，
 * 主窗口被压在两个应用后面，看上去就是应用消失了。所以前台怎么交是明写的。
 *
 * - `restoreFocus: false`：下一轮马上接手，浮层原地留着。
 * - `foreground`：要不要把 Plume 提到前面；默认看截屏是不是从 Plume 里发起的。
 * - `stepAside: false`：不许把整个应用藏起来。只有钉图用：`app.hide()` 藏的是应用的所有窗口，紧接着开的钉图窗口也会一起被藏掉。
 */
export function closeOverlay(options?: { restoreFocus?: boolean; foreground?: boolean; stepAside?: boolean }): void {
	const cover = overlay && !overlay.isDestroyed() && overlay.isVisible() ? overlay : null;
	// 在任何提前返回之前：每条出路都结束这一轮，哪条漏了都会让 `dismissStrayOverlay` 永远不碰这个窗口。
	endCapture();
	const steppedAside = releaseSteppedAside();
	if (!cover) {
		return;
	}

	const foreground = options?.foreground ?? capture.cameFromApp;
	/*
	 * 从外面发起的截屏结束（完成或取消），macOS 上把整个应用连同浮层一起藏起来，前台自然回到原来的应用。
	 * `app.hide()` 不是同步的：先撤浮层，应用还没藏好的那十几毫秒里主窗口会露出来，就是那一下闪。浮层留在屏上跟着
	 * 一起下去，等藏好了再标成隐藏（`settleOverlayHidden`）。
	 */
	const stepBack = process.platform === "darwin" && options?.restoreFocus !== false && options?.stepAside !== false && !foreground && !capture.cameFromApp;
	if (stepBack) {
		app.hide();
		settleOverlayHidden();
		return;
	}

	if (options?.restoreFocus === false) {
		return;
	}

	const main = steppedAside ?? mainWindow((window) => window !== cover);

	/*
	 * 取消什么都不挪：从 Plume 里取消时主窗口本来就在屏上，showInactive 的唯一效果是把它提到用户正在看的东西前面，
	 * 那就是截屏结束时的一闪。浮层撤掉后焦点回到它底下的窗口，也就是它来的地方。
	 * 例外是截屏开始时有焦点的那个 Plume 窗口：在浮层撤走之前把焦点还给它（见 `hideOnceRefocused`）。
	 */
	if (!foreground) {
		const back = capture.focusedBefore;
		capture.focusedBefore = null;
		if (back && back !== cover && !back.isDestroyed() && back.isVisible() && !back.isMinimized()) {
			hideOnceRefocused(cover, back);
			return;
		}
		takeOverlayOff(cover);
		settleOverlayHidden();
		return;
	}

	/*
	 * 完成就把 Plume 提到前面，而且在浮层底下做：先撤浮层再激活，主窗口会带着未激活的样子在屏上停三四帧再变；
	 * 先激活，变化发生在浮层还盖着的时候。app.focus({ steal: true }) 是 macOS 上关键的那一步：只 show、focus 一个
	 * 不在前台的应用的窗口，只会在应用内部把它提上来，应用本身还在后面。
	 */
	if (main) {
		if (main.isMinimized()) main.restore();
		main.show();
		putAside.delete(main);
		main.focus();
		app.focus({ steal: true });
	}
	takeOverlayOff(cover);
	settleOverlayHidden();
}

/**
 * 不让 macOS 播放动画地把浮层撤下：可见窗口的 hide 是 orderOut，窗口服务器可以给它加动画，一块冻结着整屏画面的窗口
 * 动起来就是「按 Esc 屏幕抽一下」。先把透明度降到 0（即时的），隔两帧再 hide，那时已经没有东西可看。中间穿透点击。
 * Linux 没有窗口透明度，直接 hide。
 */
function takeOverlayOff(cover: BrowserWindow): void {
	if (opacityUnsupported) {
		cover.hide();
		return;
	}
	const owner = generation;
	cover.setIgnoreMouseEvents(true);
	cover.setOpacity(0);
	setTimeout(() => {
		// 这期间开始的下一轮截屏接管了窗口，透明度由它恢复。
		if (!cover.isDestroyed() && generation === owner) cover.hide();
	}, TRANSPARENT_BEFORE_HIDE_MS);
}

/**
 * 先把焦点还给截屏开始时的那个窗口，再撤浮层。浮层有焦点时，底下那个窗口是未激活的样子，而冻结的画面里它是激活的；
 * 先撤再让系统还焦点，屏幕会从激活变未激活再变回来，就是「按 Esc 整个屏幕抽一下」。这个顺序下变化发生在浮层盖着的时候。
 * 等不到 focus（窗口中途关了）就放弃等待照样撤：抽一下比留一块浮层在屏上小得多。
 */
function hideOnceRefocused(cover: BrowserWindow, back: BrowserWindow): void {
	const owner = generation;
	let settled = false;
	const hide = () => {
		if (settled) return;
		settled = true;
		clearTimeout(giveUp);
		if (!back.isDestroyed()) back.removeListener("focus", onFocus);
		// 这期间开始了下一轮，浮层归它了。
		if (generation !== owner || cover.isDestroyed()) return;
		takeOverlayOff(cover);
		settleOverlayHidden();
	};
	const onFocus = () => setTimeout(hide, REFOCUS_REPAINT_MS);
	const giveUp = setTimeout(hide, REFOCUS_GIVE_UP_MS);
	if (back.isFocused()) {
		onFocus();
		return;
	}
	back.once("focus", onFocus);
	back.focus();
}

/**
 * 应用藏好以后把浮层标成隐藏，并告诉页面丢掉快照。
 *
 * 无条件 hide，不先问 isVisible：藏起来的应用里每个窗口都报不可见，而走到这里的那条路正是把应用藏起来的那条，
 * 一问就永远不 hide——窗口跟着应用下去、又跟着应用回来，点 Dock 图标就冒出一块全屏、置顶、空的、还挡着鼠标的窗口。
 * 放开鼠标也在这里：窗口万一被什么放回屏上，也不会再挡住整台机器；下一轮截屏开始时会再关掉穿透。
 * 丢快照要等窗口离开屏幕：页面一丢，冻结的桌面就从画布上没了，浮层还在屏上时那就是一下白闪。快照是整屏的原始像素，
 * 几十 MB，没理由让一个没人看的窗口一直攥着。
 */
function settleOverlayHidden(): void {
	const owner = generation;
	setTimeout(() => {
		const window = overlay;
		// 这期间开始了下一轮：窗口和页面上的 session 都是它的了。
		if (!window || window.isDestroyed() || generation !== owner) return;
		window.hide();
		window.setIgnoreMouseEvents(true);
		if (!window.webContents.isDestroyed()) window.webContents.send("plume:screen:hidden");
	}, 250);
}

/** 完成：收起浮层；给了图就放进剪贴板。 */
export async function finishCapture(png: string | undefined): Promise<void> {
	closeOverlay();
	if (png) await copyImage(png);
}

/** 一张图作为 PNG 放进剪贴板。经 nativeImage 转一道，粘出去的格式是确定的。 */
export async function copyImage(png: string): Promise<void> {
	const image = nativeImage.createFromDataURL(png);
	if (image.isEmpty()) {
		console.error("[screen] 要放进剪贴板的图解不开");
		return;
	}
	await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
}

/**
 * 浮层暂时让鼠标点到底下去、Esc 也不再拦：截屏在屏上已经结束了，只剩一条提示（比如「已复制色值」）还挂着，
 * 这时它不该再像截屏那样挡着桌面和 Esc。提示淡完后页面自己调 cancel 收起。
 */
export function passThrough(on: boolean): void {
	const window = overlay && !overlay.isDestroyed() ? overlay : null;
	if (on) {
		holdEscape(false);
		window?.setIgnoreMouseEvents(true);
		return;
	}
	if (!capture.active || !window) return;
	window.setIgnoreMouseEvents(false);
	holdEscape(true);
}

/**
 * 浮层在屏上、背后却没有截屏时把它撤下。应用被激活时调——系统替它留着的窗口就是这时回来的；连扫三次，
 * 因为 did-become-active 和窗口真正回来没有先后保证，先扫的那次可能什么都看不到。不先问 isVisible：
 * 应用从隐藏回来要几百毫秒才恢复窗口，这期间 isVisible 一直是 false。藏一个已经藏着的窗口什么也不花。
 */
export function dismissStrayOverlay(): void {
	const sweep = (): void => {
		if (capture.active) return;
		const window = overlay;
		if (!window || window.isDestroyed()) return;
		window.setIgnoreMouseEvents(true);
		window.hide();
	};
	sweep();
	setTimeout(sweep, 150);
	setTimeout(sweep, 600);
}

/**
 * 点 Dock 图标时把截屏藏起来的主窗口放回来。从外面截屏、取消或者整个应用被藏起来以后，主窗口还藏着，
 * 应用被激活时系统只恢复藏应用那一刻可见的窗口，没有这一步，点 Dock 图标什么也不发生。
 */
export function showWindowsPutAside(): void {
	if (capture.active) return;
	for (const window of putAside) {
		if (!window.isDestroyed() && !window.isVisible()) window.show();
	}
	putAside.clear();
}

/** 放掉浮层：最后一个主窗口关了、或者应用要退出了。 */
export function destroyOverlay(): void {
	endCapture();
	releaseSteppedAside();
	putAside.clear();
	const window = overlay;
	overlay = null;
	overlayLoading = null;
	if (window && !window.isDestroyed()) window.destroy();
}
