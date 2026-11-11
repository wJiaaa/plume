/**
 * 逻辑入口经 ctx.serve 开给界面入口的接口，两个入口共用这一份类型。
 *
 * 网页都记在逻辑入口：哪些页、属于哪个会话、加载到哪了、出了什么错。面板是这一份的样子，`<webview>` 挂在面板里，
 * 挂上以后交给逻辑入口（`attach`），之后不管人还是 agent 都经逻辑入口驱动它。
 */

import type { CallContext } from "@plume/contract";

export type SearchEngine = "bing" | "google" | "baidu" | "duckduckgo" | "custom";

export interface Bookmark {
	url: string;
	title: string;
}

/** 插件数据目录里 `browser.json` 的内容。 */
export interface BrowserSettings {
	searchEngine: SearchEngine;
	/** 自定义搜索地址，`%s` 是搜索词的位置。 */
	searchUrl: string;
	/** 新页面的缩放。 */
	defaultZoom: number;
	/** 回复里的网址点了开在哪；右键总能挑。 */
	openLinks: "system" | "builtin";
	bookmarks: Bookmark[];
}

export interface Viewport {
	width: number;
	height: number;
}

/** 一页没打开的原因，盖在页面上。`blocked` 是跳去了非网页地址，`url` 是交给系统浏览器的那一页。 */
type PageFailure = { kind: "load" | "crash"; detail: string } | { kind: "blocked"; detail: string; url: string };

/** agent 刚在页面上点、输、滚的位置（视口里的 CSS 像素），面板据此画光标。`sequence` 每次加一，同一处再点也重播一次。 */
export interface PagePointer {
	x: number;
	y: number;
	action: string;
	sequence: number;
}

/** 一页，也是面板区的一个标签：页面 id 就是标签 id。 */
export interface BrowserPage {
	id: string;
	/** 属于哪个会话；新对话里开的是 null。 */
	sessionId: string | null;
	/** 要去的、或正在的地址：第一页还没提交时就是要去的那一页，地址栏照它写。 */
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	zoom: number;
	/** 仿真的视口；null 是跟着面板的大小。 */
	viewport: Viewport | null;
	failure?: PageFailure;
	pointer?: PagePointer;
	/** 要的是一张网页，眼下画着的却还是空白（新标签里输了地址、刚开的页、收起后重新挂上的页）：加载时页面区显示正在加载，不是一片白。 */
	arriving: boolean;
	/** 逻辑入口要这一页挂着：agent 正等它挂上，或者它那个会话的 agent 这一轮在用浏览器。界面据此把睡着的页叫醒、不让它睡。 */
	held: boolean;
}

/** 选取的页面元素或框出的区域，连同截图交给输入框。 */
export interface PageSelection {
	url: string;
	title: string;
	selector: string;
	html: string;
	text: string;
	styles: Record<string, string>;
	bounds: { x: number; y: number; width: number; height: number };
	/** PNG data URL。 */
	screenshot: string;
}

/**
 * 推给界面的一份：全部网页，加上要界面替逻辑入口做的事——开出一个标签（`reveal` 切过去、展开面板区）、关掉一个标签。
 * 每个订阅者各收一份，`open`、`close` 只送一次。
 */
export interface BrowserUpdate {
	pages: BrowserPage[];
	open?: { page: string; sessionId: string | null; reveal: boolean };
	close?: { page: string; sessionId: string | null };
}

export interface BrowserApi {
	/** 订阅网页的变化；先给一份现状。 */
	watch(call: CallContext): AsyncGenerator<BrowserUpdate, void>;
	/** 面板里的 `<webview>` 挂上了：`contentsId` 是它的 `getWebContentsId()`。 */
	attach(page: string, contentsId: number): Promise<void>;
	/** 面板上的标签挂上了：这一页还没有（从开始页开出来的空标签、agent 进程重启过）就记一页空白的。关掉过的不再开，返回 false。 */
	ensure(page: string, sessionId: string | null): Promise<boolean>;
	/** 新对话发出第一句、成了会话：新对话里开的页跟过去。 */
	adopt(page: string, sessionId: string): Promise<void>;
	/** 在这个会话里新开一页（菜单里的新标签页、书签）。 */
	open(url: string, sessionId: string | null): Promise<void>;
	/** 这一页换去这个地址（地址栏回车）。 */
	navigate(page: string, url: string): Promise<void>;
	/** 人切到了这一页：成为它那个会话当前的一页，agent 不给 tabId 时操作的就是它。 */
	select(page: string): Promise<void>;
	command(page: string, command: "back" | "forward" | "reload" | "devtools"): Promise<void>;
	/** 交给系统的浏览器：给了 `url` 开它，否则开这一页此刻的地址。 */
	outside(page: string | null, url: string | null): Promise<void>;
	zoom(page: string, factor: number): Promise<void>;
	viewport(page: string, viewport: Viewport | null): Promise<void>;
	/** 面板里放页面的那块的大小，视口仿真按它缩小。 */
	resize(page: string, width: number, height: number): Promise<void>;
	/** 人关掉了这一页的标签。 */
	close(page: string): Promise<void>;
	/** 在页面上选一个元素（`element`）或框一块（`region`），Esc、换页时是 null。 */
	inspect(page: string, mode: "element" | "region"): Promise<PageSelection | null>;
	cancelInspect(page: string): Promise<void>;
	settings(): Promise<BrowserSettings>;
	saveSettings(patch: Partial<BrowserSettings>): Promise<BrowserSettings>;
}
