/**
 * 定时唤醒：cron 的解析与「下一次」，唤醒表用假时钟和假送达渠道——一次性唤醒到点送一次就没了、下限抬到 60 秒、上限拒绝；
 * cron 循环写明下一次和过期、过期前最后一次说清楚；上一次开的那一轮没结束时跳过；数量上限；渠道作废时跟着取消；睡过头不补发。
 */

process.env.TZ = "Asia/Shanghai";

import { expect, it } from "vitest";
import type { BackgroundChannel, DeliveredReport } from "@plume/contract";
import { nextCronTime, parseCron } from "../../src/tools/cron.ts";
import { CRON_MAX_AGE_MS, MAX_WAKEUPS, SessionWakeups, cronListTool, scheduleWakeupTool, type WakeupClock } from "../../src/tools/wakeups.ts";

const MINUTE = 60_000;
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
	const queued: { text: () => string | undefined; delivery?: DeliveredReport }[] = [];
	const sent: { text: string; delivery?: DeliveredReport }[] = [];
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
	return { channel, sent, queued, take, abort: () => controller.abort() };
}

function harness() {
	const clock = fakeClock();
	const wakeups = new SessionWakeups(clock);
	return { clock, wakeups, ...fakeChannel() };
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

it("一次性唤醒：到点送一次，带着 id 和理由，送完就从表里没了", () => {
	const h = harness();
	const { wakeup, clamped } = h.wakeups.wakeup(h.channel, 600, "看 CI 结果", "等 PR 482 的 CI");
	expect(clamped).toBe(false);
	expect(wakeup.nextAt).toBe(START + 10 * MINUTE);
	h.clock.advance(10 * MINUTE - 1);
	expect(h.queued).toHaveLength(0);
	h.clock.advance(1);
	h.take();
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.delivery).toEqual({ id: wakeup.id, kind: "wakeup", agent: "", description: "等 PR 482 的 CI", status: "done" });
	expect(h.sent[0]!.text).toMatch(new RegExp(`schedule_wakeup.*id="${wakeup.id}".*等 PR 482 的 CI`));
	expect(h.sent[0]!.text).toMatch(/一次性的，之后不会再唤醒你/);
	expect(h.sent[0]!.text).toMatch(/<wakeup id="wake-1">\n看 CI 结果\n<\/wakeup>/);
	expect(h.wakeups.list()).toEqual([]);
	expect(h.clock.pending()).toBe(0);
});

it("唤醒短于 60 秒抬到 60 秒，长于 24 小时拒绝", () => {
	const h = harness();
	const { wakeup, clamped } = h.wakeups.wakeup(h.channel, 5, "x", "y");
	expect(clamped).toBe(true);
	expect(wakeup.nextAt).toBe(START + MINUTE);
	expect(() => h.wakeups.wakeup(h.channel, 24 * 3600 + 1, "x", "y")).toThrow(/24 hours.*Scheduled page/);
});

it("循环 cron：写明第几次、下一次和过期；上一次开的那一轮没收场时跳过，下一次说跳过了几次", () => {
	const h = harness();
	const job = h.wakeups.cron(h.channel, "*/5 * * * *", "看部署", true);
	expect(job.nextAt).toBe(local(2026, 10, 23, 14, 5));
	expect(job.expiresAt).toBe(START + CRON_MAX_AGE_MS);
	h.clock.advance(5 * MINUTE);
	h.take();
	expect(h.sent[0]!.text).toMatch(/cron_create.*id="cron-1".*第 1 次触发/);
	expect(h.sent[0]!.text).toMatch(/下一次在 2026-10-23 14:10 \(UTC\+08:00\)；它在 2026-10-26 14:00 \(UTC\+08:00\) 过期/);
	h.clock.advance(5 * MINUTE);
	h.take();
	expect(h.sent).toHaveLength(1);
	h.wakeups.turnEnded();
	h.clock.advance(5 * MINUTE);
	h.take();
	expect(h.sent).toHaveLength(2);
	expect(h.sent[1]!.text).toMatch(/又到点了 1 次，那几次跳过了/);
	expect(h.wakeups.list()[0]?.fired).toBe(2);
});

