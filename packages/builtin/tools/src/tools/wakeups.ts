/**
 * 模型给这个会话安排的「以后再接着做」：`schedule_wakeup` 的一次性唤醒、`cron_create` 的定时触发，和 `cron_list`、`cron_delete`。
 *
 * 到点后经后台送达（`ToolRun.background`）往这个会话送一条消息：闲着开一轮，忙着排到下一个步骤边界。每次开一个**新**会话的
 * 「定时任务」是另一件事（定时任务插件，存在磁盘上）；这里只活在内存里，送达渠道作废（人按停止、删会话）或退出应用就都没了
 * ——人按停是不想再被它叫醒。撤回、编辑重发只作废截掉的那段里建它的那次调用的渠道，那段里建的跟着取消，留下那段里建的照常到点。
 * 子会话没有送达渠道，这几件工具不列给它们（见 `index.ts`）。
 *
 * 几个数和它们的理由：
 *
 * - 最短 60 秒：cron 的粒度本来就是一分钟；再短就是在一轮里轮询，那该用 `bash` 的后台任务。
 * - 一次性唤醒最长 24 小时：再远的事多半是「以后每天都跑」，该去定时任务页建，那边重启也还在。
 * - 循环任务 3 天后过期：任务只在内存里，应用一开就是好几天，忘了删的 `*\/5` 每五分钟开一轮、每轮重发整段前缀，
 *   一夜就是上百次请求。3 天够盯一个跨周末的发布；更久的去定时任务页。
 * - 每个会话最多 10 个：一个对话同时要盯的事很少超过两三件，十个已经是失控的信号。
 *
 * 说明写给模型，用英文，和别的工具一致；到点送进去的那条消息是运行时送达，不是人说的话。
 */

import type { BackgroundChannel, ChannelDelivery, SessionWakeup } from "@plume/contract";
import { nextCronTime, parseCron, type CronSchedule } from "./cron.ts";
import { errorResult } from "./result.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";

const WAKEUP_MIN_SECONDS = 60;
const WAKEUP_MAX_SECONDS = 24 * 60 * 60;
export const CRON_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
export const MAX_WAKEUPS = 10;
/** 一段续做的说明装得下；再长就是把一份记录贴进了提醒里。 */
const PROMPT_MAX = 4000;
const REASON_MAX = 200;
const DAYS = CRON_MAX_AGE_MS / (24 * 60 * 60_000);

/**
 * 计时器最长隔多久醒一次，醒了按墙上时间重新看。
 *
 * 不直接睡到触发时刻：Node 的计时器走单调时钟，macOS 合盖睡眠时它不走，一个十分钟的唤醒醒来后要再等十分钟。
 * 一分钟一看，开盖之后最多晚一分钟。
 */
const TICK_MS = 60_000;

