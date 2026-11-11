/**
 * 网页（`ctx.pages` 的主进程那一半）：插件界面入口画的 `<webview>`，经逻辑入口 `attach` 认成插件的页面以后，
 * 由这里替插件驱动它。浏览器的标签、地址栏、给模型的工具都在插件里；这里只做只有主进程做得到的事：
 *
 * - 加固：不管标签上写了什么，页面都在沙箱里、没有 Node 和预加载脚本，分区固定；只有主窗口和面板窗口里的能挂上。
 * - 只开网页：主框架去别的协议（`lark://` 这类唤起客户端的）一律拦下，告诉插件；新窗口不开，交给插件，脚本按尺寸开的
 *   小窗（第三方登录）开成挂在主窗口上的小窗口，和开它的页面连着。
 * - 对话框：插件要求时由这里答 alert、confirm、离开提示，不弹系统对话框——agent 操作网页时没人去点它，
 *   页面的主线程就一直停在那一句上。
 * - 加载、执行脚本（可在插件自己的隔离 world 里）、原生输入、截图、缩放、视口仿真、开发者工具。
 *
 * 事件经 agent 进程推给对应插件的逻辑入口。
 */

import { app, BrowserWindow, nativeImage, type NativeImage, screen, session, type Session, webContents, type WebContents, type WebPreferences } from "electron";
import type { WebPageEvent, WebPageState } from "@plume/contract";
import { inspectPage } from "./web-inspect.ts";

/** 网页的分区。持久化：登录状态跨重启保留。 */
const WEB_PARTITION = "persist:plume-web";

/** 网页所在的会话：cookie、缓存都在这里。 */
export function webSession(): Session {
	return session.fromPartition(WEB_PARTITION);
}

/** 网页都不碰机器上的东西，只给这两项：都要人刚在页面里点过才能用，拒掉的话视频全屏不了、站点的「复制」按钮静默失灵。 */
const GRANTED = new Set(["clipboard-sanitized-write", "fullscreen"]);

/** 页面能去的地址：网页和空白页。 */
function webAddress(url: string): boolean {
	return /^https?:\/\//i.test(url) || url === "about:blank";
}

/** 页面在认下之前报过的事，留到认下时补报；留得太多的扔掉早的。 */
const EARLY_LIMIT = 50;

type Detail = WebPageEvent extends infer E ? (E extends { page: string; state: WebPageState } ? Omit<E, "page" | "state"> : never) : never;

interface Dialog {
	type: string;
	message: string;
	answer: (accepted: boolean, text: string) => void;
}

interface Guest {
	contents: WebContents;
	/** 认下它的插件和页面 id；还没认下时为空。 */
	owner?: { plugin: string; id: string };
	early: Detail[];
	/** 宿主替人答对话框：null 是弹给人。 */
	answer: boolean | null;
	/** 正以系统对话框开着、等人点的那一个。 */
	waiting?: Dialog;
	/** 最后一次读到的样子：页面没了以后的事件用它。 */
	last: WebPageState;
}

const guests = new Map<WebContents, Guest>();
/** `插件名\n页面 id` → 认下的页面。 */
const pages = new Map<string, Guest>();
const pageKey = (plugin: string, id: string) => `${plugin}\n${id}`;
/** 插件 → 它的隔离 world。各插件一个：别的插件的隔离脚本看不到它记在全局上的东西。 */
const worlds = new Map<string, number>();

let emit: (plugin: string, event: WebPageEvent) => void = () => {};
/** 开了 `webviewTag`、经 `guardWebviews` 加固过的窗口：只有它们里面的 `<webview>` 能认成插件的页面。 */
const embedders = new WeakSet<WebContents>();

function stateOf(guest: Guest): WebPageState {
	const { contents } = guest;
	if (contents.isDestroyed()) return guest.last;
	guest.last = {
		url: contents.getURL(),
		title: contents.getTitle(),
		loading: contents.isLoading(),
		canGoBack: contents.navigationHistory.canGoBack(),
		canGoForward: contents.navigationHistory.canGoForward(),
		crashed: contents.isCrashed(),
		zoom: contents.getZoomFactor(),
	};
	return guest.last;
}

function report(guest: Guest, detail: Detail): void {
	if (!guest.owner) {
		guest.early.push(detail);
		if (guest.early.length > EARLY_LIMIT) guest.early.shift();
		return;
	}
	emit(guest.owner.plugin, { ...detail, page: guest.owner.id, state: stateOf(guest) } as WebPageEvent);
}

