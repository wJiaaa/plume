/**
 * 地址栏和打开网页的规矩，两个入口共用：什么算网址、什么拿去搜索，搜索交给哪一家。
 *
 * 只认 http、https 和 about:blank：别的协议当成要搜索的字，不当成要去的地方——`javascript:`、`data:` 当地址就成了
 * 在页面里执行东西的入口。宿主那边也只放这几种。本机的 `.html`（`file:`、`~/`、绝对路径）交给逻辑入口换成它自己给的地址，见 local.ts。
 */

import type { BrowserSettings, SearchEngine, Viewport } from "./api.ts";

/** 地址栏能交给的几家，顺序就是设置页里的顺序。`%s` 是搜索词的位置，和别的浏览器写法一样，从那里抄来的模板能直接用。 */
export const SEARCH_ENGINES: { id: Exclude<SearchEngine, "custom">; template: string }[] = [
	{ id: "bing", template: "https://www.bing.com/search?q=%s" },
	{ id: "google", template: "https://www.google.com/search?q=%s" },
	// 百度不带 `ie` 时按 GBK 读搜索词，中文搜出来是乱码。
	{ id: "baidu", template: "https://www.baidu.com/s?ie=utf-8&wd=%s" },
	{ id: "duckduckgo", template: "https://duckduckgo.com/?q=%s" },
];

export const DEFAULT_SETTINGS: BrowserSettings = { searchEngine: "bing", searchUrl: "", defaultZoom: 1, openLinks: "system", bookmarks: [] };

// i18n-exempt：下面的报错给模型（工具结果）和插件自己，地址栏不显示它们，只拿来判断能不能开。
/** 一个能开的地址；没写协议的补 https。 */
export function webUrl(raw: string): string {
	const text = raw.trim();
	if (!text) return "about:blank";
	const url = new URL(/^[a-z][\w+.-]*:/i.test(text) && !/^[\w.-]+:\d/.test(text) ? text : `https://${text}`);
	if (url.protocol !== "http:" && url.protocol !== "https:" && url.href !== "about:blank") throw new Error("only http(s) addresses can be opened");
	return url.href;
}

/**
 * 打的是网址还是要搜的字。
 *
 * 带空格的不是网址；`host:port` 是；带协议的只有 `scheme://` 才是（`mailto:`、`javascript:` 拿去搜索）；主机名的最后一段
 * 要是两个以上的字母（`3.14`、`1.5.0` 不是，`例子.中国` 是），比写死一张顶级域名表认得全。
 */
function addressLike(raw: string): boolean {
	const text = raw.trim();
	if (!text || /\s/.test(text)) return false;
	if (text === "about:blank") return true;
	if (/^[\w.-]+:\d+(?:[/?#]|$)/.test(text)) return true;
	if (/^[a-z][\w+.-]*:/i.test(text)) return /^[a-z][\w+.-]*:\/\//i.test(text);
	const host = text.split(/[/?#]/)[0] ?? "";
	if (host === "localhost") return true;
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^\[[\da-f:]+\](?::\d+)?$/i.test(host)) return true;
	const labels = host.split(".");
	return labels.length > 1 && labels.every(Boolean) && /^\p{L}{2,}$/u.test(labels.at(-1) ?? "");
}

/** 用的哪个模板：自定义的放不进搜索词时退回必应。 */
function searchTemplate(settings: BrowserSettings): string {
	const custom = settings.searchEngine === "custom" ? settings.searchUrl.trim() : undefined;
	const preset = SEARCH_ENGINES.find((engine) => engine.id === settings.searchEngine)?.template;
	return (custom?.includes("%s") ? custom : preset) ?? SEARCH_ENGINES[0]!.template;
}

export function searchUrl(query: string, settings: BrowserSettings): string {
	return webUrl(searchTemplate(settings).replaceAll("%s", encodeURIComponent(query)));
}

/** 自定义搜索地址哪里不能用：要有 `%s`，要是网页地址；能用是 null。 */
export function customSearchProblem(raw: string): "needsQuery" | "notWeb" | null {
	const text = raw.trim();
	if (!text.includes("%s")) return "needsQuery";
	try {
		webUrl(text.replaceAll("%s", "plume"));
		return null;
	} catch {
		return "notWeb";
	}
}

/** 打的是本机的一个 `.html`：`file:` 地址、`~/` 或绝对路径。 */
function localLike(raw: string): boolean {
	const text = raw.trim();
	return /^(?:file:|~[\\/]|\/|[a-z]:[\\/])/i.test(text) && /\.html?$/i.test(text);
}

/** 地址栏拿打的字去做什么。网址开不了时抛错。本机的 `.html` 原样交给逻辑入口。 */
export function omnibox(raw: string, settings: BrowserSettings): { kind: "open" | "search"; url: string; query: string } {
	const text = raw.trim();
	if (localLike(text)) return { kind: "open", url: text, query: text };
	if (!text || addressLike(text)) return { kind: "open", url: webUrl(text), query: text };
	return { kind: "search", url: searchUrl(text, settings), query: text };
}

export const ZOOM = { min: 0.25, max: 3 };
const VIEWPORT = { minWidth: 240, maxWidth: 3840, minHeight: 240, maxHeight: 2160 };

export function validZoom(factor: unknown): factor is number {
	return typeof factor === "number" && Number.isFinite(factor) && factor >= ZOOM.min && factor <= ZOOM.max;
}

export function validViewport(value: unknown): value is Viewport {
	if (!value || typeof value !== "object") return false;
	const { width, height } = value as Record<string, unknown>;
	return (
		Number.isInteger(width) &&
		Number.isInteger(height) &&
		(width as number) >= VIEWPORT.minWidth &&
		(width as number) <= VIEWPORT.maxWidth &&
		(height as number) >= VIEWPORT.minHeight &&
		(height as number) <= VIEWPORT.maxHeight
	);
}
