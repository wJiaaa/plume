/**
 * 网页的账：哪些页、各属于哪个会话、每个会话现在在哪一页、加载到哪了、出了什么错。人在面板上点的和 agent 的工具走的
 * 是同一份，页面只经 `ctx.pages` 驱动。
 *
 * 一页就是面板区的一个标签（页面 id 就是标签 id）：开一页时让界面开出这个标签，`<webview>` 挂上以后报回来（`attach`）；
 * 人关掉标签就是关掉这一页。面板声明了 keepAlive，换会话、去设置页时标签不卸；但界面只给最近看过的几个会话挂着页面，
 * 别的睡着（`<webview>` 卸掉，账还在）。agent 要用一页时标上 `held`，界面把它叫醒，回到它记着的地址。
 */

import { randomUUID } from "node:crypto";
import type { WebPageEvent, WebPages } from "@plume/contract";
import type { BrowserPage, BrowserUpdate, PagePointer, Viewport } from "./api.ts";
import { webUrl } from "./address.ts";

// i18n-exempt：这一页的报错都给模型（工具结果）；人看到的失败画在面板上，不用这些话。

/** 关掉了的页：给它的命令和等它的一方都收到这个。 */
class PageClosed extends Error {
	constructor() {
		super("The browser tab was closed");
	}
}

const NOT_READY = "The browser panel did not come up within 30 seconds";
const NOT_LOADED = "The page did not load within 30 seconds; the site may be unreachable. The tab is still open to read later or close";
const crashed = (reason: string) => `The page process stopped again (${reason}) and will not restart by itself; use browser_act reload to retry`;

/** 最多开多少页。 */
const MAX_PAGES = 20;
const WAIT_MS = 30_000;

interface Entry {
	view: BrowserPage;
	/** `<webview>` 挂着、逻辑入口认下了。 */
	attached: boolean;
	/** 这一页的文档能读了。 */
	ready: boolean;
	/** 主框架正要去的地址：重定向到非网页地址时，交给系统浏览器的是它。 */
	navigating?: string;
	/**
	 * 地址栏、`browser_open` 叫它去的地址，新文档落地（`navigated`）之前一直算这一页的地址：落地前页面报来的还是上一张文档的
	 * （空白标签是 `about:blank`），照着它写，地址栏会先变空或闪回上一页，「打开一个网页」也一直盖着。没去成的同样留着它，
	 * 地址栏停在没打开的那个地址上。
	 */
	requested?: string;
	/** 页面报来的、眼下真正画着的那张文档的地址；还没有时是空的。 */
	shown: string;
	/** 页面进程上一次没了的时刻：15 秒内又没了就不再自动重来。 */
	crashedAt: number;
	/** 第一跳无声地断了时只重来一次。 */
	retried: boolean;
	/** 面板里放页面的那块的大小，视口仿真按它缩小。 */
	size?: { width: number; height: number };
	/** 视口仿真缩小的比例：agent 的点按坐标要乘上它。 */
	scale: number;
	/** 下一个 ref 的编号，按页接续。 */
	nextRef: number;
	/** 有一方在等它挂上：它可能睡着，要界面叫醒。 */
	wanted: boolean;
	/** 等这一页某件事的一方。 */
	listeners: Set<(event: WebPageEvent | { type: "closed" }) => void>;
}