/**
 * 登记：每个页面一出生就挂上规矩。在 `web-contents-created` 里挂：第一跳就被 302 送去 `lark://` 的页面，
 * 等界面报上它的 id 时那一跳早就过去了，拦它的监听必须先在。
 */
export function registerWebPages(options: { emit(plugin: string, event: WebPageEvent): void }): void {
	emit = options.emit;
	const web = webSession();
	web.setPermissionRequestHandler((_contents, permission, callback) => callback(GRANTED.has(permission)));
	web.setPermissionCheckHandler((_contents, permission) => GRANTED.has(permission));
	app.on("web-contents-created", (_event, contents) => {
		if (contents.getType() === "webview") watch(contents);
	});
}

/**
 * 开了 `webviewTag` 的窗口（主窗口、面板窗口）挂 `<webview>` 前改掉它的设置。`will-attach-webview` 在宿主页面上触发，
 * 所以注入进页面的标签也要过这一关。别的窗口（截屏浮层）根本不开 `webviewTag`。
 */
export function guardWebviews(contents: WebContents): void {
	embedders.add(contents);
	contents.on("will-attach-webview", (event, preferences: WebPreferences, params) => {
		delete preferences.preload;
		preferences.nodeIntegration = false;
		preferences.nodeIntegrationInSubFrames = false;
		preferences.contextIsolation = true;
		preferences.sandbox = true;
		// 两处都要写：只改 params，Electron 照旧把页面放进默认会话，上面那套权限规则和单独的浏览数据都落空。
		preferences.partition = WEB_PARTITION;
		params.partition = WEB_PARTITION;
		/*
		 * 新窗口要能到 `watch` 里的 setWindowOpenHandler，怎么开由它定。Electron 在这个事件之前已经按标签上的 `allowpopups`
		 * 算好了 `disablePopups`，只改 params 不管用：`window.open` 直接交回 null，`target=_blank` 点了没反应。
		 */
		(preferences as WebPreferences & { disablePopups?: boolean }).disablePopups = false;
		params.allowpopups = "true";
		if (!webAddress(String(params.src ?? ""))) event.preventDefault();
	});
}

function watch(contents: WebContents): void {
	const guest: Guest = {
		contents,
		early: [],
		answer: null,
		last: { url: "", title: "", loading: true, canGoBack: false, canGoForward: false, crashed: false, zoom: 1 },
	};
	guests.set(contents, guest);
	contents.on("did-start-navigation", (details) => {
		if (details.isMainFrame && !details.isSameDocument) report(guest, { type: "navigation", url: details.url });
	});
	contents.on("dom-ready", () => report(guest, { type: "dom-ready" }));
	contents.on("did-start-loading", () => report(guest, { type: "loading", loading: true }));
	contents.on("did-stop-loading", () => report(guest, { type: "loading", loading: false }));
	contents.on("did-navigate", (_event, url) => report(guest, { type: "navigated", url, inPage: false }));
	contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
		if (isMainFrame) report(guest, { type: "navigated", url, inPage: true });
	});
	contents.on("page-title-updated", (_event, title) => report(guest, { type: "title", title }));
	contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
		// -3 是被取消：换了一页、被下面拦下的跳转，都不算没加载出来。
		if (isMainFrame && code !== -3) report(guest, { type: "failed", url, code, description });
	});
	contents.on("render-process-gone", (_event, details) => report(guest, { type: "gone", reason: details.reason }));
	contents.on("will-navigate", (event) => {
		if (webAddress(event.url)) return;
		event.preventDefault();
		report(guest, { type: "blocked", url: event.url, redirect: false });
	});
	contents.on("will-redirect", (event) => {
		if (webAddress(event.url)) return;
		event.preventDefault();
		// 子框架的跳转拦下就是了：页面还立着，没什么要告诉插件的。
		if (event.isMainFrame) report(guest, { type: "blocked", url: event.url, redirect: true });
	});
	/*
	 * 页面要开新窗口不等于有人要看：链接、不带尺寸的 `window.open` 不开，交给插件（浏览器插件开成一个后台标签）。
	 * 脚本按尺寸开的小窗（第三方登录、支付）开成真的小窗口：它要经 `window.opener` 把结果交回原页面、自己关掉，开成标签就断了。
	 */
	contents.setWindowOpenHandler(({ url, disposition }) => {
		if (!webAddress(url)) return { action: "deny" };
		if (disposition !== "new-window") {
			report(guest, { type: "popup", url });
			return { action: "deny" };
		}
		report(guest, { type: "popup", url, window: true });
		const host = contents.hostWebContents && BrowserWindow.fromWebContents(contents.hostWebContents);
		return {
			action: "allow",
			overrideBrowserWindowOptions: {
				...(host ? { parent: host } : {}),
				autoHideMenuBar: true,
				// 分区不写：和开它的页面同一个会话（登录状态、权限规则都一样），写了反倒和 opener 断开。
				webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false },
			},
		};
	});
	contents.on("did-create-window", (window) => guardPopup(window.webContents));
	// 离开页面提示：Electron 不弹窗，默认留在原页；`preventDefault` 是离开。
	contents.on("will-prevent-unload", (event) => {
		if (guest.answer === null) return;
		report(guest, { type: "dialog", dialog: "beforeunload", message: "", accepted: guest.answer });
		if (guest.answer) event.preventDefault();
	});
	contents.once("destroyed", () => {
		guests.delete(contents);
		if (!guest.owner) return;
		const key = pageKey(guest.owner.plugin, guest.owner.id);
		if (pages.get(key) === guest) pages.delete(key);
		report(guest, { type: "detached" });
	});
}

