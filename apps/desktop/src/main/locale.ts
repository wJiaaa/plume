/**
 * 界面语言的设置：跟随系统、中文或英文，存在数据目录（见 home.ts）的 locale.json。
 *
 * 渲染进程第一帧之前同步取一次，文字一出来就是对的语言；agent 进程启动时经环境变量拿到解析好的那一种，
 * 插件加载失败的原因用它写（之后语言再变，由渲染进程直接告诉 agent 进程）。
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locale } from "@plume/contract";
import { app, ipcMain } from "electron";
import { plumeHome } from "./home.ts";

export type LocaleSetting = "system" | Locale;

const file = () => join(plumeHome(), "locale.json");
const valid = (value: unknown): value is LocaleSetting => value === "system" || value === "zh-CN" || value === "en";

let current: LocaleSetting = "system";
/** 存盘排队，后选的不会被先选的盖掉。 */
let saving: Promise<void> = Promise.resolve();

/** fallback 是没存过时用的设置。 */
export function loadLocale(fallback: LocaleSetting = "system"): LocaleSetting {
	current = fallback;
	try {
		const saved = (JSON.parse(readFileSync(file(), "utf8")) as { locale?: unknown }).locale;
		if (valid(saved)) current = saved;
	} catch {
		// 没存过，或者文件坏了：跟随系统。
	}
	return current;
}

/** 解析成一种语言，规则和界面的 resolveUiLocale 一样：各地区的中文落到简体中文，认不出的落到英文。 */
export function resolvedLocale(): Locale {
	if (current !== "system") return current;
	for (const language of app.getPreferredSystemLanguages()) {
		const normalized = language.trim().replaceAll("_", "-").toLowerCase();
		if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
		if (normalized === "en" || normalized.startsWith("en-")) return "en";
	}
	return "en";
}

export function registerLocaleIpc(): void {
	ipcMain.on("plume:locale", (event) => {
		event.returnValue = current;
	});
	ipcMain.handle("plume:locale:save", (_event, value: unknown) => {
		if (!valid(value)) return;
		current = value;
		const snapshot = JSON.stringify({ locale: value }, null, "\t");
		saving = saving.then(() => writeFile(file(), snapshot)).catch((error: unknown) => console.error("界面语言没存上：", error));
		return saving;
	});
}
