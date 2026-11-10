/**
 * 更新模块给人看的话。语言由 updates.ts 在注册时接上（locale.ts 的 resolvedLocale），这几个文件就不用引用 electron，
 * 测试能直接加载；没接上时（测试里）用中文。
 */

import type { Locale } from "@plume/contract";
import { type NativeKey, nativeText } from "../i18n.ts";

let locale: () => Locale = () => "zh-CN";

export function setUpdateLocale(next: () => Locale): void {
	locale = next;
}

export function say(key: NativeKey, variables?: Record<string, string | number>): string {
	return nativeText(locale(), key, variables && Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, String(value)])));
}