/**
 * 页面开出的小窗口：给人用的（登录、付款），插件和 agent 不驱动它。规矩和页面一样：只去网页地址；它自己再开的窗口不开——
 * 登录窗口里很少需要，开了也没有标签可放。
 */
function guardPopup(page: WebContents): void {
	const stay = (event: Electron.Event & { url: string }) => {
		if (!webAddress(event.url)) event.preventDefault();
	};
	page.on("will-navigate", stay);
	page.on("will-redirect", stay);
	page.setWindowOpenHandler(() => ({ action: "deny" }));
}

/**
 * 接管页面的 alert、confirm：宿主答掉的不弹系统对话框，其余交回 Electron 原来的那一个。
 *
 * 不用 CDP 的 `Page.handleJavaScriptDialog`：它让页面继续了，Electron 弹出的系统对话框却留在窗口上排着。系统对话框是
 * Electron 的 JS 层在 `-run-dialog` 上弹的，所以在那里分岔。认不出原来那一个（换了版本、换了实现）就不接管：
 * 弹给人总比丢掉对话框好。在认下页面时挂，那时 Electron 自己的监听一定已经在了。
 */
function takeDialogs(guest: Guest): void {
	const events = guest.contents as unknown as NodeJS.EventEmitter;
	const listeners = events.listeners("-run-dialog");
	if (listeners.length !== 1) return;
	const native = listeners[0] as (info: { dialogType: string; messageText: string }, answer: Dialog["answer"]) => void;
	events.removeListener("-run-dialog", native);
	events.on("-run-dialog", (info: { dialogType: string; messageText: string }, answer: Dialog["answer"]) => {
		const dialog: Dialog = { type: info.dialogType, message: info.messageText, answer };
		// prompt 由 Electron 自己回 null，不会停住页面。
		if (guest.answer !== null && dialog.type !== "prompt") return reply(guest, dialog, guest.answer);
		guest.waiting = dialog;
		native(info, (accepted, text) => {
			if (guest.waiting === dialog) guest.waiting = undefined;
			answer(accepted, text);
		});
	});
}

/** alert 只有一个按钮；confirm 按插件给的答。 */
function reply(guest: Guest, dialog: Dialog, accept: boolean): void {
	const accepted = dialog.type === "alert" || accept;
	dialog.answer(accepted, "");
	report(guest, { type: "dialog", dialog: dialog.type === "alert" ? "alert" : "confirm", message: dialog.message, accepted });
}

// 下面的报错给插件的逻辑入口（多半最后到了模型那里），用英文，和工具结果一样。
function attach(plugin: string, id: string, contentsId: unknown): void {
	if (typeof contentsId !== "number") throw new Error("contentsId must be the <webview>'s getWebContentsId()");
	const contents = webContents.fromId(contentsId);
	const guest = contents && guests.get(contents);
	if (!contents || !guest || contents.getType() !== "webview" || !contents.hostWebContents || !embedders.has(contents.hostWebContents))
		throw new Error("Not a <webview> in a Plume window");
	if (guest.owner && (guest.owner.plugin !== plugin || guest.owner.id !== id)) throw new Error("This <webview> is already attached as another page");
	const key = pageKey(plugin, id);
	const taken = pages.get(key);
	if (taken === guest) return;
	/*
	 * 这一页已经连着另一个还活着的 `<webview>`：标签弹出到窗口、接回来时，新窗口里的那个常常比旧的先挂上，旧的随后才卸掉。
	 * 换成新的；旧的不再算这一页，它卸掉时也就不报 `detached`。
	 */
	if (taken && !taken.contents.isDestroyed()) taken.owner = undefined;
	guest.owner = { plugin, id };
	pages.set(key, guest);
	takeDialogs(guest);
	report(guest, { type: "attached" });
	for (const detail of guest.early.splice(0)) report(guest, detail);
}

