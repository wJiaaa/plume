/**
 * 菜单栏图标的菜单有哪些项，写成数据。
 *
 * 和 tray.ts 分开，不引用 electron，测试才能直接读它。放什么只有一个标准：窗口不在眼前时值得做的事，
 * 冷启动的应用上点一下就能到。
 */

import type { Locale, SessionSummary } from "@plume/contract";
import type { AppCommand } from "../shared/app-command.ts";
import { nativeText } from "./i18n.ts";

export type TrayAction = { kind: "toggle-window" } | { kind: "command"; command: AppCommand } | { kind: "toggle-login" } | { kind: "quit" };

export type TrayItem =
	| { type: "separator" }
	| { type: "item"; label: string; action: TrayAction; checked?: boolean; enabled?: boolean }
	| { type: "submenu"; label: string; items: TrayItem[] };

export interface TrayState {
	/** 窗口现在在不在屏上：决定第一项是「打开」还是「隐藏」。 */
	windowVisible: boolean;
	/** agent 进程给的全部会话摘要，挑哪几个由 `recentSessions` 定。 */
	sessions: readonly SessionSummary[];
	launchAtLogin: boolean;
	locale: Locale;
}

/**
 * 子菜单列几个会话。系统菜单默认字号下不用滚动就放得下；这是捷径，不是会话列表，更早的去窗口里找。
 */
export const RECENT_LIMIT = 5;

/** 最近的会话：侧栏里看得到的那些（不含归档的、子会话和插件的独立会话），按最后活动排。 */
export function recentSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
	return sessions
		.filter((session) => !session.archived && !session.parentId && !session.owner)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, RECENT_LIMIT);
}

/**
 * 菜单项只有一行，会话标题却是人随手打的一句话。系统菜单不换行，不截的话菜单会被撑到最长那句话那么宽，所以截断。
 * 没有标题时用菜单自己语言里的「新对话」。
 */
export function trayTitle(title: string, untitled: string, limit = 28): string {
	const text = Array.from(title.trim());
	if (text.length === 0) return untitled;
	return text.length > limit ? `${text.slice(0, limit - 1).join("")}…` : text.join("");
}

export function trayMenu(state: TrayState): TrayItem[] {
	const t = (key: Parameters<typeof nativeText>[1]) => nativeText(state.locale, key);
	const recent = recentSessions(state.sessions);
	return [
		// 写按下去会做什么，不写现在是什么状态。
		{ type: "item", label: state.windowVisible ? t("tray.hide") : t("tray.show"), action: { kind: "toggle-window" } },
		{ type: "separator" },
		{ type: "item", label: t("tray.newChat"), action: { kind: "command", command: "new-session" } },
		{
			type: "submenu",
			label: t("tray.recent"),
			items:
				recent.length > 0
					? recent.map((session) => ({
							type: "item" as const,
							label: trayTitle(session.title, t("tray.newChat")),
							action: { kind: "command" as const, command: `open-session:${session.id}` as const },
						}))
					: // 一行灰掉的字，而不是空菜单：空菜单看上去像没加载出来。
						[{ type: "item" as const, label: t("tray.noChats"), action: { kind: "toggle-window" as const }, enabled: false }],
		},
		{ type: "separator" },
		{ type: "item", label: t("tray.settings"), action: { kind: "command", command: "settings" } },
		{ type: "item", label: t("tray.updates"), action: { kind: "command", command: "updates" } },
		{ type: "item", label: t("tray.launchAtLogin"), action: { kind: "toggle-login" }, checked: state.launchAtLogin },
		{ type: "separator" },
		{ type: "item", label: t("tray.quit"), action: { kind: "quit" } },
	];
}
