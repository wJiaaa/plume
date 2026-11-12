/**
 * 会话里约好的「以后再接着做」（`ToolRun.schedule`）：一次性的到某个时刻送一次，cron 的按表达式送一次或一直送到过期。
 *
 * 到点经约它的那次调用的送达渠道（`BackgroundRuns.channel`）往会话送一条运行时送达：闲着开一轮，忙着排到下一个步骤边界；
 * 那一行记在约它的插件名下，送进去的话由那个插件给（`WakeupInput.message`），本体只管什么时候送、送不送。只活在内存里：
 * 人按停（`cancelSession`，按停是不想再被它叫醒）、撤回或编辑重发截掉约它的那次调用（`cancelCalls`）、删会话（`forget`）、
 * 约它的插件停用（`cancelOwner`）、退出应用（`clear`）都取消。还有没触发的，会话就不算闲（`pending`）。
 *
 * 每次开一个**新**会话的「定时任务」是另一件事，那是插件的，存在磁盘上。
 */

import type { BackgroundChannel, SessionWakeup, WakeupInput } from "@plume/contract";
import { type CronSchedule, nextCronTime, parseCron } from "./cron.ts";
import { text } from "./i18n.ts";

/** cron 的第一次至少在这么久以后：cron 的粒度是一分钟，再早的那一次多半已经来不及。 */
const CRON_FIRST_MIN_MS = 60_000;

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
	sessionId: string;
	/** 约它的插件：到点那一行记在它名下，它停用时跟着取消。 */
	plugin: string;
	/** 约它的那次调用：撤回截掉它时跟着取消。 */
	toolCallId: string;
	wakeup: SessionWakeup;
	schedule?: CronSchedule;
	channel: BackgroundChannel;
	message: WakeupInput["message"];
	/**
	 * 上一次触发送进去的消息走到哪了：`queued` 排着还没送进会话，`running` 送进去开的那一轮在跑。
	 * 不是 null 时再到点就跳过、记一笔：模型还没看完上一次，再排一条进去只会在它后面接成一串，每一条都重发整段前缀，说的却是同一件事。
	 */
	phase: "queued" | "running" | null;
	skipped: number;
}

export class SessionWakeups {
	/** 会话 → 唤醒 id → 条目。 */
	private readonly sessions = new Map<string, Map<string, Entry>>();
	/** 每个会话的编号接着往下数，取消了也不回头：模型手里的旧 id 不会指到新的那一个。 */
	private readonly counters = new Map<string, number>();
	private timer: unknown = null;

	/** `changed`：某个会话待触发的唤醒变了（加、取消、最后一次触发），`pending` 可能变了。 */
	constructor(
		private readonly changed: (sessionId: string) => void,
		private readonly log: (message: string) => void,
		private readonly clock: WakeupClock = realClock,
	) {}

	/** 约一次，见 `ToolRun.schedule`。cron 写错时抛错；在过期之前一次也对不上时不登记，返回 undefined。 */
	schedule(sessionId: string, plugin: string, toolCallId: string, channel: BackgroundChannel, input: WakeupInput): SessionWakeup | undefined {
		const { at, cron, prompt, reason, expiresAt, message } = input ?? ({} as Partial<WakeupInput>);
		if ((at === undefined) === (cron === undefined) || typeof prompt !== "string" || typeof message !== "function") throw new Error(text("session.badWakeup"));
		if (expiresAt !== undefined && !Number.isFinite(expiresAt)) throw new Error(text("session.badWakeup"));
		const now = this.clock.now();
		const base = { prompt, ...(typeof reason === "string" && reason ? { reason } : {}), createdAt: now, fired: 0 };
		if (at !== undefined) {
			if (typeof at !== "number" || !Number.isFinite(at)) throw new Error(text("session.badWakeup"));
			const wakeup: SessionWakeup = { id: this.nextId(sessionId, "wake"), kind: "wakeup", ...base, recurring: false, nextAt: at };
			return this.add({ sessionId, plugin, toolCallId, wakeup, channel, message, phase: null, skipped: 0 });
		}
		if (typeof cron !== "string") throw new Error(text("session.badWakeup"));
		const schedule = parseCron(cron);
		const recurring = input.recurring === true;
		// 严格晚于 now + 59.999s 的第一个整分钟，也就是不早于一分钟之后。
		const first = nextCronTime(schedule, now + CRON_FIRST_MIN_MS - 1, expiresAt);
		if (first === null) return undefined;
		const wakeup: SessionWakeup = {
			id: this.nextId(sessionId, "cron"),
			kind: "cron",
			...base,
			cron: schedule.source,
			recurring,
			nextAt: first,
			...(recurring && expiresAt !== undefined ? { expiresAt } : {}),
		};
		return this.add({ sessionId, plugin, toolCallId, wakeup, schedule, channel, message, phase: null, skipped: 0 });
	}

	/** 按下一次触发的先后。 */
	list(sessionId: string): SessionWakeup[] {
		return [...(this.sessions.get(sessionId)?.values() ?? [])].map((entry) => ({ ...entry.wakeup })).sort((a, b) => a.nextAt - b.nextAt);
	}

	/** 还有没触发的：会话不算闲。 */
	pending(sessionId: string): boolean {
		return (this.sessions.get(sessionId)?.size ?? 0) > 0;
	}

	cancel(sessionId: string, id: string): boolean {
		if (!this.sessions.get(sessionId)?.delete(String(id))) return false;
		this.settle(sessionId);
		return true;
	}

