/**
 * 界面语言的设置在渲染进程这一头：当前值和改动。存盘在主进程（main/locale.ts），启动时同步取到，第一帧就是对的语言。
 * 「跟随系统」由 @plume/ui 的 I18nProvider 按浏览器的语言列表解析。
 */

import type { UiLocale } from "@plume/ui";
import { useSyncExternalStore } from "react";

const valid = (value: unknown): value is UiLocale => value === "system" || value === "zh-CN" || value === "en";

let current: UiLocale = valid(window.plume.locale) ? window.plume.locale : "system";
const listeners = new Set<() => void>();

export function setLocaleSetting(locale: UiLocale): void {
	current = locale;
	for (const listener of listeners) listener();
	window.plume.saveLocale(locale).catch((error: unknown) => console.error("界面语言没存上：", error));
}

export function useLocaleSetting(): UiLocale {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current,
	);
}
