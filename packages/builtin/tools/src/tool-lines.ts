/**
 * 本插件的工具在转录里怎么说（`ui.toolLine`）：对着哪个文件、模型写的说明、跑的命令、查的是哪个后台任务。做的是哪种活在工具定义上
 * （`kind`，见各工具），本体从工具表里读；本体只按这些声明给说法、图标、归类和回复里的文件签，不认工具名；动作的字由本体按种类给，这里只有 monitor 自己说。
 *
 * 参数是模型给的、没校验过，取不出就返回 undefined。单独一个模块、不碰界面：测试直接读这张表。
 */

import type { Locale, SessionWakeup } from "@plume/contract";
import type { ToolField, ToolLine } from "@plume/contract/ui";
import { cronWords } from "./cron-words.ts";
import { MESSAGES, type Plan } from "./messages.ts";

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
/** 模型在参数里写给人看的那句说明：命令、正则、通配人一眼读不出在干什么。 */
const note = (args: Record<string, unknown>) => text(args.description);
/** 对着的文件：`path` 照模型写的样子。 */
const file = (args: Record<string, unknown>) => {
	const path = text(args.path);
	return path === undefined ? undefined : { path };
};

/** 读了哪几行：只给了起点是读到末尾，只给了行数从第 1 行算。模型常把没给的参数写成 null，所以按类型认。 */
function readLines(args: Record<string, unknown>): { from: number; to?: number } | undefined {
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return undefined;
	const from = offset ?? 1;
	return limit === undefined ? { from } : { from, to: from + limit - 1 };
}

/** 一行里点名的那一句：多行的取第一行，太长的截掉。 */
function firstLine(value: unknown): string | undefined {
	const line = text(value)
		?.split("\n")
		.find((one) => one.trim())
		?.trim();
	if (!line) return undefined;
	return [...line].length > 80 ? `${[...line].slice(0, 79).join("")}…` : line;
}

/** 结果里交回的那一个（`wakeups.ts` 的 `details: { kind: "wakeup", wakeup }`，取消的那次带 `cancelled`）；形状不对的不认。 */
function wakeupOf(details: unknown): SessionWakeup | undefined {
	const wakeup = (details as { kind?: unknown; wakeup?: Partial<SessionWakeup> } | undefined)?.wakeup;
	if ((details as { kind?: unknown } | undefined)?.kind !== "wakeup" || !wakeup) return undefined;
	return isWakeup(wakeup) ? wakeup : undefined;
}

function isWakeup(wakeup: Partial<SessionWakeup> | undefined): wakeup is SessionWakeup {
	return typeof wakeup?.id === "string" && typeof wakeup.nextAt === "number" && typeof wakeup.prompt === "string";
}

/** `cron_list` 查到的那几个（`details: { kind: "wakeups", wakeups }`）；不是这个形状是 undefined。 */
function listedOf(details: unknown): SessionWakeup[] | undefined {
	const listed = details as { kind?: unknown; wakeups?: unknown } | undefined;
	if (listed?.kind !== "wakeups" || !Array.isArray(listed.wakeups)) return undefined;
	return listed.wakeups.filter((wakeup: Partial<SessionWakeup>) => isWakeup(wakeup));
}

/** 给人看的那一句：模型写的 `reason`，没写（旧的调用）时是要做的事的第一行。 */
function labelOf(wakeup: SessionWakeup): string | undefined {
	return firstLine(wakeup.reason) ?? firstLine(wakeup.prompt);
}

