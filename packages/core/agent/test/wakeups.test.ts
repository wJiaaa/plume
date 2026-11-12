/**
 * 定时唤醒的调度（`wakeups.ts`）：cron 的解析与「下一次」，唤醒表用假时钟和假送达渠道——一次性唤醒到点送一次就没了；
 * cron 循环送出下一次和跳过了几次、过期前最后一次说「没有下一次」；上一次开的那一轮没结束时跳过；人按停、撤回、插件停用、
 * 删会话时取消；睡过头不补发；在过期之前对不上的不登记。送进去的话由约它的一方给，本体不改一个字。
 */

process.env.TZ = "Asia/Shanghai";

import { expect, it } from "vitest";
import type { BackgroundChannel, DeliveryInput, SessionWakeup, WakeupInput } from "@plume/contract";
import { nextCronTime, parseCron } from "../src/cron.ts";
import { SessionWakeups, type WakeupClock } from "../src/wakeups.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** 2026-10-23 14:00:30，上海时间。 */
const START = new Date(2026, 9, 23, 14, 0, 30).getTime();
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

function fakeClock(start = START) {
	let now = start;
	let seq = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	const clock: WakeupClock & { advance(ms: number): void; jump(ms: number): void; pending(): number } = {
		now: () => now,
		setTimeout(run, ms) {
			seq += 1;
			timers.set(seq, { at: now + ms, run });
			return seq;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		},
		advance(ms) {
			const end = now + ms;
			for (;;) {
				const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				timers.delete(next[0]);
				now = Math.max(now, next[1].at);
				next[1].run();
			}
			now = end;
		},
		/** 墙上时间跳过去，计时器不动——合盖睡眠。 */
		jump(ms) {
			now += ms;
		},
		pending: () => timers.size,
	};
	return clock;
}

/** 送达渠道：攒着报上来的，`take` 是会话真把它读进去的那一刻。 */
function fakeChannel() {
	const controller = new AbortController();
	const queued: { text: () => string | undefined; delivery?: DeliveryInput }[] = [];
	const sent: { text: string; delivery?: DeliveryInput }[] = [];
	const channel: BackgroundChannel = {
		signal: controller.signal,
		report(text, delivery) {
			if (controller.signal.aborted) return false;
			queued.push({ text: typeof text === "function" ? text : () => text, ...(delivery ? { delivery } : {}) });
			return true;
		},
	};
	const take = () => {
		for (const one of queued.splice(0)) {
			const text = one.text();
			if (text) sent.push({ text, ...(one.delivery ? { delivery: one.delivery } : {}) });
		}
	};
	return { channel, sent, queued, take };
}

/** 约它的一方给的话：把本体交来的样子原样写出来，好看清本体交了什么。 */
const message: WakeupInput["message"] = (wakeup, info) => ({
	text: JSON.stringify({ id: wakeup.id, fired: wakeup.fired, next: info.next, skipped: info.skipped }),
	delivery: { id: wakeup.id, title: wakeup.reason ?? "", status: "done" },
});
const read = (text: string) => JSON.parse(text) as { id: string; fired: number; next: number | null; skipped: number };

function harness() {
	const clock = fakeClock();
	const wakeups = new SessionWakeups(() => undefined, clock);
	const channel = fakeChannel();
	const at = (ms: number, reason = "r", call = "call") =>
		wakeups.schedule("s", "test.plugin", call, channel.channel, { at: START + ms, prompt: "p", reason, message });
	const cron = (expression: string, recurring = true, expiresAt: number | undefined = START + 3 * DAY, call = "call") =>
		wakeups.schedule("s", "test.plugin", call, channel.channel, { cron: expression, recurring, expiresAt, prompt: "p", message });
	return { clock, wakeups, at, cron, ...channel };
}

