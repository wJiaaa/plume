/**
 * 模型给这个会话安排的「以后再接着做」：`schedule_wakeup` 的一次性唤醒、`cron_create` 的定时触发，和 `cron_list`、`cron_delete`。
 *
 * 调度归本体（`ToolRun.schedule`）：到点经后台送达往这个会话送一条消息，闲着开一轮，忙着排到下一个步骤边界；上一次开的那一轮
 * 没做完时跳过；人按停止、删会话、退出应用时取消（人按停是不想再被它叫醒），撤回、编辑重发截掉建它的那次调用时取消它。这里定的是
 * 工具：参数怎么给、几个上限、到点送进去的那段话怎么写（`wakeupMessage`）。每次开一个**新**会话的「定时任务」是另一件事
 * （定时任务插件，存在磁盘上）。子会话没有送达渠道，这几件工具不列给它们（见 `index.ts`）。
 *
 * 几个数和它们的理由：
 *
 * - 最短 60 秒：cron 的粒度本来就是一分钟（本体也只在一分钟以后找 cron 的第一次）；再短就是在一轮里轮询，那该用 `bash` 的后台任务。
 * - 一次性唤醒最长 24 小时：再远的事多半是「以后每天都跑」，该去定时任务页建，那边重启也还在。
 * - 循环任务 3 天后过期：任务只在内存里，应用一开就是好几天，忘了删的 `*\/5` 每五分钟开一轮、每轮重发整段前缀，
 *   一夜就是上百次请求。3 天够盯一个跨周末的发布；更久的去定时任务页。
 * - 每个会话最多 10 个：一个对话同时要盯的事很少超过两三件，十个已经是失控的信号。
 *
 * 说明写给模型，用英文，和别的工具一致；到点送进去的那条消息是运行时送达，不是人说的话。
 */

import type { DeliveryInput, SessionWakeup, WakeupInput } from "@plume/contract";
import type { DeliveryDetails } from "../delivery.ts";
import { errorResult } from "./result.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";

const WAKEUP_MIN_SECONDS = 60;
const WAKEUP_MAX_SECONDS = 24 * 60 * 60;
const CRON_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
export const MAX_WAKEUPS = 10;
/** 一段续做的说明装得下；再长就是把一份记录贴进了提醒里。 */
const PROMPT_MAX = 4000;
const REASON_MAX = 200;
const DAYS = CRON_MAX_AGE_MS / (24 * 60 * 60_000);

/** 本地时间，带时区偏移：`2026-10-23 14:05 (UTC+08:00)`。模型据此和用户说「两点零五分」时不必换算。 */
function localTime(ms: number): string {
	const date = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const zone = `UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} (${zone})`;
}

/** 给人看的那一句：唤醒写了理由用理由，否则是 prompt 的第一行。 */
function wakeupLabel(wakeup: Pick<SessionWakeup, "reason" | "prompt">): string {
	const line = wakeup.reason?.trim() || (wakeup.prompt.split("\n").find((one) => one.trim()) ?? "").trim();
	return [...line].length > 80 ? `${[...line].slice(0, 79).join("")}…` : line;
}

/**
 * 到点时送进会话的那条消息。要说清三件事：它不是人说的话，是模型自己留的；是哪一个任务；还会不会再来。最后一件最要紧——
 * 模型不知道这是最后一次，就会接着等一个不会再来的唤醒；不知道还会再来，就会自己再排一个，一件事被盯两遍。
 * `next` 是下一次触发，null 表示这是最后一次；`skipped` 是上一次送达之后因为那一轮还没结束而跳过的次数。
 */