/** 本地时间，按界面语言：「11月14日 18:05」「Nov 14, 6:05 PM」。 */
function when(ms: number, locale: Locale): string {
	return new Date(ms).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** 行上说的时刻：今天的只说几点几分，别的日子带上日期。 */
function clock(ms: number, locale: Locale): string {
	return new Date(ms).toDateString() === new Date().toDateString()
		? new Date(ms).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
		: when(ms, locale);
}

/** 哪一种：检查（`schedule_wakeup`）、定时任务（只来一次的 cron）、轮询（反复的 cron）。 */
function planOf(wakeup: Pick<SessionWakeup, "kind" | "recurring">): Plan {
	return wakeup.kind === "wakeup" ? "checkIn" : wakeup.recurring ? "loop" : "prompt";
}

/** `cron_create` 约的是哪一种：只看参数（`recurring` 缺省是 true），结果还没回来时也说得出。 */
function cronPlan(args: Record<string, unknown>): Plan {
	return args.recurring === false ? "prompt" : "loop";
}

/** 频率：认得出的说人话、带上原式，认不出的只给原式；只来一次的说一声。 */
function scheduleValue(wakeup: SessionWakeup, locale: Locale): ToolField {
	const words = MESSAGES[locale];
	const cron = wakeup.cron ?? "";
	const human = cronWords(cron, locale);
	const value = human ? `${human} · ${cron}` : cron;
	return { label: words.fieldSchedule, value: wakeup.recurring ? value : words.fieldOnce(value), mono: !human };
}

/**
 * 点开约好的那次调用：什么时候检查（频率、下次运行）、原因、活多久、id、提示词。结果是写给模型读的英文，人要的是这几样。
 * 取消的那次（`cancelled`）只说取消的是哪一个，不再说什么时候、活多久。
 * 有没有被取消不在这里说：那一行由本体按此刻的状态画成停下的（`BackgroundCallState`）。
 */
function wakeupFields(details: unknown, locale: Locale): ToolField[] | undefined {
	const wakeup = wakeupOf(details);
	if (!wakeup) return undefined;
	const cancelled = (details as { cancelled?: unknown }).cancelled === true;
	const words = MESSAGES[locale];
	const rows: ToolField[] = [];
	if (wakeup.kind === "cron" && wakeup.cron) {
		rows.push(scheduleValue(wakeup, locale));
		if (!cancelled) {
			rows.push({ label: words.fieldNextRun, value: when(wakeup.nextAt, locale) });
			if (wakeup.recurring && typeof wakeup.expiresAt === "number") rows.push({ label: words.fieldExpires, value: when(wakeup.expiresAt, locale) });
		}
	} else if (!cancelled) rows.push({ label: words.fieldChecksIn, value: when(wakeup.nextAt, locale) });
	if (wakeup.reason) rows.push({ label: words.fieldReason, value: wakeup.reason });
	if (!cancelled) rows.push({ label: words.fieldLasts, value: words.lastsThisRun });
	rows.push({ label: words.fieldId, value: wakeup.id, mono: true });
	rows.push({ label: words.fieldPrompt, value: wakeup.prompt });
	return rows;
}

/** 点开 `cron_list` 那一行：一项一行，名称是哪一种，值是那一句和下一次的时刻。 */
function listedFields(details: unknown, locale: Locale): ToolField[] | undefined {
	const listed = listedOf(details);
	if (!listed) return undefined;
	const words = MESSAGES[locale];
	return listed.map((wakeup) => ({ label: words.plans[planOf(wakeup)], value: `${labelOf(wakeup) ?? wakeup.id} · ${clock(wakeup.nextAt, locale)}` }));
}

export const TOOL_LINES: Record<string, ToolLine> = {
	read: {
		file: (args) => {
			const path = text(args.path);
			const lines = readLines(args);
			return path === undefined ? undefined : { path, ...(lines ? { lines } : {}) };
		},
	},
	// 没给目录是工作目录。
	ls: { file: (args) => ({ path: text(args.path) ?? "" }) },
	glob: { note },
	grep: { note },
	write: { file },
	edit: { file },
	bash: { note, command: (args) => text(args.command) },
	bash_output: { job: (args) => ({ ...(typeof args.id === "string" ? { id: args.id } : {}), stop: args.kill === true }) },
	/*
	 * monitor 是长跑的命令（`kind: "watch"`）：和 bash 归成「跑命令」一类。还在盯的时候那一行一直是跑着的（本体按任务的状态画），
	 * 所以动作分两态，让人分得清还在盯还是已经停了：「监视中 开发服务器日志」，停了说这次调用做成的事「已开始监视 …」，后面接停下的记号。
	 * 说明不整行替掉动作（不用 `note`）：只读说明分不出这一行是在监视还是跑了一条命令。没写说明时说命令的第一行。
	 */
	monitor: {
		verb: (locale) => MESSAGES[locale].monitorVerb,
		verbFor: ({ live }, locale) => MESSAGES[locale][live ? "monitorNow" : "monitorDone"],
		subject: (args) => firstLine(args.description) ?? firstLine(args.command),
		command: (args) => text(args.command),
	},
	/*
	 * 约好的三种按来几次分开叫：检查（`schedule_wakeup`）、定时任务（只来一次的 `cron_create`）、轮询（反复的）。动作分跑着、做完
	 * （「正在安排检查」「已安排检查」），后面接模型在 `reason` 里写给人看的那句；几次合在一起时数次数。
	 */
	schedule_wakeup: {
		verb: (locale) => MESSAGES[locale].scheduleDone.checkIn,
		verbFor: ({ live }, locale) => MESSAGES[locale][live ? "scheduleNow" : "scheduleDone"].checkIn,
		subject: (args) => firstLine(args.reason),
		fields: (_args, details, locale) => wakeupFields(details, locale),
		times: true,
	},
	cron_create: {
		verb: (locale) => MESSAGES[locale].scheduleDone.prompt,
		verbFor: ({ args, live }, locale) => MESSAGES[locale][live ? "scheduleNow" : "scheduleDone"][cronPlan(args)],
		// 旧的调用没有 `reason`：退回提示词的第一行。
		subject: (args) => firstLine(args.reason) ?? firstLine(args.prompt),
		fields: (_args, details, locale) => wakeupFields(details, locale),
		times: true,
	},
	cron_list: {
		verb: (locale) => MESSAGES[locale].listVerb,
		verbFor: ({ details, live }, locale) => {
			const words = MESSAGES[locale];
			const listed = listedOf(details);
			if (live) return words.listNow;
			if (!listed) return undefined;
			return listed.length === 0 ? words.listNone : words.listed(listed.length);
		},
		fields: (_args, details, locale) => listedFields(details, locale),
	},
	cron_delete: {
		verb: (locale) => MESSAGES[locale].cancelVerb,
		verbFor: ({ details, live }, locale) => {
			const words = MESSAGES[locale];
			const wakeup = wakeupOf(details);
			return live ? words.cancelNow : wakeup ? words.cancelDone[planOf(wakeup)] : undefined;
		},
		// 停掉的是哪一个只有结果里有：有就说那句话，没有（还没回来、id 不对）说 id。
		subject: (args, details) => {
			const wakeup = wakeupOf(details);
			return (wakeup && labelOf(wakeup)) ?? (text(args.id)?.trim() || undefined);
		},
		fields: (_args, details, locale) => wakeupFields(details, locale),
	},
};

/** 约好的那几件：行首画闹钟（界面入口登记时加上，这张表不碰界面）。 */
export const WAKEUP_LINES = ["schedule_wakeup", "cron_create", "cron_list", "cron_delete"];
