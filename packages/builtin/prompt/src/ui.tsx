/**
 * plume.prompt 的界面入口，跑在渲染进程：设置 › 个性化里「身份与准则」那一节。
 *
 * 选的、写的都在逻辑入口那边（插件数据目录），经 `ui.remote()` 读写。
 */

import type { UiPlugin } from "@plume/contract/ui";
import type { PromptApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { PresetSettings } from "./PresetSettings.tsx";
import promptCss from "./prompt.css";

/** 宿主不加载插件的样式表，这里自己挂一份。按插件名认那个元素：重新加载时换掉内容，不叠一份。 */
function mountStyles(): void {
	const id = "plume.prompt";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = promptCss;
}

export default {
	name: "plume.prompt",
	apply(ui) {
		mountStyles();
		const api = ui.remote<PromptApi>();
		const notify = ui.notify.bind(ui);
		ui.settingsSection("presets", () => <PresetSettings api={api} notify={notify} />, {
			title: (locale) => MESSAGES[locale].title,
			detail: (locale) => MESSAGES[locale].intro,
			page: "personalization",
		});
	},
} satisfies UiPlugin;