export interface WakeupClock {
	now(): number;
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realClock: WakeupClock = {
	now: () => Date.now(),
	setTimeout: (run, ms) => {
		const handle = setTimeout(run, ms);
		// 待触发的唤醒不该把一个本来要退出的进程拖住。
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Entry {
	wakeup: SessionWakeup;
	schedule?: CronSchedule;
	/** 建它的那次调用的送达渠道：渠道作废（人按停止，或撤回截掉了那次调用）时跟着取消。 */
	channel: BackgroundChannel;
	/**
	 * 上一次触发送进去的消息走到哪了：`queued` 排着还没送进会话，`running` 送进去开的那一轮在跑。
	 * 不是 null 时再到点就跳过、记一笔：模型还没看完上一次，再排一条进去只会在它后面接成一串，每一条都重发整段前缀，说的却是同一件事。
	 */
	phase: "queued" | "running" | null;
	skipped: number;
}

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
function wakeupMessage(wakeup: SessionWakeup, info: { next: number | null; skipped: number }): { text: string; delivery: ChannelDelivery } {
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
		delivery: { id: wakeup.id, kind: "wakeup", agent: "", description: wakeupLabel(wakeup), status: "done", ...(wakeup.cron ? { command: wakeup.cron } : {}) },
	};
}

/** 一个会话的唤醒表。只要一个时钟；送达走建唤醒时的那一代渠道。 */
export class SessionWakeups {
	private readonly entries = new Map<string, Entry>();
	private readonly clock: WakeupClock;
	private timer: unknown = null;
	private counter = 0;

	constructor(clock: WakeupClock = realClock) {
		this.clock = clock;
	}

	/** 一次性唤醒。短于下限的抬到下限（结果里会说），长于上限的拒绝：那多半是该去定时任务页的事。 */
	wakeup(channel: BackgroundChannel, delaySeconds: number, prompt: string, reason?: string): { wakeup: SessionWakeup; clamped: boolean } {
		if (!Number.isFinite(delaySeconds)) throw new Error("delay_seconds must be a number of seconds.");
		if (delaySeconds > WAKEUP_MAX_SECONDS) {
			// i18n-exempt：给模型看的报错，点名产品里那一页的中文名，模型据此转告人。
			throw new Error(
				`delay_seconds is at most ${WAKEUP_MAX_SECONDS} (24 hours). For something further off or on a lasting schedule, tell the person to create it on the app's Scheduled page (定时任务) instead.`,
			);
		}
		this.roomForOneMore();
		const seconds = Math.max(WAKEUP_MIN_SECONDS, Math.round(delaySeconds));
		const now = this.clock.now();
		const wakeup: SessionWakeup = {
			id: this.nextId("wake"),
			kind: "wakeup",
			prompt,
			...(reason ? { reason } : {}),
			recurring: false,
			createdAt: now,
			nextAt: now + seconds * 1000,
			fired: 0,
		};
		this.add({ wakeup, channel, phase: null, skipped: 0 });
		return { wakeup: { ...wakeup }, clamped: seconds !== Math.round(delaySeconds) };
	}

	/** cron 任务。第一次至少在 60 秒之后，而且要落在过期之前——永远等不到的任务不收。 */
	cron(channel: BackgroundChannel, expression: string, prompt: string, recurring: boolean): SessionWakeup {
		const schedule = parseCron(expression);
		this.roomForOneMore();
		const now = this.clock.now();
		const horizon = now + CRON_MAX_AGE_MS;
		// 严格晚于 now + 59.999s 的第一个整分钟，也就是不早于 60 秒之后。
		const first = nextCronTime(schedule, now + WAKEUP_MIN_SECONDS * 1000 - 1, horizon);
		if (first === null) {
			// i18n-exempt：给模型看的报错，点名产品里那一页的中文名，模型据此转告人。
			throw new Error(
				`"${schedule.source}" does not match any time between one minute and 3 days from now. Jobs here live at most 3 days; for a lasting schedule, tell the person to create it on the app's Scheduled page (定时任务) instead.`,
			);
		}
		const wakeup: SessionWakeup = {
			id: this.nextId("cron"),
			kind: "cron",
			prompt,
			cron: schedule.source,
			recurring,
			createdAt: now,
			nextAt: first,
			...(recurring ? { expiresAt: horizon } : {}),
			fired: 0,
		};
		this.add({ wakeup, schedule, channel, phase: null, skipped: 0 });
		return { ...wakeup };
	}

	/** 按下一次触发的先后。 */
	list(): SessionWakeup[] {
		return [...this.entries.values()].map((entry) => ({ ...entry.wakeup })).sort((a, b) => a.nextAt - b.nextAt);
	}

	cancel(id: string): boolean {
		if (!this.entries.delete(id)) return false;
		this.arm();
		return true;
	}

	/** 人按了停：全部取消，交回取消了几个，好跟人说一声。 */
	cancelAll(): number {
		const count = this.entries.size;
		this.dispose();
		return count;
	}

	/** 全部取消（会话没了、插件停用）。 */
	dispose(): void {
		this.entries.clear();
		this.arm();
	}

	/** 会话的一轮收场了：送进去的那次触发开的那一轮就是它，之后再到点照常送。 */
	turnEnded(): void {
		for (const entry of this.entries.values()) if (entry.phase === "running") entry.phase = null;
	}

	private roomForOneMore(): void {
		if (this.entries.size >= MAX_WAKEUPS) {
			throw new Error(`This conversation already has ${MAX_WAKEUPS} pending wakeups and cron jobs. Delete one you no longer need with cron_delete first.`);
		}
	}

	private nextId(prefix: string): string {
		this.counter += 1;
		return `${prefix}-${this.counter}`;
	}

	private add(entry: Entry): void {
		this.entries.set(entry.wakeup.id, entry);
		/*
		 * 渠道作废就跟着取消：停下以后、建它的那次调用被撤回以后，它不该再叫醒会话。监听随条目一起登记。
		 * 晚一个微任务再取消：人按停时宿主先作废渠道、再同步通知停止，停止那一头（`cancelAll`）要先数到这几个、跟人说一声；
		 * 撤回不通知停止，到这里悄悄取消。中间隔的只是同一段同步代码，计时器插不进来，作废的渠道也送不出东西。
		 */
		entry.channel.signal.addEventListener(
			"abort",
			() =>
				queueMicrotask(() => {
					if (this.entries.get(entry.wakeup.id) === entry) this.cancel(entry.wakeup.id);
				}),
			{ once: true },
		);
		this.arm();
	}

	private arm(): void {
		if (this.timer !== null) this.clock.clearTimeout(this.timer);
		this.timer = null;
		let earliest = Infinity;
		for (const entry of this.entries.values()) earliest = Math.min(earliest, entry.wakeup.nextAt);
		if (earliest === Infinity) return;
		const wait = Math.min(TICK_MS, Math.max(0, earliest - this.clock.now()));
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			this.tick();
		}, wait);
	}

