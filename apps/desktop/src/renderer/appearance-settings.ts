/**
 * 外观设置在渲染进程这一头：当前值、改动、把配色写进 token。存盘和主题在主进程（main/appearance.ts）。
 *
 * 配色只改种子（--plume-bg、--plume-fg、--plume-accent、--plume-contrast）和界面字体，其余色阶由 theme.css 照常推出来。
 * 写在单独一张样式表里，选择器是 :root:root：比 theme.css 和皮肤插件的 :root 都高一级，用户自己挑的值优先，
 * 没挑过的字段不写，皮肤和默认值照常起作用；数据皮肤管理时暂停种子覆盖，用户原值不变。值经 CSSOM 写进去，不拼 CSS 文本。
 */

import { useSyncExternalStore } from "react";
import { findCodeTheme, withHanFallback } from "@plume/ui";
import { codePalette } from "./code-appearance.ts";
import { type Appearance, type AppearancePatch, cleanAppearance, editableAppearancePatch, effectiveAppearance, patchAppearance } from "../shared/appearance.ts";

let current: Appearance = cleanAppearance(window.plume.appearance);
const listeners = new Set<() => void>();
let sheet: CSSStyleSheet | undefined;
let managedSkin: { name: string; mode: "system" | "light" | "dark" } | undefined;

export function useManagedSkin(): typeof managedSkin {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => managedSkin,
	);
}

export function setManagedSkin(skin: typeof managedSkin): void {
	managedSkin = skin;
	applyAppearance();
	for (const listener of listeners) listener();
	window.plume.setThemeOverride(skin?.mode ?? null).catch((error: unknown) => console.error("皮肤深浅模式没能更新：", error));
}

export function updateAppearance(patch: AppearancePatch): void {
	patch = editableAppearancePatch(patch, managedSkin !== undefined);
	current = patchAppearance(current, patch);
	applyAppearance();
	for (const listener of listeners) listener();
	// 本地先生效，存盘在后面：拖滑块时每一格都立刻画出来，不等主进程回话。
	window.plume.saveAppearance(patch).catch((error: unknown) => console.error("外观设置没存上：", error));
}

export function useAppearance(): Appearance {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current,
	);
}

export function applyAppearance(): void {
	const appearance = effectiveAppearance(current, managedSkin !== undefined);
	if (!sheet) {
		const element = document.createElement("style");
		element.dataset.plume = "appearance";
		document.head.append(element);
		sheet = element.sheet as CSSStyleSheet;
	}
	while (sheet.cssRules.length > 0) sheet.deleteRule(0);
	const rule = (media: string | undefined, values: Record<string, string | undefined>) => {
		const entries = Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined);
		if (entries.length === 0) return;
		const target = sheet as CSSStyleSheet;
		const index = target.insertRule(media ? `@media (prefers-color-scheme: ${media}) { :root:root {} }` : ":root:root {}", target.cssRules.length);
		const inserted = target.cssRules[index];
		const styleRule = (inserted instanceof CSSMediaRule ? inserted.cssRules[0] : inserted) as CSSStyleRule;
		for (const [name, value] of entries) styleRule.style.setProperty(`--plume-${name}`, value);
	};
	rule(undefined, {
		accent: appearance.accent,
		contrast: appearance.contrast === undefined ? undefined : String(appearance.contrast / 100),
		"font-sans": current.uiFont,
		"window-tint": !managedSkin && current.vibrancy === false ? "var(--plume-sidebar)" : undefined,
		"ui-size": current.uiFontSize === undefined ? undefined : `${current.uiFontSize}px`,
		"font-mono": current.codeFont ? withHanFallback(current.codeFont) : undefined,
		"code-size": current.codeFontSize === undefined ? undefined : `${current.codeFontSize}px`,
		"code-line-height": current.codeLineHeight === undefined ? undefined : String(current.codeLineHeight),
		"code-tracking": current.codeLetterSpacing === undefined ? undefined : `${current.codeLetterSpacing}em`,
	});
	rule("light", {
		bg: appearance.lightBackground,
		fg: appearance.lightForeground,
		...codePalette(current, findCodeTheme(current.codeLightTheme, "light"), false),
	});
	rule("dark", { bg: appearance.darkBackground, fg: appearance.darkForeground, ...codePalette(current, findCodeTheme(current.codeDarkTheme, "dark"), true) });
	document.documentElement.dataset.pointerCursor = String(current.pointerCursor ?? false);
	document.documentElement.dataset.reduceMotion = current.reduceMotion ?? "system";
	// 插件画的改动（git 面板）照这个属性换标记，见 skill plume-plugin 的 style-i18n。
	document.documentElement.dataset.diffMarkers = current.diffMarkers ?? "color";
	if (window.plume.vibrancy) document.documentElement.dataset.vibrancy = current.vibrancy === false ? "off" : "on";
}

window.plume.onAppearanceChanged((appearance) => {
	current = cleanAppearance(appearance);
	applyAppearance();
	for (const listener of listeners) listener();
});

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

/** 此刻是不是深色：跟着主题设置和系统一起变（主题由主进程的 nativeTheme 决定，页面只看得到结果）。 */
export function useDark(): boolean {
	return useSyncExternalStore(
		(listener) => {
			darkQuery.addEventListener("change", listener);
			return () => darkQuery.removeEventListener("change", listener);
		},
		() => darkQuery.matches,
	);
}

/** 某个 token 此刻的值：没设过的字段在设置页上显示的是 theme.css（或皮肤）给的那个。 */
export function tokenValue(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(`--plume-${name}`).trim();
}