it("cron：步长、范围、列表、星期名字，写错时说清哪一处", () => {
	const cron = parseCron("*/15 9-17/4 1,15 * *");
	expect([...cron.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
	expect([...cron.hour].sort((a, b) => a - b)).toEqual([9, 13, 17]);
	expect([...parseCron("0 9 * * 5-7").weekday].sort()).toEqual([0, 5, 6]);
	expect(() => parseCron("* * * *")).toThrow(/5 fields.*has 4/);
	expect(() => parseCron("60 * * * *")).toThrow(/minute/);
	expect(() => parseCron("10-5 * * * *")).toThrow(/backwards/);
});

it("cron：下一次严格在之后、按本地时间，日和星期都写了是「或」", () => {
	const every5 = parseCron("*/5 * * * *");
	expect(nextCronTime(every5, local(2026, 10, 23, 14, 5))).toBe(local(2026, 10, 23, 14, 10));
	expect(nextCronTime(parseCron("30 14 * * *"), local(2026, 10, 23, 15))).toBe(local(2026, 10, 24, 14, 30));
	expect(nextCronTime(parseCron("0 9 1 * MON"), local(2026, 10, 23, 10))).toBe(local(2026, 10, 26, 9));
	expect(nextCronTime(parseCron("0 0 30 2 *"), local(2026, 1, 1))).toBeNull();
});

it("一次性唤醒：到点送一次，用约它的一方给的话和那一行，送完就从表里没了", () => {
	const h = harness();
	const wakeup = h.at(10 * MINUTE, "等 CI")!;
	expect(wakeup).toMatchObject({ id: "wake-1", kind: "wakeup", reason: "等 CI", recurring: false, nextAt: START + 10 * MINUTE, fired: 0 });
	expect(h.wakeups.list("s")).toHaveLength(1);
	expect(h.wakeups.list("other")).toEqual([]);
	h.clock.advance(10 * MINUTE - 1);
	expect(h.queued).toHaveLength(0);
	h.clock.advance(1);
	h.take();
	expect(h.sent).toHaveLength(1);
	expect(read(h.sent[0]!.text)).toEqual({ id: "wake-1", fired: 1, next: null, skipped: 0 });
	expect(h.sent[0]!.delivery).toEqual({ id: "wake-1", title: "等 CI", status: "done" });
	expect(h.wakeups.list("s")).toEqual([]);
	expect(h.clock.pending()).toBe(0);
});

it("循环 cron：第一次至少一分钟以后；交来下一次；上一次开的那一轮没收场时跳过，下一次说跳过了几次", () => {
	const h = harness();
	const job = h.cron("*/5 * * * *")!;
	expect(job).toMatchObject({ id: "cron-1", kind: "cron", cron: "*/5 * * * *", recurring: true, nextAt: local(2026, 10, 23, 14, 5) });
	expect(job.expiresAt).toBe(START + 3 * DAY);
	// 14:00:30 之后一分钟内的 14:01 不算：第一次至少在一分钟以后。
	expect(h.cron("1 14 23 10 *", false)?.nextAt).toBeUndefined();
	h.clock.advance(5 * MINUTE);
	h.take();
	expect(read(h.sent[0]!.text)).toEqual({ id: "cron-1", fired: 1, next: local(2026, 10, 23, 14, 10), skipped: 0 });
	h.clock.advance(5 * MINUTE);
	h.take();
	expect(h.sent).toHaveLength(1);
	h.wakeups.turnEnded("s");
	h.clock.advance(5 * MINUTE);
	h.take();
	expect(h.sent).toHaveLength(2);
	expect(read(h.sent[1]!.text)).toMatchObject({ fired: 2, skipped: 1 });
	expect(h.wakeups.list("s")[0]?.fired).toBe(2);
});

it("循环任务过期：最后一次交来「没有下一次」，之后不再触发；一次性的 cron 不记过期", () => {
	const h = harness();
	h.cron("0 15 * * *");
	for (let day = 0; day < 3; day++) {
		h.clock.advance(DAY);
		h.take();
		h.wakeups.turnEnded("s");
	}
	expect(h.sent).toHaveLength(3);
	expect(read(h.sent[2]!.text).next).toBeNull();
	expect(h.wakeups.list("s")).toEqual([]);
	const once = h.cron("30 14 * * *", false, h.clock.now() + 3 * DAY)!;
	expect(once.recurring).toBe(false);
	expect(once).not.toHaveProperty("expiresAt");
	// 在过期之前一次也对不上：不登记。
	expect(h.cron("0 0 30 2 *")).toBeUndefined();
	expect(h.wakeups.list("s")).toHaveLength(1);
});

it("人按停取消这个会话的全部、数得出几个；撤回只取消截掉的那几次调用约的；插件停用取消它约的；删会话连编号一起忘掉", () => {
	const h = harness();
	h.at(10 * MINUTE, "a", "call-1");
	h.cron("*/5 * * * *", true, START + 3 * DAY, "call-2");
	h.wakeups.cancelCalls("s", ["call-2"]);
	expect(h.wakeups.list("s").map((one) => one.id)).toEqual(["wake-1"]);
	expect(h.wakeups.cancel("s", "wake-1")).toBe(true);
	expect(h.wakeups.cancel("s", "wake-1")).toBe(false);
	h.at(10 * MINUTE);
	h.at(20 * MINUTE);
	expect(h.wakeups.cancelSession("s")).toBe(2);
	expect(h.wakeups.cancelSession("s")).toBe(0);
	expect(h.clock.pending()).toBe(0);
	// 编号接着数：模型手里的旧 id 不会指到新的。
	expect(h.at(10 * MINUTE)?.id).toBe("wake-5");
	h.wakeups.cancelOwner("other.plugin");
	expect(h.wakeups.list("s")).toHaveLength(1);
	h.wakeups.cancelOwner("test.plugin");
	expect(h.wakeups.list("s")).toEqual([]);
	h.wakeups.forget("s");
	expect(h.at(10 * MINUTE)?.id).toBe("wake-1");
});

it("合盖睡过了几次触发：醒来只送一次；睡过了过期时刻不再开一轮", () => {
	const h = harness();
	h.cron("*/5 * * * *");
	h.clock.jump(2 * 60 * MINUTE);
	h.clock.advance(0);
	expect(h.queued).toHaveLength(1);
	expect(h.wakeups.list("s")[0]!.nextAt - h.clock.now()).toBeLessThanOrEqual(5 * MINUTE);
	const late = harness();
	late.cron("*/5 * * * *");
	late.clock.jump(3 * DAY + 10 * MINUTE);
	late.clock.advance(0);
	expect(late.queued).toHaveLength(0);
	expect(late.wakeups.list("s")).toEqual([]);
});

it("渠道作废了送不进去、约的一方给不出话：这次当没触发过", () => {
	const h = harness();
	const broken = h.wakeups.schedule("s", "test.plugin", "call", h.channel, {
		at: START + MINUTE,
		prompt: "p",
		message: () => {
			throw new Error("坏了");
		},
	}) as SessionWakeup;
	expect(broken.id).toBe("wake-1");
	h.clock.advance(MINUTE);
	expect(h.queued).toHaveLength(0);
	expect(h.wakeups.list("s")).toEqual([]);
	expect(() => h.wakeups.schedule("s", "test.plugin", "call", h.channel, { prompt: "p", message })).toThrow();
	expect(() => h.wakeups.schedule("s", "test.plugin", "call", h.channel, { cron: "* * *", prompt: "p", message })).toThrow(/5 fields/);
});
