/**
 * 角标和对话框在每个阶段显示什么，写成判断而不是标记。
 *
 * 下载有六种阶段、两处在画，规则散在两个组件的三元表达式里没法整体检查；放在这里、写成纯函数，测试把每个阶段都走一遍。
 * 文字经传进来的 `t` 取，测试用 `translateIn` 直接跑。
 */

import type { MessageKey } from "@plume/ui";
import type { UpdatePhase } from "../../shared/update.ts";

type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

/** 每个阶段，测试走全集而不是记得起来的那几个。 */
export const PHASES: UpdatePhase[] = [
	{ at: "idle" },
	{ at: "downloading", received: 45, total: 100 },
	{ at: "paused", received: 45, total: 100 },
	{ at: "preparing", received: 100, total: 100 },
	{ at: "ready" },
	// 主进程抛出的原样文字，不归这里翻译。
	{ at: "failed", error: "net::ERR_CONNECTION_RESET", received: 45, total: 100 },
];

/** 走到哪了，0–1；没有进度可说的阶段是 null（零进度的环和没有环是两种画面）。超了也夹住，环不会转过一圈。 */
export function fractionOf(phase: UpdatePhase): number | null {
	if (phase.at === "downloading" || phase.at === "paused") {
		// 第一个响应头到之前 total 是 0，45/0 是 Infinity。
		if (!(phase.total > 0)) return 0;
		return Math.min(1, Math.max(0, phase.received / phase.total));
	}
	if (phase.at === "preparing" || phase.at === "ready") return 1;
	return null;
}

/** 角标展开后写的字，短，是标签不是句子。 */
export function labelFor(phase: UpdatePhase, version: string, t: Translate): string {
	const percent = Math.round((fractionOf(phase) ?? 0) * 100);
	switch (phase.at) {
		case "downloading":
			return t("update.downloadingPercent", { percent });
		case "paused":
			return t("update.pausedPercent", { percent });
		case "preparing":
			return t("update.preparing");
		case "ready":
			return t("update.restartToUpdate");
		case "failed":
			return t("update.failed");
		default:
			return t("update.newVersion", { version });
	}
}

/** 对话框里确认按钮写的字。 */
export function confirmLabel(phase: UpdatePhase, t: Translate): string {
	switch (phase.at) {
		case "downloading":
			return t("updateDialog.pause");
		case "paused":
			return t("update.resume");
		case "preparing":
			return t("update.preparing");
		case "ready":
			return t("update.restartNow");
		case "failed":
			return t("update.retry");
		default:
			return t("update.download");
	}
}

/**
 * 这个阶段给哪些按钮：下载中确认按钮是「暂停」；准备中不能暂停，那时按钮变灰；「关闭」一直在（关对话框不停下载）；
 * 「取消下载」只在有东西可扔时出现，没动过的更新上它只是换了个更吓人的字的「关闭」。
 */
export function controlsFor(phase: UpdatePhase): { confirmDisabled: boolean; confirmPauses: boolean; cancel: boolean } {
	const running = phase.at === "downloading";
	return {
		confirmDisabled: phase.at === "preparing",
		confirmPauses: running,
		cancel: running || phase.at === "paused" || (phase.at === "failed" && phase.received > 0),
	};
}

/**
 * 角标在不在：有比正在跑的更新的版本就在，装上为止。没有「以后再说」把它藏起来：角标不是要确认的通知，是以后来找更新的地方。
 */
export function shouldShow(update: { available: boolean } | null): boolean {
	return Boolean(update?.available);
}

/** 一眼读得懂的大小，一位小数。 */
export function mb(bytes: number): string {
	return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

/** 发布那天，按界面语言写。 */
export function publishedOn(at: number, locale: string): string {
	return new Date(at).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

/** 下载失败时对话框里写的：去掉路径，留下句子。Node 的原话（`open 'C:\…\download.part'`）是路径不是下一步。 */
export function failureDetail(error: string): string {
	return error
		.replace(/'[^']+'/g, "")
		.replace(/"[^"]+"/g, "")
		.replace(/[A-Za-z]:\\[^\s)]+/g, "")
		.replace(/\s{2,}/g, " ")
		.replace(/\s+([,.])/g, "$1")
		.trim();
}