export function wakeupMessage(wakeup: SessionWakeup, info: { next: number | null; skipped: number }): { text: string; delivery: DeliveryInput } {
	// i18n-exempt：送给模型的运行时消息。
	const lead =
		wakeup.kind === "wakeup"
			? `（运行时送达）你之前用 schedule_wakeup 安排的唤醒到点了（id="${wakeup.id}"${wakeup.reason ? `，理由：${wakeup.reason}` : ""}）。`
			: `（运行时送达）你之前用 cron_create 建的定时任务到点了（id="${wakeup.id}"，cron="${wakeup.cron}"${wakeup.recurring ? `，第 ${wakeup.fired} 次触发` : ""}）。`;
	// i18n-exempt：送给模型的运行时消息。
	const own = "它不是用户说的话，是你自己留下的：照下面的内容接着做，做完照常回复用户。";
	// i18n-exempt：送给模型的运行时消息。
	const skipped = info.skipped > 0 ? `上一次触发开的那一轮还没结束时它又到点了 ${info.skipped} 次，那几次跳过了。` : "";
	// i18n-exempt：送给模型的运行时消息。
	const after = !wakeup.recurring
		? wakeup.kind === "wakeup"
			? "这是一次性的，之后不会再唤醒你；还要再等，就再调用一次 schedule_wakeup。"
			: "这是一次性的（recurring: false），触发这一次后已经删掉。"
		: info.next === null
			? "这是它过期前的最后一次触发，之后不会再唤醒你。事情还没办完的话，告诉用户，或者用 cron_create 重新建一个。"
			: `下一次在 ${localTime(info.next)}；它在 ${localTime(wakeup.expiresAt ?? info.next)} 过期，之后不再触发。要等的事办完了就用 cron_delete 删掉它，不要让它空转。`;
	return {
		text: `${[lead, own, skipped, after].filter(Boolean).join("")}\n\n<wakeup id="${wakeup.id}">\n${wakeup.prompt}\n</wakeup>`,
		delivery: {
			id: wakeup.id,
			title: wakeupLabel(wakeup),
			status: "done",
			details: { kind: "wakeup", ...(wakeup.cron ? { cron: wakeup.cron } : {}) } satisfies DeliveryDetails,
		},
	};
}

function text(value: unknown, name: string, max: number): string | { error: string } {
	if (typeof value !== "string" || !value.trim()) return { error: `${name} is required and must be non-empty text.` };
	const trimmed = value.trim();
	const length = [...trimmed].length;
	if (length > max) return { error: `${name} is ${length} characters; keep it to ${max}.` };
	return trimmed;
}

/** 一行，给模型读：id、什么时候、循环与否、过期。 */
function describe(wakeup: SessionWakeup): string {
	const when = wakeup.kind === "cron" ? `cron "${wakeup.cron}"${wakeup.recurring ? "" : ", once"}` : "one-time wakeup";
	const expiry = wakeup.expiresAt !== undefined ? `, expires ${localTime(wakeup.expiresAt)}` : "";
	const label = wakeup.reason ?? wakeup.prompt.split("\n")[0] ?? "";
	return `${wakeup.id}: ${when}, next ${localTime(wakeup.nextAt)}${expiry}${wakeup.fired ? `, fired ${wakeup.fired}x` : ""} — ${label}`;
}

function attempt(run: () => ToolResult): ToolResult {
	try {
		return run();
	} catch (error) {
		return errorResult(error instanceof Error ? error.message : String(error));
	}
}

/** 送达渠道在才有「以后」（`ToolRun.schedule` 只有顶层会话有）：子会话、直接调工具的测试没有。 */
function scheduleOf(ctx: ToolContext): ((wake: WakeupInput) => SessionWakeup | undefined) | { error: string } {
	return ctx.schedule ?? { error: "Only the conversation itself can schedule wakeups; nothing here would receive them." };
}

function roomForOneMore(ctx: ToolContext): void {
	if ((ctx.wakeups?.list().length ?? 0) >= MAX_WAKEUPS) {
		throw new Error(`This conversation already has ${MAX_WAKEUPS} pending wakeups and cron jobs. Delete one you no longer need with cron_delete first.`);
	}
}