export interface Workspace {
	pages(): BrowserPage[];
	page(id: string): BrowserPage | undefined;
	scale(id: string): number;
	refs(id: string): number;
	setRefs(id: string, next: number): void;
	watch(push: (update: BrowserUpdate) => void): () => void;
	/** 在会话里开一页，或载进它当前那一页；返回页面 id。`reveal` 是要不要把面板切到这一页。 */
	open(url: string, sessionId: string | null, options: { newTab: boolean; reveal: boolean }): Promise<string>;
	/** 这一页换去这个地址。 */
	navigate(id: string, url: string): Promise<void>;
	/** 等这一页挂上、文档能读。 */
	loaded(id: string, sessionId?: string): Promise<void>;
	/** agent 的后退、前进、刷新：交回时已经是那一页。 */
	history(id: string, step: "back" | "forward" | "reload", sessionId?: string): Promise<void>;
	/** 人点的后退、前进、刷新：不等。 */
	go(id: string, step: "back" | "forward" | "reload"): Promise<void>;
	/** 成为这个会话当前的一页。 */
	select(id: string): void;
	/** 这个会话当前的一页，没有就是它最后开的一页。 */
	current(sessionId: string): BrowserPage | undefined;
	point(id: string, point: Omit<PagePointer, "sequence">): void;
	zoom(id: string, factor: number): Promise<void>;
	viewport(id: string, viewport: Viewport | null): Promise<void>;
	resize(id: string, width: number, height: number): Promise<void>;
	/** 听着下一次主框架换文档（或页面关掉、卸掉），用完要 `stop`。 */
	navigates(id: string): { left: Promise<true>; stop(): void };
	attach(id: string, contentsId: number): Promise<void>;
	/** 面板上的这个标签还没有页就记一页空白的；关掉过的不再开，返回 false。 */
	ensure(id: string, sessionId: string | null): Promise<boolean>;
	adopt(id: string, sessionId: string): void;
	close(id: string): void;
	closeSession(sessionId: string): void;
	/** 页面上的事件，`ctx.pages.onEvent` 交来的。 */
	event(event: WebPageEvent): void;
	/** 某一页的对话框被宿主答了，交给正在跑的工具调用。 */
	onDialog(listener: (sessionId: string | null, event: Extract<WebPageEvent, { type: "dialog" }>) => void): void;
	/** 新挂上的一页：正在跑的调用要接管它的对话框。 */
	onAttached(listener: (page: BrowserPage) => void): void;
	/** 这个会话的 agent 这一轮在用浏览器：它的页一直挂着，不睡。 */
	engage(sessionId: string): void;
	/** 这一轮结束了，它的页回到按最近看过的挂着。 */
	release(sessionId: string): void;
	/** 正在用浏览器的会话。 */
	engaged(): string[];
}