	private tick(): void {
		const now = this.clock.now();
		const due = [...this.entries.values()].filter((entry) => entry.wakeup.nextAt <= now).sort((a, b) => a.wakeup.nextAt - b.wakeup.nextAt);
		for (const entry of due) this.fire(entry, now);
		this.arm();
	}

	/** 送一次；没送进去（渠道已作废）就当没触发过，这一项也就跟着渠道取消了。 */
	private send(entry: Entry, next: number | null, skipped: number): void {
		const { text, delivery } = wakeupMessage(entry.wakeup, { next, skipped });
		entry.phase = "queued";
		const sent = entry.channel.report(() => {
			// 送进会话的那一刻：这一轮是它开的（或接在它后面），这一轮收场前再到点就跳过。
			entry.phase = "running";
			return text;
		}, delivery);
		if (!sent) entry.phase = null;
	}

	private fire(entry: Entry, now: number): void {
		const { wakeup } = entry;
		if (!wakeup.recurring || !entry.schedule) {
			this.entries.delete(wakeup.id);
			wakeup.fired += 1;
			this.send(entry, null, 0);
			return;
		}
		const expiresAt = wakeup.expiresAt ?? now;
		// 电脑睡过了过期时刻才醒：过期了就是过期了，不为一件早该结束的事再开一轮。
		if (now > expiresAt + TICK_MS) {
			this.entries.delete(wakeup.id);
			return;
		}
		const next = nextCronTime(entry.schedule, now, expiresAt);
		if (next === null) this.entries.delete(wakeup.id);
		else wakeup.nextAt = next;
		// 上一次开的那一轮还没完：这次跳过。最后一次被跳过时模型听不到「这是最后一次」，但之前每一次送达都写着过期时刻。
		if (entry.phase !== null) {
			entry.skipped += 1;
			return;
		}
		wakeup.fired += 1;
		const skipped = entry.skipped;
		entry.skipped = 0;
		this.send(entry, next, skipped);
	}
}

const KEY = "wakeups";

/** 会话状态里的唤醒表，没有就建一张。 */
function sessionWakeups(state: Map<string, unknown>): SessionWakeups {
	const current = state.get(KEY);
	if (current instanceof SessionWakeups) return current;
	const table = new SessionWakeups();
	state.set(KEY, table);
	return table;
}

/** 已有的唤醒表；没安排过时不建。 */
export function existingWakeups(state: Map<string, unknown> | undefined): SessionWakeups | undefined {
	const current = state?.get(KEY);
	return current instanceof SessionWakeups ? current : undefined;
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

/** 送达渠道在才有「以后」：子会话、直接调工具的测试没有。 */
function channelOf(ctx: ToolContext): BackgroundChannel | { error: string } {
	return ctx.background?.() ?? { error: "Only the conversation itself can schedule wakeups; nothing here would receive them." };
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
			const channel = channelOf(ctx);
			if ("error" in channel) return errorResult(channel.error);
			const prompt = text(args.prompt, "prompt", PROMPT_MAX);
			if (typeof prompt !== "string") return errorResult(prompt.error);
			const reason = text(args.reason, "reason", REASON_MAX);
			if (typeof reason !== "string") return errorResult(reason.error);
			if (typeof args.delay_seconds !== "number") return errorResult("delay_seconds must be a number of seconds.");
			const { wakeup, clamped } = sessionWakeups(ctx.state).wakeup(channel, args.delay_seconds, prompt, reason);
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
			const channel = channelOf(ctx);
			if ("error" in channel) return errorResult(channel.error);
			if (typeof args.cron !== "string" || !args.cron.trim()) return errorResult("cron is required: a 5-field cron expression.");
			const prompt = text(args.prompt, "prompt", PROMPT_MAX);
			if (typeof prompt !== "string") return errorResult(prompt.error);
			if (args.recurring !== undefined && typeof args.recurring !== "boolean") return errorResult("recurring must be true or false.");
			const made = sessionWakeups(ctx.state).cron(channel, args.cron, prompt, args.recurring !== false);
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
		const all = existingWakeups(ctx.state)?.list() ?? [];
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
		if (!existingWakeups(ctx.state)?.cancel(id))
			return errorResult(`No pending wakeup or cron job "${id}" in this conversation; it may have fired already. cron_list shows what is pending.`);
		return { content: [{ type: "text", text: `Cancelled ${id}.` }] };
	},
};

/** 只给顶层会话的几件：子会话没有送达渠道，到点的消息没人接。 */
export const WAKEUP_TOOLS = [scheduleWakeupTool, cronCreateTool, cronListTool, cronDeleteTool] as Tool[];