it("循环任务过期：最后一次送达说这是最后一次，之后不再触发", () => {
	const h = harness();
	h.wakeups.cron(h.channel, "0 15 * * *", "日报", true);
	for (let day = 0; day < 3; day++) {
		h.clock.advance(24 * 60 * MINUTE);
		h.take();
		h.wakeups.turnEnded();
	}
	expect(h.sent).toHaveLength(3);
	expect(h.sent[2]!.text).toMatch(/这是它过期前的最后一次触发/);
	expect(h.wakeups.list()).toEqual([]);
});

it("每个会话最多 10 个；渠道作废（人按停止、撤回）时全部取消", async () => {
	const h = harness();
	for (let i = 0; i < MAX_WAKEUPS; i++) h.wakeups.wakeup(h.channel, 600 + i, `p${i}`, `r${i}`);
	expect(() => h.wakeups.cron(h.channel, "*/5 * * * *", "x", true)).toThrow(/already has 10.*cron_delete/);
	expect(h.wakeups.cancel("wake-3")).toBe(true);
	expect(h.wakeups.cancel("wake-3")).toBe(false);
	h.abort();
	await Promise.resolve();
	expect(h.wakeups.list()).toEqual([]);
	expect(h.clock.pending()).toBe(0);
	// 新一代渠道上建的照常。
	const next = fakeChannel();
	h.wakeups.wakeup(next.channel, 60, "x", "y");
	h.clock.advance(MINUTE);
	next.take();
	expect(next.sent).toHaveLength(1);
});

it("人按停：宿主先作废渠道、再同步通知停止，停止那一头还数得到取消了几个", async () => {
	const h = harness();
	h.wakeups.wakeup(h.channel, 600, "a", "r");
	h.wakeups.cron(h.channel, "*/5 * * * *", "b", true);
	h.abort();
	expect(h.wakeups.cancelAll()).toBe(2);
	await Promise.resolve();
	expect(h.wakeups.list()).toEqual([]);
	expect(h.clock.pending()).toBe(0);
	// 撤回不通知停止：作废以后悄悄取消，之后再按停没有可说的。
	const next = fakeChannel();
	h.wakeups.wakeup(next.channel, 600, "c", "r");
	next.abort();
	await Promise.resolve();
	expect(h.wakeups.cancelAll()).toBe(0);
});

it("合盖睡过了几次触发：醒来只送一次；睡过了过期时刻不再开一轮", () => {
	const h = harness();
	h.wakeups.cron(h.channel, "*/5 * * * *", "看部署", true);
	h.clock.jump(2 * 60 * MINUTE);
	h.clock.advance(0);
	expect(h.queued).toHaveLength(1);
	expect(h.wakeups.list()[0]!.nextAt - h.clock.now()).toBeLessThanOrEqual(5 * MINUTE);
	const late = harness();
	late.wakeups.cron(late.channel, "*/5 * * * *", "看部署", true);
	late.clock.jump(CRON_MAX_AGE_MS + 10 * MINUTE);
	late.clock.advance(0);
	expect(late.queued).toHaveLength(0);
	expect(late.wakeups.list()).toEqual([]);
});

it("工具：没有送达渠道（子会话）时拒绝；cron_list 列出待触发的", async () => {
	const state = new Map<string, unknown>();
	const refused = await scheduleWakeupTool.execute({ delay_seconds: 600, prompt: "x", reason: "y" }, { cwd: "/", state });
	expect(refused.isError).toBe(true);
	const { channel } = fakeChannel();
	const made = await scheduleWakeupTool.execute({ delay_seconds: 600, prompt: "看 CI", reason: "等 CI" }, { cwd: "/", state, background: () => channel });
	expect(made.isError).toBeFalsy();
	const listed = await cronListTool.execute({}, { cwd: "/", state });
	expect(listed.content[0]!.text).toMatch(/wake-1: one-time wakeup, next .* — 等 CI/);
});