function page(plugin: string, id: string): Guest {
	const guest = pages.get(pageKey(plugin, id));
	if (!guest || guest.contents.isDestroyed()) throw new Error(`Page ${id} is not attached`);
	return guest;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function inputEvent(value: unknown): Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent {
	const event = (value ?? {}) as Partial<Record<string, unknown>>;
	if (event.type === "mouseMove" || event.type === "mouseDown" || event.type === "mouseUp") {
		if (!finite(event.x) || !finite(event.y)) throw new Error("Pointer events need x and y");
		const button = event.button === "middle" || event.button === "right" ? event.button : "left";
		return { type: event.type, x: Math.round(event.x), y: Math.round(event.y), button, clickCount: finite(event.clickCount) ? event.clickCount : 1 };
	}
	if (event.type === "mouseWheel") {
		if (![event.x, event.y, event.deltaX, event.deltaY].every(finite)) throw new Error("Wheel events need x, y, deltaX and deltaY");
		return {
			type: "mouseWheel",
			x: Math.round(event.x as number),
			y: Math.round(event.y as number),
			deltaX: event.deltaX as number,
			deltaY: event.deltaY as number,
		};
	}
	if (event.type === "keyDown" || event.type === "keyUp" || event.type === "char") {
		if (typeof event.keyCode !== "string" || !event.keyCode) throw new Error("Key events need keyCode");
		const modifiers = Array.isArray(event.modifiers)
			? event.modifiers.filter((name): name is "shift" | "control" | "alt" | "meta" => ["shift", "control", "alt", "meta"].includes(String(name)))
			: [];
		return { type: event.type, keyCode: event.keyCode, modifiers };
	}
	throw new Error("Unknown input event");
}

/** agent 进程转来的 `ctx.pages` 调用。参数来自插件，逐个校验。 */
export async function callPage(plugin: string, id: string, method: string, args: unknown[]): Promise<unknown> {
	if (typeof plugin !== "string" || typeof id !== "string" || !id) throw new Error("The page id must be a non-empty string");
	if (method === "inspect") return inspectPage(id, args[0]);
	if (method === "attach") return attach(plugin, id, args[0]);
	if (method === "state") {
		const guest = pages.get(pageKey(plugin, id));
		return guest && !guest.contents.isDestroyed() ? stateOf(guest) : null;
	}
	const guest = page(plugin, id);
	const { contents } = guest;
	switch (method) {
		case "load": {
			const url = args[0];
			if (typeof url !== "string" || !webAddress(url)) throw new Error("Only http, https and about:blank can be loaded");
			// 不等结果：站点不回应时 loadURL 可以一直不了结；成败看事件。
			void contents.loadURL(url).catch(() => {});
			return;
		}
		case "go": {
			const step = args[0];
			if (step === "back") {
				if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
			} else if (step === "forward") {
				if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
			} else if (step === "reload") contents.reload();
			else throw new Error("go takes back, forward or reload");
			return;
		}
		case "evaluate": {
			const [code, options] = args as [unknown, { isolated?: unknown } | undefined];
			if (typeof code !== "string") throw new Error("evaluate needs code");
			if (options?.isolated !== true) return await contents.executeJavaScript(code, true);
			let world = worlds.get(plugin);
			if (world === undefined) worlds.set(plugin, (world = 1000 + worlds.size));
			return await contents.executeJavaScriptInIsolatedWorld(world, [{ code }], true);
		}
		case "input":
			contents.sendInputEvent(inputEvent(args[0]));
			return;
		case "insertText":
			if (typeof args[0] !== "string") throw new Error("insertText needs text");
			await contents.insertText(args[0]);
			return;
		case "focus":
			contents.focus();
			return;
		case "capture": {
			const options = (args[0] ?? {}) as { rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null; points?: unknown };
			const rect = options.rect;
			let area: Electron.Rectangle | undefined;
			if (rect !== undefined && rect !== null) {
				if (![rect.x, rect.y, rect.width, rect.height].every(finite)) throw new Error("The capture area needs four numbers");
				area = {
					x: Math.round(rect.x as number),
					y: Math.round(rect.y as number),
					width: Math.max(1, Math.round(rect.width as number)),
					height: Math.max(1, Math.round(rect.height as number)),
				};
			}
			const image = await contents.capturePage(area);
			if (image.isEmpty()) throw new Error("The page has nothing drawn to capture right now");
			return onWhite(options.points === true ? toPoints(contents, image) : image).toDataURL();
		}
		case "setZoom": {
			const factor = args[0];
			if (!finite(factor) || factor < 0.25 || factor > 3) throw new Error("Zoom must be within 0.25–3");
			// 页面进程停了的不碰，见 `emulate`。
			if (!contents.isCrashed()) contents.setZoomFactor(factor);
			return;
		}
		case "emulate": {
			const viewport = args[0] as { width?: unknown; height?: unknown; scale?: unknown } | null;
			// 对页面进程已经停了的页面调设备仿真，主进程当场段错误、整个应用退出：等它重新加载以后插件再设。
			if (contents.isCrashed()) return;
			if (viewport === null) {
				contents.disableDeviceEmulation();
				return;
			}
			const { width, height, scale } = viewport ?? {};
			if (!finite(width) || !finite(height) || !finite(scale) || width < 1 || height < 1 || width > 10_000 || height > 10_000 || scale <= 0 || scale > 4)
				throw new Error("The viewport needs a positive width, height and scale");
			const size = { width: Math.round(width), height: Math.round(height) };
			contents.enableDeviceEmulation({
				screenPosition: "desktop",
				screenSize: size,
				viewSize: size,
				viewPosition: { x: 0, y: 0 },
				deviceScaleFactor: 1,
				scale,
			});
			return;
		}
		case "devtools":
			contents.openDevTools({ mode: "detach" });
			return;
		case "answerDialogs": {
			const accept = args[0];
			if (accept !== null && typeof accept !== "boolean") throw new Error("answerDialogs takes true, false or null");
			guest.answer = accept;
			const waiting = guest.waiting;
			if (accept === null || !waiting || waiting.type === "prompt") return;
			guest.waiting = undefined;
			// 收起开着的系统对话框。Electron 收起时不回调，所以由这里回答，页面只收到这一个答复。
			(contents as unknown as NodeJS.EventEmitter).emit("-cancel-dialogs", { resetState: false });
			reply(guest, waiting, accept);
			return;
		}
		default:
			throw new Error(`No method ${method}`);
	}
}

/** 截图按挂着它的窗口所在屏幕的缩放比缩回点：高分屏上一个 CSS 像素占几个物理像素，给模型的图不必跟着翻倍。 */
function toPoints(contents: WebContents, image: NativeImage): NativeImage {
	const window = contents.hostWebContents ? BrowserWindow.fromWebContents(contents.hostWebContents) : null;
	const factor = window ? screen.getDisplayMatching(window.getBounds()).scaleFactor : 1;
	if (!(factor > 1)) return image;
	const { width, height } = image.getSize();
	return image.resize({ width: Math.max(1, Math.round(width / factor)), height: Math.max(1, Math.round(height / factor)), quality: "best" });
}

/**
 * 垫上白底。页面没设背景的地方，guest 什么都不画：屏幕上透出的是 `<webview>` 底下的白，截图截的却只有 guest，
 * 那里是透明的——模型看到的是没有底色的字，连抗锯齿的边也是半透明的。在像素上垫，不给页面加背景：
 * agent 从页面读到的样式（算出来的背景色在内）还是页面自己的。
 *
 * `toBitmap` 是预乘过的，透出的白按原值加到每个通道上；照样夹在 255 以内，排布由平台定。
 * 像素尺寸从缓冲区的长度推：`getSize` 报的是像素还是点，接口没有保证。
 */
function onWhite(image: NativeImage): NativeImage {
	const scaleFactor = Math.max(1, ...image.getScaleFactors());
	const size = image.getSize(scaleFactor);
	const pixels = image.toBitmap({ scaleFactor });
	const scale = Math.round(Math.sqrt(pixels.length / 4 / Math.max(1, size.width * size.height))) || 1;
	const width = size.width * scale;
	const height = size.height * scale;
	if (width * height * 4 !== pixels.length) return image;
	let clear = false;
	for (let alpha = 3; alpha < pixels.length; alpha += 4) {
		const through = 255 - pixels[alpha]!;
		if (through === 0) continue;
		clear = true;
		pixels[alpha - 3] = Math.min(255, pixels[alpha - 3]! + through);
		pixels[alpha - 2] = Math.min(255, pixels[alpha - 2]! + through);
		pixels[alpha - 1] = Math.min(255, pixels[alpha - 1]! + through);
		pixels[alpha] = 255;
	}
	return clear ? nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: scale }) : image;
}
