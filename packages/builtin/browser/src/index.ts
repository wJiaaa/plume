/**
 * plume.browser 的逻辑入口，跑在 agent 进程：网页的账（workspace.ts）、给模型的工具（tools.ts）、开给面板的接口都在这里。
 *
 * 页面是面板画的 `<webview>`，挂上以后交到这里（`attach`），之后人点的和 agent 做的都经 `ctx.pages` 驱动同一页。
 * 设置（搜索引擎、默认缩放、书签）存在插件数据目录的 `browser.json`。
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "@plume/contract";
import type { BrowserApi, BrowserSettings, BrowserUpdate, PageSelection } from "./api.ts";
import { DEFAULT_SETTINGS, SEARCH_ENGINES, validViewport, validZoom, webUrl } from "./address.ts";
import { createDialogs } from "./dialogs.ts";
import { listen } from "./listen.ts";
import { createLocalPages, localPath } from "./local.ts";
import { MESSAGES } from "./messages.ts";
import { CANCEL_INSPECT, inspectScript } from "./page-scripts.ts";
import { browserTools } from "./tools.ts";
import { createWorkspace } from "./workspace.ts";

// i18n-exempt：下面的报错交给面板，面板换成当前语言的话再给人看。

/**
 * 交给系统的默认浏览器。只交 http(s) 和本机页面背后的 `.html` 文件：别的协议、别的文件由系统交给哪个程序打开，
 * 网页里的一个链接就成了本机执行。
 *
 * Windows 上不经 cmd 的 `start`：网址里的 `&` 会被它当成命令分隔符，网页给的地址后半截就被当成命令跑。`url.dll` 的
 * FileProtocolHandler 把整条地址原样交给系统的默认浏览器；文件先写成 `file:` 地址，路径里的空格不用再加引号。
 */
function openOutside(url: string): Promise<void> {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["rundll32.exe", ["url.dll,FileProtocolHandler", win32.isAbsolute(url) ? pathToFileURL(url).href : url]]
				: ["xdg-open", [url]];
	return new Promise((resolve, reject) => execFile(command as string, args as string[], (error) => (error ? reject(error) : resolve())));
}

function cleanSettings(value: unknown): BrowserSettings {
	const raw = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof BrowserSettings, unknown>>;
	const engines: string[] = [...SEARCH_ENGINES.map((engine) => engine.id), "custom"];
	const bookmarks = Array.isArray(raw.bookmarks)
		? raw.bookmarks.flatMap((item: unknown) => {
				const { url, title } = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
				return typeof url === "string" && typeof title === "string" ? [{ url, title }] : [];
			})
		: DEFAULT_SETTINGS.bookmarks;
	return {
		searchEngine:
			typeof raw.searchEngine === "string" && engines.includes(raw.searchEngine)
				? (raw.searchEngine as BrowserSettings["searchEngine"])
				: DEFAULT_SETTINGS.searchEngine,
		searchUrl: typeof raw.searchUrl === "string" ? raw.searchUrl : DEFAULT_SETTINGS.searchUrl,
		defaultZoom: validZoom(raw.defaultZoom) ? raw.defaultZoom : DEFAULT_SETTINGS.defaultZoom,
		openLinks: raw.openLinks === "builtin" ? "builtin" : "system",
		bookmarks,
	};
}

function isSelection(value: unknown): value is Omit<PageSelection, "screenshot"> {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	if (!["url", "title", "selector", "html", "text"].every((name) => typeof item[name] === "string")) return false;
	if (!item.styles || typeof item.styles !== "object" || !Object.values(item.styles).every((entry) => typeof entry === "string")) return false;
	const rect = item.bounds as Record<string, unknown> | undefined;
	return !!rect && ["x", "y", "width", "height"].every((name) => typeof rect[name] === "number" && Number.isFinite(rect[name]));
}