export function createWorkspace(web: WebPages, defaultZoom: () => Promise<number>): Workspace {
	const entries = new Map<string, Entry>();
	/** 关掉过的页：界面里那个标签退场之前还会再挂一下，不能因此又开出来。 */
	const closed = new Set<string>();
	/** 每个会话现在在哪一页，按会话（新对话是 `""`）。 */
	const activeBySession = new Map<string, string>();
	const watchers = new Set<(update: BrowserUpdate) => void>();
	const dialogListeners = new Set<(sessionId: string | null, event: Extract<WebPageEvent, { type: "dialog" }>) => void>();
	const attachedListeners = new Set<(page: BrowserPage) => void>();
	const busy = new Set<string>();
	const key = (sessionId: string | null) => sessionId ?? "";

	const viewOf = (entry: Entry): BrowserPage => ({
		...entry.view,
		arriving: entry.view.url !== "about:blank" && (entry.shown === "" || entry.shown === "about:blank"),
		held: entry.wanted || (entry.view.sessionId !== null && busy.has(entry.view.sessionId)),
	});
	const snapshot = () => [...entries.values()].map(viewOf);
	function publish(extra: Omit<BrowserUpdate, "pages"> = {}): void {
		const update = { pages: snapshot(), ...extra };
		for (const push of watchers) push(update);
	}
	function entryOf(id: string): Entry {
		const entry = entries.get(id);
		if (!entry) throw new PageClosed();
		return entry;
	}
	function owned(id: string, sessionId?: string): Entry {
		const entry = entryOf(id);
		if (sessionId !== undefined && entry.view.sessionId !== sessionId) throw new Error("This browser tab belongs to another conversation");
		return entry;
	}
	function selectEntry(entry: Entry): void {
		activeBySession.set(key(entry.view.sessionId), entry.view.id);
	}

	/** 等这一页报来一件 `test` 认的事；页面关了抛 `PageClosed`，超时抛 `timeout`。 */
	function until(entry: Entry, test: (event: WebPageEvent) => boolean, timeout: string, start?: () => void): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error(timeout)), WAIT_MS);
			const listener = (event: WebPageEvent | { type: "closed" }) => {
				if (event.type === "closed") finish(new PageClosed());
				else if (test(event)) finish();
			};
			const finish = (error?: Error) => {
				clearTimeout(timer);
				entry.listeners.delete(listener);
				if (error) reject(error);
				else resolve();
			};
			entry.listeners.add(listener);
			start?.();
		});
	}

	async function ready(entry: Entry): Promise<void> {
		if (entry.attached) return;
		if (!entry.wanted) {
			entry.wanted = true;
			publish();
		}
		await until(entry, (event) => event.type === "attached", NOT_READY);
	}

	/** 缩放和视口落到页面上。页面进程停了的不碰：宿主也不碰，恢复后由 dom-ready 再落一次。 */
	async function applyView(entry: Entry): Promise<void> {
		if (!entry.attached) return;
		const { id, zoom, viewport } = entry.view;
		entry.scale = viewport && entry.size ? Math.min(1, entry.size.width / viewport.width, entry.size.height / viewport.height) : 1;
		await web.setZoom(id, zoom).catch(() => {});
		await web.emulate(id, viewport ? { ...viewport, scale: entry.scale } : null).catch(() => {});
	}

	async function loadInto(entry: Entry, url: string, reveal: boolean): Promise<string> {
		entry.view.failure = undefined;
		entry.view.url = url;
		entry.requested = url;
		selectEntry(entry);
		publish({ open: { page: entry.view.id, sessionId: entry.view.sessionId, reveal } });
		await ready(entry);
		// 不等加载完：站点不回应时那可以一直不了结。失败由 `failed` 事件记下，等文档的是 `loaded`，它有时限。
		entry.ready = false;
		await web.load(entry.view.id, url);
		return entry.view.id;
	}

	async function loaded(id: string, sessionId?: string): Promise<void> {
		const entry = owned(id, sessionId);
		await ready(entry);
		stopped(entry);
		if (entry.ready) return;
		await until(
			entry,
			(event) =>
				event.type === "dom-ready" ||
				(event.type === "loading" && !event.loading) ||
				event.type === "detached" ||
				(event.type === "dialog" && event.dialog === "beforeunload" && !event.accepted) ||
				event.type === "gone",
			NOT_LOADED,
		);
		// 等的时候页面被卸掉了：标签还在就等它再挂上。
		if (!entry.attached) {
			if (!entries.has(id)) throw new PageClosed();
			return loaded(id, sessionId);
		}
		stopped(entry);
	}

	/** 页面进程停了、不再自己重来的那一页：读不了，直接说为什么。 */
	function stopped(entry: Entry): void {
		const failure = entry.view.failure;
		if (failure?.kind === "crash") throw new Error(crashed(failure.detail));
	}

	function newEntry(id: string, sessionId: string | null, url: string, zoom: number): Entry {
		const entry: Entry = {
			view: {
				id,
				sessionId,
				url,
				title: "",
				loading: url !== "about:blank",
				canGoBack: false,
				canGoForward: false,
				zoom,
				viewport: null,
				arriving: false,
				held: false,
			},
			attached: false,
			wanted: false,
			ready: false,
			shown: "",
			crashedAt: 0,
			retried: false,
			scale: 1,
			nextRef: 1,
			listeners: new Set(),
		};
		entries.set(id, entry);
		return entry;
	}

	function close(id: string): void {
		const entry = entries.get(id);
		if (!entry) return;
		entries.delete(id);
		closed.add(id);
		// 这个会话退回它自己剩下的一页，不是全局最新的那一页。
		const owner = key(entry.view.sessionId);
		if (activeBySession.get(owner) === id) {
			const fallback = [...entries.values()].findLast((other) => key(other.view.sessionId) === owner);
			if (fallback) activeBySession.set(owner, fallback.view.id);
			else activeBySession.delete(owner);
		}
		for (const listener of [...entry.listeners]) listener({ type: "closed" });
		publish({ close: { page: id, sessionId: entry.view.sessionId } });
	}

	function merge(entry: Entry, event: WebPageEvent): void {
		const { state } = event;
		// 新文档落地了；或离开页面的提示被取消、留在原页，那就不会去了。
		if ((event.type === "navigated" && !event.inPage) || (event.type === "dialog" && event.dialog === "beforeunload" && !event.accepted))
			entry.requested = undefined;
		entry.shown = state.url;
		// 刚挂上、第一个响应还没回来时页面的地址是空的，地址栏照旧写着要去的那一页。
		entry.view.url = entry.requested ?? (state.url || entry.view.url);
		entry.view.title = state.title;
		entry.view.loading = state.loading;
		entry.view.canGoBack = state.canGoBack;
		entry.view.canGoForward = state.canGoForward;
	}

	function event(event: WebPageEvent): void {
		const entry = entries.get(event.page);
		if (!entry) return;
		if (event.type !== "detached") merge(entry, event);
		switch (event.type) {
			case "attached":
				entry.attached = true;
				// 挂上了：之后留不留由界面按最近看过的定。
				entry.wanted = false;
				// 挂上时多半还在等第一个响应；已经加载完的才算现成。
				entry.ready = !event.state.loading && event.state.url !== "";
				void applyView(entry);
				for (const listener of attachedListeners) listener(viewOf(entry));
				break;
			case "detached":
				entry.attached = false;
				entry.ready = false;
				break;
			case "navigation":
				entry.ready = false;
				entry.navigating = event.url;
				// 又在加载一张文档了：上一次的失败不再是这一页的样子。
				entry.view.failure = undefined;
				break;
			case "dom-ready":
				entry.ready = true;
				// 换了文档，Chromium 按源换上那个源的缩放；页面进程重来过的也不带旧的设备仿真。
				void applyView(entry);
				break;
			case "loading":
				if (!event.loading) {
					entry.ready = true;
					/*
					 * 第一跳无声地断了：什么也没提交、也没有失败（302 去 `lark://` 这类，被宿主拦下时恰好在挂上之前的空当里），
					 * 标签会停在一张白页上。照原地址再走一遍，只走一次。
					 */
					if (!event.state.url && !entry.view.failure && entry.view.url !== "about:blank" && !entry.retried && entry.attached) {
						entry.retried = true;
						entry.ready = false;
						void web.load(entry.view.id, entry.view.url).catch(() => {});
					}
				}
				break;
			case "failed":
				entry.view.failure = { kind: "load", detail: event.description };
				break;
			case "gone": {
				entry.ready = false;
				/*
				 * 页面进程没了（崩溃、内存不够被系统杀掉）：自动重新加载一次，回到原来那一页。15 秒内又没了就不再重来，停在错误上
				 * 等人点刷新——一加载就崩的页，自动重来只会无休止地崩下去。
				 */
				const now = Date.now();
				if (now - entry.crashedAt > 15_000) {
					entry.crashedAt = now;
					void web.go(entry.view.id, "reload").catch(() => {});
				} else entry.view.failure = { kind: "crash", detail: event.reason };
				break;
			}
			case "blocked": {
				// 页面已经立着、自己用脚本去试唤起客户端的不盖：不少站点一打开就试一次，盖上去会把一张好好的页面挡住。
				const shown = event.state.url;
				if (!event.redirect && shown && shown !== "about:blank") break;
				entry.view.failure = { kind: "blocked", detail: event.url, url: (event.redirect ? entry.navigating : undefined) ?? (shown || entry.view.url) };
				break;
			}
			case "popup":
				// 页面开窗口不是人要看：开成同一会话的一个后台标签。
				void open(event.url, entry.view.sessionId, { newTab: true, reveal: false }).catch(() => {});
				break;
			case "dialog":
				// 离开页面的提示被取消时留在这一页：旧文档照旧能读，等着换页的那一方不必等满时限。
				if (event.dialog === "beforeunload" && !event.accepted) entry.ready = true;
				for (const listener of dialogListeners) listener(entry.view.sessionId, event);
				break;
		}
		for (const listener of [...entry.listeners]) listener(event);
		publish();
	}

	async function open(url: string, sessionId: string | null, { newTab, reveal }: { newTab: boolean; reveal: boolean }): Promise<string> {
		const location = webUrl(url);
		const current = entries.get(activeBySession.get(key(sessionId)) ?? "");
		/*
		 * 这个会话已经开着的同一页，新标签再开一份就是同一页两份：agent 每改一次就看一次，会攒出一串一样的标签。重新载入那一页。
		 * 空白页除外：那是人点的「新标签页」，要两个空白的就给两个。
		 */
		const twin =
			newTab && location !== "about:blank"
				? [...entries.values()].find((entry) => entry.view.sessionId === sessionId && entry.view.url === location)
				: undefined;
		const existing = twin ?? (!newTab && current?.view.sessionId === sessionId ? current : undefined);
		if (existing) return loadInto(existing, location, reveal);
		if (entries.size >= MAX_PAGES) throw new Error(`At most ${MAX_PAGES} tabs can be open; close some first`);
		const entry = newEntry(randomUUID(), sessionId, location, await defaultZoom());
		if (location !== "about:blank") entry.requested = location;
		selectEntry(entry);
		publish({ open: { page: entry.view.id, sessionId, reveal } });
		await ready(entry);
		return entry.view.id;
	}

	return {
		pages: snapshot,
		page: (id) => {
			const entry = entries.get(id);
			return entry && viewOf(entry);
		},
		scale: (id) => entries.get(id)?.scale ?? 1,
		refs: (id) => entries.get(id)?.nextRef ?? 1,
		setRefs: (id, next) => {
			const entry = entries.get(id);
			if (entry) entry.nextRef = next;
		},
		watch(push) {
			watchers.add(push);
			push({ pages: snapshot() });
			return () => void watchers.delete(push);
		},
		open,
		async navigate(id, url) {
			const entry = entryOf(id);
			await loadInto(entry, webUrl(url), false);
		},
		loaded,
		async history(id, step, sessionId) {
			const entry = owned(id, sessionId);
			// 页面进程停了的那一页，`loaded` 会直接报错；agent 的 reload 就是人点的刷新，绕过它重新加载。
			if (step === "reload" && entry.view.failure?.kind === "crash") {
				entry.view.failure = undefined;
				entry.ready = false;
				await web.go(id, "reload");
				await loaded(id, sessionId);
				return;
			}
			await loaded(id, sessionId);
			if (step === "back" && !entry.view.canGoBack) throw new Error("There is no previous page to go back to");
			if (step === "forward" && !entry.view.canGoForward) throw new Error("There is no next page to go forward to");
			/*
			 * 先等这一步落地（`navigated`，页内跳转也算），再等文档：页内跳转没有加载事件，一上来就等文档会白等满时限；
			 * 换了文档的，`navigation` 已把 `ready` 拨回去。
			 */
			await until(
				entry,
				(event) => event.type === "navigated" || event.type === "failed" || event.type === "detached",
				NOT_LOADED,
				() => void web.go(id, step).catch(() => {}),
			);
			await loaded(id, sessionId);
		},
		async go(id, step) {
			const entry = entryOf(id);
			if (step === "reload") entry.view.failure = undefined;
			await web.go(id, step);
		},
		select(id) {
			const entry = entryOf(id);
			selectEntry(entry);
			// Chromium 按源共用缩放：同源的另一页改过缩放，这一页回到前面时落回自己的。
			void applyView(entry);
			publish();
		},
		current(sessionId) {
			const active = entries.get(activeBySession.get(sessionId) ?? "");
			const found = active && active.view.sessionId === sessionId ? active : [...entries.values()].findLast((entry) => entry.view.sessionId === sessionId);
			return found && viewOf(found);
		},
		point(id, point) {
			const entry = entryOf(id);
			entry.view.pointer = { ...point, sequence: (entry.view.pointer?.sequence ?? 0) + 1 };
			publish();
		},
		async zoom(id, factor) {
			const entry = entryOf(id);
			entry.view.zoom = factor;
			await applyView(entry);
			publish();
		},
		async viewport(id, viewport) {
			const entry = entryOf(id);
			entry.view.viewport = viewport;
			await applyView(entry);
			publish();
		},
		async resize(id, width, height) {
			const entry = entries.get(id);
			// 人关掉标签以后，尺寸的通知还可能晚到一次。
			if (!entry || !(width > 0) || !(height > 0)) return;
			entry.size = { width, height };
			if (entry.view.viewport) await applyView(entry);
		},
		navigates(id) {
			const entry = entryOf(id);
			let stop = () => {};
			const left = new Promise<true>((resolve) => {
				const listener = (event: WebPageEvent | { type: "closed" }) => {
					// 页面关了、卸掉了也算离开：等着它的一方去等新页，在那里得知页面没了。
					if (event.type === "navigation" || event.type === "closed" || event.type === "detached") resolve(true);
				};
				entry.listeners.add(listener);
				stop = () => void entry.listeners.delete(listener);
			});
			return { left, stop };
		},
		async attach(id, contentsId) {
			if (!entries.has(id)) return;
			await web.attach(id, contentsId);
		},
		async ensure(id, sessionId) {
			if (entries.has(id)) return true;
			if (closed.has(id)) return false;
			const zoom = await defaultZoom();
			if (closed.has(id)) return false;
			if (!entries.has(id)) {
				selectEntry(newEntry(id, sessionId, "about:blank", zoom));
				publish();
			}
			return true;
		},
		adopt(id, sessionId) {
			const entry = entries.get(id);
			if (!entry || entry.view.sessionId !== null) return;
			if (activeBySession.get("") === id) activeBySession.delete("");
			entry.view.sessionId = sessionId;
			selectEntry(entry);
			publish();
		},
		close,
		closeSession(sessionId) {
			for (const entry of [...entries.values()]) if (entry.view.sessionId === sessionId) close(entry.view.id);
		},
		event,
		onDialog: (listener) => void dialogListeners.add(listener),
		onAttached: (listener) => void attachedListeners.add(listener),
		engage(sessionId) {
			if (busy.has(sessionId)) return;
			busy.add(sessionId);
			publish();
		},
		release(sessionId) {
			if (busy.delete(sessionId)) publish();
		},
		engaged: () => [...busy],
	};
}
