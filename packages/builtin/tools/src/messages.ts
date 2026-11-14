/** 给人看的文字（审批卡的标题和说明、提示条），两种界面语言写在一起。发给模型的话不在这里，不随界面语言变。 */

import type { Locale } from "@plume/contract";

/** 约好的那一项是哪种，见 `zhCN.plans`。 */
export type Plan = "checkIn" | "prompt" | "loop";

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
	/** 转录里 monitor 那一行的动作：跑着、停了以后（这次调用做的事是开始监视，停了也照样成立），几次合在一起时。 */
	monitorNow: "监视中",
	monitorDone: "已开始监视",
	monitorVerb: "监视",
	/**
	 * 模型约好的三种，各起一个名字，因为它们来几次、什么时候算完不一样：`schedule_wakeup` 是检查（过一会儿回来看一眼），
	 * 只来一次的 `cron_create` 是定时任务，反复的是轮询。环境卡片、到点那一行也用这三个词；后面接模型在 `reason` 里写给人看的那句。
	 */
	plans: { checkIn: "检查", prompt: "定时任务", loop: "轮询" } as Record<Plan, string>,
	/** 安排、停掉那一行的动作：跑着、做完。 */
	scheduleNow: { checkIn: "正在安排检查", prompt: "正在安排定时任务", loop: "正在开始轮询" } as Record<Plan, string>,
	scheduleDone: { checkIn: "已安排检查", prompt: "已安排定时任务", loop: "已开始轮询" } as Record<Plan, string>,
	cancelNow: "正在停止",
	cancelDone: { checkIn: "已取消检查", prompt: "已停止定时任务", loop: "已停止轮询" } as Record<Plan, string>,
	/** 几次合在一起、取不出是哪一种时的说法。 */
	cancelVerb: "已停止",
	listVerb: "已列出定时任务",
	listNow: "正在列出定时任务",
	listNone: "没有找到定时任务",
	listed: (n: number) => `已列出 ${n} 个定时任务`,
	/** 点开以后那几行的名称。 */
	fieldChecksIn: "检查时间",
	fieldSchedule: "频率",
	fieldOnce: (schedule: string) => `${schedule}（只一次）`,
	fieldNextRun: "下次运行",
	fieldExpires: "到期",
	fieldReason: "原因",
	fieldLasts: "有效期",
	lastsThisRun: "仅本次运行：按停止、撤回、归档或退出应用就取消",
	fieldId: "ID",
	fieldPrompt: "提示词",
	/** 频率的人话，见 `cron-words.ts`；认不出的写法照原式。 */
	everyMinute: "每分钟",
	everyMinutes: (n: number) => `每 ${n} 分钟`,
	hourlyAt: (minute: string) => `每小时第 ${minute} 分`,
	everyHours: (n: number, minute: string) => `每 ${n} 小时（第 ${minute} 分）`,
	dailyAt: (time: string) => `每天 ${time}`,
	weekdaysAt: (time: string) => `工作日 ${time}`,
	weeklyAt: (day: number, time: string) => `每周${"日一二三四五六日"[day]} ${time}`,
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
	monitorNow: "Watching",
	monitorDone: "Started watching",
	monitorVerb: "Watched",
	plans: { checkIn: "Check-in", prompt: "Scheduled prompt", loop: "Loop" },
	scheduleNow: { checkIn: "Scheduling check-in", prompt: "Scheduling prompt", loop: "Starting loop" },
	scheduleDone: { checkIn: "Scheduled check-in", prompt: "Scheduled prompt", loop: "Started loop" },
	cancelNow: "Stopping",
	cancelDone: { checkIn: "Cancelled check-in", prompt: "Stopped scheduled prompt", loop: "Stopped loop" },
	cancelVerb: "Stopped",
	listVerb: "Listed scheduled prompts",
	listNow: "Listing scheduled prompts",
	listNone: "Found no scheduled prompts",
	listed: (n) => `Listed ${n} scheduled prompt${n === 1 ? "" : "s"}`,
	fieldChecksIn: "Checks in",
	fieldSchedule: "Schedule",
	fieldOnce: (schedule) => `${schedule} (once)`,
	fieldNextRun: "Next run",
	fieldExpires: "Expires",
	fieldReason: "Reason",
	fieldLasts: "Lasts",
	lastsThisRun: "This run only: Stop, undo, archiving or quitting the app cancels it",
	fieldId: "ID",
	fieldPrompt: "Prompt",
	everyMinute: "Every minute",
	everyMinutes: (n) => `Every ${n} minutes`,
	hourlyAt: (minute) => `Hourly at :${minute}`,
	everyHours: (n, minute) => `Every ${n} hours at :${minute}`,
	dailyAt: (time) => `Daily at ${time}`,
	weekdaysAt: (time) => `Weekdays at ${time}`,
	weeklyAt: (day, time) => `${["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"][day]} at ${time}`,
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
