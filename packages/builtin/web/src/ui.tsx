/**
 * plume.web 的界面入口，跑在渲染进程：设置页里「网页搜索」那一节，两个工具在转录里的说法。
 *
 * 两个工具没有专用卡片，对话里用宿主的通用卡片。设置在逻辑入口那边（插件数据目录），经 `ui.remote()` 读写；key 不到这边来。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { Globe, Search } from "@plume/ui/icons";
import type { WebApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { SearchSettings } from "./SearchSettings.tsx";
import webCss from "./web.css";

/** 宿主不加载插件的样式表，这里自己挂一份。按插件名认那个元素：重新加载时换掉内容，不叠一份。 */
function mountStyles(): void {
	const id = "plume.web";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = webCss;
}

/** 抓的是哪一页，一行摘要里点名的那部分：网站报主机名，`.html` 报文件名——整串地址放在一行里只会被截掉。 */
function pageSubject(url: unknown): string | undefined {
	if (typeof url !== "string" || url.trim() === "") return undefined;
	try {
		const parsed = new URL(url);
		const name = parsed.pathname.split("/").findLast(Boolean) ?? "";
		return /\.html?$/i.test(name) ? name : parsed.host || undefined;
	} catch {
		return undefined;
	}
}

export default {
	name: "plume.web",
	apply(ui) {
		mountStyles();
		const api = ui.remote<WebApi>();
		const notify = ui.notify.bind(ui);
		// 查资料时抓一页、搜一次是同一段活，和浏览器、读文件那几类接在一起。
		ui.toolLine("web_fetch", { verb: (locale) => MESSAGES[locale].toolFetch, subject: (args) => pageSubject(args.url), group: "web", icon: Globe });
		ui.toolLine("web_search", { verb: (locale) => MESSAGES[locale].toolSearch, group: "web" });
		ui.settingsSection("search", () => <SearchSettings api={api} notify={notify} openExternal={ui.openExternal.bind(ui)} />, {
			title: (locale) => MESSAGES[locale].title,
			detail: (locale) => MESSAGES[locale].intro,
			icon: Search,
			order: 3,
			group: "agent",
			page: "nav",
		});
	},
} satisfies UiPlugin;