/*
 * 四件的说明每个请求都带着，所以只写模型决定「用不用、怎么用」要的话，每件事只在一处说：到点怎么送、活多久写在 `schedule_wakeup`，
 * `cron_create` 说「同上」，和定时任务页的分别写在 `cron_create`——要「每天早上」的模型找的是它。跳过、上限、过期这些调用之后才用得上的，
 * 由工具结果和报错去说。
 */
export const scheduleWakeupTool: Tool<{ delay_seconds?: unknown; prompt?: unknown; reason?: unknown }> = {
	name: "schedule_wakeup",
	description:
		'Come back to this conversation once, after a delay ("check the CI result in 10 minutes"). ' +
		"When it fires, a message arrives here and you carry on from it; nothing runs before then, so end this turn normally. " +
		"Not needed for a background command or sub-agent: those already report back when done. " +
		"Each wakeup costs a turn, so wait as long as the thing takes — 300-600 seconds for CI or a deploy. " +
		"It lives in this conversation only: cancelled by Stop, gone if the app quits.",
	parameters: {
		type: "object",
		properties: {
			delay_seconds: { type: "number", description: `Seconds from now, ${WAKEUP_MIN_SECONDS} to ${WAKEUP_MAX_SECONDS}.` },
			prompt: { type: "string", description: "What to do when it fires, written to yourself: what to check and what to do with the answer." },
			reason: { type: "string", description: 'A few words shown to the person ("waiting for CI on PR 482").' },
		},
		required: ["delay_seconds", "prompt", "reason"],
		additionalProperties: false,
	},
	execute: async (args, ctx) =>
		attempt(() => {
			const schedule = scheduleOf(ctx);
			if ("error" in schedule) return errorResult(schedule.error);
			const prompt = text(args.prompt, "prompt", PROMPT_MAX);
			if (typeof prompt !== "string") return errorResult(prompt.error);
			const reason = text(args.reason, "reason", REASON_MAX);
			if (typeof reason !== "string") return errorResult(reason.error);
			const delaySeconds = args.delay_seconds;
			if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds)) return errorResult("delay_seconds must be a number of seconds.");
			if (delaySeconds > WAKEUP_MAX_SECONDS) {
				// i18n-exempt：给模型看的报错，点名产品里那一页的中文名，模型据此转告人。
				return errorResult(
					`delay_seconds is at most ${WAKEUP_MAX_SECONDS} (24 hours). For something further off or on a lasting schedule, tell the person to create it on the app's Scheduled page (定时任务) instead.`,
				);
			}
			roomForOneMore(ctx);
			// 短于下限的抬到下限（结果里会说），长于上限的上面已经拒了：那多半是该去定时任务页的事。
			const seconds = Math.max(WAKEUP_MIN_SECONDS, Math.round(delaySeconds));
			const clamped = seconds !== Math.round(delaySeconds);
			const wakeup = schedule({ at: Date.now() + seconds * 1000, prompt, reason, message: wakeupMessage });
			if (!wakeup) return errorResult("The wakeup could not be scheduled.");
			return {
				content: [
					{
						type: "text",
						text:
							`Scheduled ${wakeup.id} for ${localTime(wakeup.nextAt)}${clamped ? ` (raised to the ${WAKEUP_MIN_SECONDS}-second minimum)` : ""}. ` +
							"Nothing runs until then; finish this turn normally. It is cancelled if the person presses Stop, and gone if the app quits. Cancel it with cron_delete.",
					},
				],
				details: { kind: "wakeup", wakeup },
			};
		}),
};

