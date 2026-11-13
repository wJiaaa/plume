/** 给人看的文字（审批卡的标题和说明、提示条），两种界面语言写在一起。发给模型的话不在这里，不随界面语言变。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	escalate: (command: string) => `提权运行：${command}`,
	jobDone: "后台命令完成",
	jobFailed: "后台命令失败",
	jobExitCode: (code: number) => `退出码 ${code}`,
	jobKilled: "被终止",
	jobsEnded: (n: number) => `${n} 个后台命令结束`,
	jobsFailed: (n: number) => `${n} 个失败`,
	monitorLines: (n: number) => `监视到 ${n} 行新输出`,
	monitorStopped: "监视已停止",
	monitorIdle: "长时间没有输出",
	monitorMaxEvents: "达到行数上限",
	jobsUpdated: (n: number) => `${n} 个后台命令有新输出`,
	wakeupFired: "定时唤醒",
	/** 转录里 monitor 那一行的动作。 */
	monitorVerb: "监视命令",
};

const en: typeof zhCN = {
	escalate: (command) => `Run with wider access: ${command}`,
	jobDone: "Background command done",
	jobFailed: "Background command failed",
	jobExitCode: (code) => `exit code ${code}`,
	jobKilled: "killed",
	jobsEnded: (n) => (n === 1 ? `${n} background command ended` : `${n} background commands ended`),
	jobsFailed: (n) => `${n} failed`,
	monitorLines: (n) => (n === 1 ? `${n} new line from a monitor` : `${n} new lines from a monitor`),
	monitorStopped: "Monitor stopped",
	monitorIdle: "no output for a while",
	monitorMaxEvents: "line limit reached",
	jobsUpdated: (n) => (n === 1 ? `New output from ${n} background command` : `New output from ${n} background commands`),
	wakeupFired: "Scheduled wakeup",
	monitorVerb: "Watched commands",
};

/** 界面入口按 `useI18n().resolvedLocale` 取；逻辑入口用 `words()`。 */
export const MESSAGES: Record<Locale, typeof zhCN> = { "zh-CN": zhCN, en };

/** 现在的界面语言，插件加载时换成 `ctx.locale`；测试里直接调工具时是中文。 */
let locale: () => Locale = () => "zh-CN";

export function setLocaleSource(current: () => Locale): void {
	locale = current;
}

export function words(): typeof zhCN {
	return MESSAGES[locale()];
}
