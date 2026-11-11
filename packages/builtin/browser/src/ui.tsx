/**
 * plume.browser 的界面入口：往面板区加「浏览器」面板（一个标签一页，画 `<webview>`），往设置页加一节，登记五个工具在转录里的说法。
 *
 * 网页的账在逻辑入口，这里从 apply 起就连着它的 `watch`：agent 在哪个会话开了一页，就在那个会话的面板区开出那个标签；
 * 逻辑入口关了一页，就关掉那个标签。
 */

import type { Locale } from "@plume/contract";
import type { UiPlugin } from "@plume/contract/ui";
import { AppWindow, Camera, Globe, Monitor, MousePointer2 } from "@plume/ui/icons";
import type { BrowserApi } from "./api.ts";
import browserCss from "./browser.css";
import { browserPanel, PANEL } from "./BrowserPanel.tsx";
import { browserSettings } from "./BrowserSettings.tsx";
import { MESSAGES } from "./messages.ts";
import { createStore } from "./store.ts";

/** 宿主不加载插件的样式表，这里自己挂一份；按插件名认那个元素，更新后重新加载时换掉内容，不叠一份。 */
function mountStyles(): void {
	const id = "plume.browser";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = browserCss;
}

/** 打开的是哪一页，一行摘要里点名的那部分：本地文件报文件名，网站报主机名——整串地址放在一行里只会被截掉。 */
function pageSubject(url: unknown): string | undefined {
	if (typeof url !== "string" || url.trim() === "") return undefined;
	const lastPart = (path: string) => path.split(/[\\/]/).findLast(Boolean) ?? "";
	try {
		const parsed = new URL(url);
		const name = lastPart(parsed.pathname);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? (/\.html?$/i.test(name) ? name : parsed.host) : name || undefined;
	} catch {
		return lastPart(url) || undefined;
	}
}

export default {
	name: "plume.browser",
	apply(ui) {
		mountStyles();
		const api = ui.remote<BrowserApi>();
		const store = createStore(api, (update) => {
			// `reveal` 是 agent 打开的、人点的新标签页：切过去、展开面板区。页面自己开的新窗口只在后台加一个标签。
			if (update.open) ui.openPanel(PANEL, update.open.sessionId ?? undefined, { tab: update.open.page, background: !update.open.reveal });
			if (update.close) ui.closePanel(PANEL, update.close.sessionId ?? undefined, update.close.page);
		});
		ui.panel(PANEL, browserPanel(ui, api, store), {
			title: (locale) => MESSAGES[locale].title,
			description: (locale) => MESSAGES[locale].description,
			icon: Globe,
			shortcut: "CommandOrControl+T",
			// 一个标签一页。
			multiple: true,
			// 卸掉 `<webview>` 页面就没了：换会话、去设置页时藏起来，后台会话里 agent 照样操作得到它。
			keepAlive: true,
			// 弹到独立窗口里：那边画一个新的 `<webview>`，按这一页记着的地址重新加载、接上；接回来也一样。
			detachable: true,
		});
		// 回复里的网址、`.html` 文件签开进这个会话的一个新标签。
		ui.linkOpener({
			label: (locale) => MESSAGES[locale].openInBuiltin,
			icon: Globe,
			web: true,
			takesClicks: () => store.get().settings.openLinks === "builtin",
			file: (path) => /\.html?$/i.test(path),
			open: async (target, sessionId) => {
				await api.open("url" in target ? target.url : target.path, sessionId ?? null);
			},
		});
		// 五个工具在转录里的说法：都在用同一个页面，连着做（中间想一想也算）合成一段，和读、改文件接在一起。
		const line = (verb: "toolOpen" | "toolAct" | "toolTabs" | "toolViewport" | "toolScreenshot") => (locale: Locale) => MESSAGES[locale][verb];
		ui.toolLine("browser_open", { verb: line("toolOpen"), subject: (args) => pageSubject(args.url), group: "browser", icon: Globe });
		ui.toolLine("browser_act", { verb: line("toolAct"), group: "browser", times: true, icon: MousePointer2 });
		ui.toolLine("browser_tabs", { verb: line("toolTabs"), group: "browser", icon: AppWindow });
		ui.toolLine("browser_viewport", { verb: line("toolViewport"), group: "browser", icon: Monitor });
		ui.toolLine("browser_screenshot", { verb: line("toolScreenshot"), group: "browser", icon: Camera });
		ui.settingsSection("browser", browserSettings(ui, api, store), {
			title: (locale) => MESSAGES[locale].title,
			icon: Globe,
			page: "nav",
		});
	},
} satisfies UiPlugin;