	/** 人按了停：这个会话的全部取消，交回取消了几个，好跟人说一声。 */
	cancelSession(sessionId: string): number {
		const count = this.sessions.get(sessionId)?.size ?? 0;
		if (count === 0) return 0;
		this.sessions.delete(sessionId);
		this.settle(sessionId);
		return count;
	}

	/** 撤回、编辑重发：截掉的那段里这几次调用约的取消，留下那段里约的照常到点。 */
	cancelCalls(sessionId: string, toolCallIds: Iterable<string>): void {
		const entries = this.sessions.get(sessionId);
		if (!entries) return;
		const cut = new Set(toolCallIds);
		let changed = false;
		for (const [id, entry] of entries)
			if (cut.has(entry.toolCallId)) {
				entries.delete(id);
				changed = true;
			}
		if (changed) this.settle(sessionId);
	}

	/** 约它们的插件停用了：到点要它给的话，它已经不在了。 */
	cancelOwner(plugin: string): void {
		for (const [sessionId, entries] of this.sessions) {
			let changed = false;
			for (const [id, entry] of entries)
				if (entry.plugin === plugin) {
					entries.delete(id);
					changed = true;
				}
			if (changed) this.settle(sessionId);
		}
	}

	/** 会话删掉了：取消它的，编号也不再留。 */
	forget(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.counters.delete(sessionId);
		this.arm();
	}

	/** 退出应用：全部取消。 */
	clear(): void {
		this.sessions.clear();
		this.arm();
	}

	/** 会话的一轮收场了：送进去的那次触发开的那一轮就是它，之后再到点照常送。 */
	turnEnded(sessionId: string): void {
		for (const entry of this.sessions.get(sessionId)?.values() ?? []) if (entry.phase === "running") entry.phase = null;
	}

	private nextId(sessionId: string, prefix: string): string {
		const next = (this.counters.get(sessionId) ?? 0) + 1;
		this.counters.set(sessionId, next);
		return `${prefix}-${next}`;
	}

	private add(entry: Entry): SessionWakeup {
		let entries = this.sessions.get(entry.sessionId);
		if (!entries) this.sessions.set(entry.sessionId, (entries = new Map()));
		entries.set(entry.wakeup.id, entry);
		this.settle(entry.sessionId);
		return { ...entry.wakeup };
	}

	/** 某个会话的表变了：空了就拿掉，重新定时，告诉会话。 */
	private settle(sessionId: string): void {
		if (this.sessions.get(sessionId)?.size === 0) this.sessions.delete(sessionId);
		this.arm();
		this.changed(sessionId);
	}

	private *entries(): Iterable<Entry> {
		for (const entries of this.sessions.values()) yield* entries.values();
	}

	private arm(): void {
		if (this.timer !== null) this.clock.clearTimeout(this.timer);
		this.timer = null;
		let earliest = Infinity;
		for (const entry of this.entries()) earliest = Math.min(earliest, entry.wakeup.nextAt);
		if (earliest === Infinity) return;
		const wait = Math.min(TICK_MS, Math.max(0, earliest - this.clock.now()));
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			this.tick();
		}, wait);
	}

	private tick(): void {
		const now = this.clock.now();
		const due = [...this.entries()].filter((entry) => entry.wakeup.nextAt <= now).sort((a, b) => a.wakeup.nextAt - b.wakeup.nextAt);
		const touched = new Set<string>();
		for (const entry of due) if (this.fire(entry, now)) touched.add(entry.sessionId);
		// 最后一次送出去（攒进了送达）之后再告诉会话：中间没有一刻是「什么都不剩」。
		for (const sessionId of touched) this.settle(sessionId);
		this.arm();
	}

	/** 送一次；没送进去（渠道已作废、插件给不出话）就当没触发过。 */
	private send(entry: Entry, next: number | null, skipped: number): void {
		let message: ReturnType<WakeupInput["message"]>;
		try {
			message = entry.message({ ...entry.wakeup }, { next, skipped });
		} catch (error) {
			this.log(`唤醒 ${entry.wakeup.id} 到点了，插件 ${entry.plugin} 没给出要送的话：${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const words = message?.text;
		if (typeof words !== "string" || !words.trim()) return;
		entry.phase = "queued";
		const sent = entry.channel.report(() => {
			// 送进会话的那一刻：这一轮是它开的（或接在它后面），这一轮收场前再到点就跳过。
			entry.phase = "running";
			return words;
		}, message.delivery);
		if (!sent) entry.phase = null;
	}

	/** 到点的一个：送一次，表里不再留它时返回 true。 */
	private fire(entry: Entry, now: number): boolean {
		const { wakeup } = entry;
		const entries = this.sessions.get(entry.sessionId);
		if (!wakeup.recurring || !entry.schedule) {
			entries?.delete(wakeup.id);
			wakeup.fired += 1;
			this.send(entry, null, 0);
			return true;
		}
		const expiresAt = wakeup.expiresAt ?? Infinity;
		// 电脑睡过了过期时刻才醒：过期了就是过期了，不为一件早该结束的事再开一轮。
		if (now > expiresAt + TICK_MS) {
			entries?.delete(wakeup.id);
			return true;
		}
		const next = nextCronTime(entry.schedule, now, wakeup.expiresAt);
		if (next === null) entries?.delete(wakeup.id);
		else wakeup.nextAt = next;
		// 上一次开的那一轮还没完：这次跳过。最后一次被跳过时模型听不到「这是最后一次」，但之前每一次送达都写着过期时刻。
		if (entry.phase !== null) {
			entry.skipped += 1;
			return next === null;
		}
		wakeup.fired += 1;
		const skipped = entry.skipped;
		entry.skipped = 0;
		this.send(entry, next, skipped);
		return next === null;
	}
}