const cronCreateTool: Tool<{ cron?: unknown; prompt?: unknown; recurring?: unknown }> = {
	name: "cron_create",
	// i18n-exempt：给模型看的工具说明，点名产品里那一页的中文名。
	description:
		'Like schedule_wakeup, but on a schedule ("check the deploy every 5 minutes until it is done", "at 14:30 today"). ' +
		'5-field cron in local time: "*/5 * * * *", "30 14 * * *", "0 9 * * 1-5". ' +
		`Recurring jobs expire after ${DAYS} days. Each firing costs a turn: pick the longest interval that works, and delete the job with cron_delete once it is settled. ` +
		'Not the app\'s Scheduled page (定时任务): for something that should keep running on its own ("every morning"), tell the person to create it there.',
	parameters: {
		type: "object",
		properties: {
			cron: { type: "string", description: "5-field cron expression in local time." },
			prompt: { type: "string", description: "What to do each time it fires, written to yourself, including when to stop." },
			recurring: { type: "boolean", description: "Default true; false fires once at the next match." },
		},
		required: ["cron", "prompt"],
		additionalProperties: false,
	},
	execute: async (args, ctx) =>
		attempt(() => {
			const schedule = scheduleOf(ctx);
			if ("error" in schedule) return errorResult(schedule.error);
			if (typeof args.cron !== "string" || !args.cron.trim()) return errorResult("cron is required: a 5-field cron expression.");
			const prompt = text(args.prompt, "prompt", PROMPT_MAX);
			if (typeof prompt !== "string") return errorResult(prompt.error);
			if (args.recurring !== undefined && typeof args.recurring !== "boolean") return errorResult("recurring must be true or false.");
			roomForOneMore(ctx);
			// 第一次要落在过期之前（本体只在一分钟以后找）：永远等不到的任务不收。一次性的也只在这 3 天里找。
			const made = schedule({ cron: args.cron, recurring: args.recurring !== false, expiresAt: Date.now() + CRON_MAX_AGE_MS, prompt, message: wakeupMessage });
			if (!made) {
				const source = args.cron.trim().split(/\s+/).join(" ");
				// i18n-exempt：给模型看的报错，点名产品里那一页的中文名，模型据此转告人。
				return errorResult(
					`"${source}" does not match any time between one minute and 3 days from now. Jobs here live at most 3 days; for a lasting schedule, tell the person to create it on the app's Scheduled page (定时任务) instead.`,
				);
			}
			const tail = made.recurring
				? `It repeats until ${localTime(made.expiresAt ?? made.nextAt)}, when it expires; a firing that comes while the turn of the previous one is still running is skipped.`
				: "It fires once, then is deleted.";
			return {
				content: [
					{
						type: "text",
						text: `Created ${made.id}. Next firing: ${localTime(made.nextAt)}. ${tail} Nothing runs until then; finish this turn normally. Cancel it with cron_delete.`,
					},
				],
				details: { kind: "wakeup", wakeup: made },
			};
		}),
};

export const cronListTool: Tool = {
	name: "cron_list",
	description: "List this conversation's pending wakeups and cron jobs, with ids and next firing times.",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	execute: async (_args, ctx) => {
		const all = ctx.wakeups?.list() ?? [];
		return { content: [{ type: "text", text: all.length === 0 ? "No pending wakeups or cron jobs in this conversation." : all.map(describe).join("\n") }] };
	},
};

const cronDeleteTool: Tool<{ id?: unknown }> = {
	name: "cron_delete",
	description: "Cancel a pending wakeup or cron job by id.",
	parameters: {
		type: "object",
		properties: { id: { type: "string", description: 'The id, e.g. "cron-2".' } },
		required: ["id"],
		additionalProperties: false,
	},
	execute: async (args, ctx) => {
		if (typeof args.id !== "string" || !args.id.trim()) return errorResult("id is required.");
		const id = args.id.trim();
		if (!ctx.wakeups?.cancel(id))
			return errorResult(`No pending wakeup or cron job "${id}" in this conversation; it may have fired already. cron_list shows what is pending.`);
		return { content: [{ type: "text", text: `Cancelled ${id}.` }] };
	},
};

/** 只给顶层会话的几件：子会话没有送达渠道，到点的消息没人接。 */
export const WAKEUP_TOOLS = [scheduleWakeupTool, cronCreateTool, cronListTool, cronDeleteTool] as Tool[];
