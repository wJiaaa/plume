import { skinValues } from "./skin-values.ts";

/** 各插件的皮肤按注册先后叠放；撤下最后一个后，连同管理状态一起恢复前一个。 */
export function skinRegistry(changed: (skin: { name: string; mode: "system" | "light" | "dark" } | undefined) => void) {
	let entries: Array<{ plugin: string; style: HTMLStyleElement; managed: { name: string; mode: "system" | "light" | "dark" } | undefined }> = [];
	const enableLatest = () => {
		entries.forEach(({ style }, index) => {
			if (style.sheet) style.sheet.disabled = index !== entries.length - 1;
		});
		changed(entries.at(-1)?.managed);
	};
	const remove = (plugin: string) => {
		for (const { style } of entries.filter((entry) => entry.plugin === plugin)) style.remove();
		entries = entries.filter((entry) => entry.plugin !== plugin);
		enableLatest();
	};
	return {
		remove,
		set(plugin: string, skin: unknown): void {
			if (skin === null) {
				remove(plugin);
				return;
			}
			const defaults = getComputedStyle(document.documentElement);
			const { managed, schemes } = skinValues(skin, (token) => defaults.getPropertyValue(`--plume-${token}`).trim() !== "");
			// 接在产品样式表后面；值经 CSSOM 写进变量，不拼 CSS 文本。
			const style = document.createElement("style");
			style.dataset.skin = plugin;
			document.head.append(style);
			const sheet = style.sheet as CSSStyleSheet;
			for (const [scheme, tokens] of schemes) {
				const media = sheet.cssRules[sheet.insertRule(`@media (prefers-color-scheme: ${scheme}) { :root {} }`, sheet.cssRules.length)] as CSSMediaRule;
				const root = (media.cssRules[0] as CSSStyleRule).style;
				for (const [token, value] of tokens) root.setProperty(`--plume-${token}`, value);
			}
			for (const { style: old } of entries.filter((entry) => entry.plugin === plugin)) old.remove();
			entries = [...entries.filter((entry) => entry.plugin !== plugin), { plugin, style, managed }];
			enableLatest();
		},
	};
}