export default {
	name: "plume.browser",
	apply(ctx) {
		const file = join(ctx.dataDir, "browser.json");
		let settings: Promise<BrowserSettings> | undefined;
		const loadSettings = () =>
			(settings ??= readFile(file, "utf8").then(
				(text) => cleanSettings(JSON.parse(text)),
				() => cleanSettings({}),
			));

		const web = ctx.pages;
		const local = createLocalPages();
		ctx.effect(() => local.close());
		/** 人在地址栏打的、点的：本机的 `.html` 换成本机页面的地址。 */
		const address = async (raw: string) => {
			const path = localPath(raw);
			return path ? local.address(path) : raw;
		};
		const workspace = createWorkspace(web, async () => (await loadSettings()).defaultZoom);
		ctx.pages.onEvent((event) => workspace.event(event));
		const dialogs = createDialogs(web, workspace);
		for (const tool of browserTools(web, workspace, dialogs, local, () => ctx.locale())) ctx.tools.register(tool);
		// 会话删了，它的网页也关掉。
		ctx.sessions.onDeleted((sessionId) => {
			workspace.release(sessionId);
			workspace.closeSession(sessionId);
		});
		/*
		 * agent 用过浏览器的会话，这一轮跑完之前它的页一直挂着：人这时去看别的会话，页面也不能睡——睡了再醒是重新加载，
		 * agent 填到一半的表单就没了。这一轮什么时候完没有事件可听，有这样的会话时隔几秒看一眼。
		 */
		const sweep = setInterval(() => {
			if (workspace.engaged().length === 0) return;
			void ctx.sessions.list().then(
				(sessions) => {
					const running = new Set(sessions.filter((session) => session.running).map((session) => session.id));
					for (const sessionId of workspace.engaged()) if (!running.has(sessionId)) workspace.release(sessionId);
				},
				() => {},
			);
		}, 5_000);
		ctx.effect(() => clearInterval(sweep));

		const api: BrowserApi = {
			async *watch(call) {
				const updates = listen<BrowserUpdate>(call.signal, (emit) => workspace.watch(emit));
				for await (const batch of updates) {
					// 开、关标签的那几份各送一次，其余的只要最新一份。
					for (const update of batch) if (update.open || update.close) yield update;
					const last = batch.at(-1);
					if (last && !last.open && !last.close) yield last;
				}
			},
			attach: (page, contentsId) => workspace.attach(page, contentsId),
			ensure: (page, sessionId) => workspace.ensure(page, sessionId),
			adopt: async (page, sessionId) => workspace.adopt(page, sessionId),
			async open(url, sessionId) {
				await workspace.open(await address(url), sessionId, { newTab: true, reveal: true });
			},
			navigate: async (page, url) => workspace.navigate(page, await address(url)),
			async select(page) {
				if (workspace.page(page)) workspace.select(page);
			},
			async command(page, command) {
				if (command === "devtools") await web.devtools(page);
				else await workspace.go(page, command);
			},
			async outside(page, url) {
				// 地址栏里打了还没回车的那一行先；再是页面此刻的地址，再是这一页记着的那个。
				const live = page ? (await web.state(page).catch(() => null))?.url : undefined;
				for (const raw of [url, live, page ? workspace.page(page)?.url : undefined]) {
					if (!raw) continue;
					// 本机页面的地址出了 Plume 就打不开：交出去的是它背后的文件。只认自己给出的地址，网页跳去的 `file:` 不交。
					const file = local.source(raw);
					if (file) return openOutside(file);
					let address: string;
					try {
						address = webUrl(raw);
					} catch {
						continue;
					}
					if (address === "about:blank") continue;
					return openOutside(address);
				}
				throw new Error("nothing to open outside");
			},
			async zoom(page, factor) {
				if (!validZoom(factor)) throw new Error("bad zoom");
				await workspace.zoom(page, factor);
			},
			async viewport(page, viewport) {
				if (viewport !== null && !validViewport(viewport)) throw new Error("bad viewport");
				await workspace.viewport(page, viewport);
			},
			resize: (page, width, height) => workspace.resize(page, width, height),
			close: async (page) => workspace.close(page),
			async inspect(page, mode) {
				const messages = MESSAGES[ctx.locale()];
				// 换了页、关了页，选取就作罢：旧文档里的那段脚本跟着卸掉，永远不会回来。
				const leave = workspace.navigates(page);
				let picked: unknown;
				try {
					picked = await Promise.race([
						leave.left.then(() => null),
						web.evaluate(page, inspectScript(mode, { region: messages.inspectRegion, exit: messages.inspectExit }), { isolated: true }),
					]);
				} finally {
					leave.stop();
				}
				if (picked === null) return null;
				if (!isSelection(picked)) throw new Error("the page returned no element");
				// 选到的是 CSS 像素，截图要页面上的像素：乘上缩放和视口仿真缩小的比例。
				const factor = (workspace.page(page)?.zoom ?? 1) * workspace.scale(page);
				const { bounds } = picked;
				const rect = {
					x: Math.round(bounds.x * factor),
					y: Math.round(bounds.y * factor),
					width: Math.max(1, Math.round(bounds.width * factor)),
					height: Math.max(1, Math.round(bounds.height * factor)),
				};
				return { ...picked, screenshot: await web.capture(page, { rect, points: true }) };
			},
			async cancelInspect(page) {
				await web.evaluate(page, CANCEL_INSPECT, { isolated: true }).catch(() => {});
			},
			settings: loadSettings,
			async saveSettings(patch) {
				const next = cleanSettings({ ...(await loadSettings()), ...patch });
				await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
				settings = Promise.resolve(next);
				return next;
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
