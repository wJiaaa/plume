/**
 * 界面入口这边的一份网页和设置：逻辑入口推来什么就是什么。整个窗口一份，从 apply 起就连着 `watch`——agent 在哪个会话
 * 开了一页，面板就得在那里开出一个标签，不管那时有没有人看着浏览器面板。
 */

import type { Remote } from "@plume/contract/ui";
import type { BrowserApi, BrowserPage, BrowserSettings, BrowserUpdate } from "./api.ts";
import { DEFAULT_SETTINGS } from "./address.ts";

interface BrowserState {
	pages: BrowserPage[];
	/** 第一份现状到了：在那之前查不到一页，不等于这一页没有。 */
	loaded: boolean;
	settings: BrowserSettings;
	/** 页面挂着的会话，最近看过的在前，见 `LOADED_SESSIONS`。 */
	recent: string[];
}

/**
 * 几个会话的页面一直挂着。每一页是一个 `<webview>`，各占一个渲染进程；标签按会话分开，全挂着的话，开过网页的会话越多，
 * 没人看的页越多。三个而不是一个：切到一个会话再切回来是常事，切走就卸掉，回来就是重新加载——滚动位置、表单里打的字都没了。
 * agent 这一轮在用浏览器的会话不在此列，一直挂着（`BrowserPage.held`）。
 */
const LOADED_SESSIONS = 3;

export interface BrowserStore {
	get(): BrowserState;
	subscribe(listener: () => void): () => void;
	/** 人看着这个会话：它的页面挂着。 */
	visit(sessionId: string): void;
	saveSettings(patch: Partial<BrowserSettings>): Promise<void>;
}

export function createStore(api: Remote<BrowserApi>, signals: (update: BrowserUpdate) => void): BrowserStore {
	let state: BrowserState = { pages: [], loaded: false, settings: DEFAULT_SETTINGS, recent: [] };
	const listeners = new Set<() => void>();
	const set = (next: Partial<BrowserState>) => {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	};

	void (async () => {
		try {
			for await (const update of api.watch()) {
				set({ pages: update.pages, loaded: true });
				signals(update);
			}
		} catch {
			// 逻辑入口停了：插件重新加载时界面入口也会重来，到时重新连上。
		}
	})();
	void api.settings().then(
		(settings) => set({ settings }),
		() => {},
	);

	return {
		get: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		visit(sessionId) {
			if (state.recent[0] !== sessionId) set({ recent: [sessionId, ...state.recent.filter((entry) => entry !== sessionId)].slice(0, LOADED_SESSIONS) });
		},
		async saveSettings(patch) {
			set({ settings: await api.saveSettings(patch) });
		},
	};
}
