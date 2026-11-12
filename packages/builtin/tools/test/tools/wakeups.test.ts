/**
 * 定时唤醒的几件工具：调度归本体（`ToolRun.schedule`，到点、跳过、取消见 `packages/core/agent/test/wakeups.test.ts`），
 * 这里管参数和上限——下限抬到 60 秒、上限拒绝、每个会话最多 10 个、子会话里拒绝、3 天里对不上的 cron 拒绝——和到点送进去的那段话。
 */

process.env.TZ = "Asia/Shanghai";

import { expect, it } from "vitest";
import type { SessionWakeup, WakeupInput } from "@plume/contract";
import { MAX_WAKEUPS, cronListTool, scheduleWakeupTool, wakeupMessage, WAKEUP_TOOLS } from "../../src/tools/wakeups.ts";
import type { ToolContext } from "../../src/tools/types.ts";

const cronCreateTool = WAKEUP_TOOLS.find((tool) => tool.name === "cron_create")!;
const cronDeleteTool = WAKEUP_TOOLS.find((tool) => tool.name === "cron_delete")!;
const MINUTE = 60_000;

/** 假的本体：记下约了什么，按约的给出 `SessionWakeup`；`never` 时 cron 在过期前对不上。 */
function fakeCore(options: { never?: boolean } = {}) {
	const made: WakeupInput[] = [];
	const table: SessionWakeup[] = [];
	const ctx: ToolContext = {
		cwd: "/",
		state: new Map(),
		schedule: (wake) => {
			made.push(wake);
			if (wake.cron !== undefined && options.never) return undefined;
			const wakeup: SessionWakeup = {
				id: `${wake.cron === undefined ? "wake" : "cron"}-${made.length}`,
				kind: wake.cron === undefined ? "wakeup" : "cron",
				prompt: wake.prompt,
				...(wake.reason ? { reason: wake.reason } : {}),
				...(wake.cron ? { cron: wake.cron } : {}),
				recurring: wake.recurring === true,
				createdAt: Date.now(),
				nextAt: wake.at ?? Date.now() + 5 * MINUTE,
				...(wake.recurring && wake.expiresAt ? { expiresAt: wake.expiresAt } : {}),
				fired: 0,
			};
			table.push(wakeup);
			return { ...wakeup };
		},
		wakeups: {
			list: () => [...table],
			cancel: (id) => {
				const at = table.findIndex((one) => one.id === id);
				if (at < 0) return false;
				table.splice(at, 1);
				return true;
			},
		},
	};
	return { ctx, made, table };
}

const textOf = (result: { content: { text: string }[] }) => result.content.map((part) => part.text).join("\n");

it("schedule_wakeup：短于 60 秒抬到 60 秒、结果里说；长于 24 小时拒绝、点名定时任务页", async () => {
	const core = fakeCore();
	const before = Date.now();
	const made = await scheduleWakeupTool.execute({ delay_seconds: 5, prompt: "看 CI", reason: "等 CI" }, core.ctx);
	expect(made.isError).toBeFalsy();
	expect(textOf(made)).toMatch(/^Scheduled wake-1 for .*\(raised to the 60-second minimum\)\. .*Cancel it with cron_delete\.$/);
	expect(core.made[0]!.at! - before).toBeGreaterThanOrEqual(MINUTE);
	expect(core.made[0]).toMatchObject({ prompt: "看 CI", reason: "等 CI" });
	expect(made.details).toMatchObject({ kind: "wakeup", wakeup: { id: "wake-1" } });
	const far = await scheduleWakeupTool.execute({ delay_seconds: 24 * 3600 + 1, prompt: "x", reason: "y" }, core.ctx);
	expect(far.isError).toBe(true);
	expect(textOf(far)).toMatch(/24 hours.*Scheduled page/);
	expect(core.made).toHaveLength(1);
});

it("每个会话最多 10 个；子会话（没有 schedule）里拒绝", async () => {
	const core = fakeCore();
	for (let i = 0; i < MAX_WAKEUPS; i++)
		expect((await scheduleWakeupTool.execute({ delay_seconds: 600, prompt: `p${i}`, reason: "r" }, core.ctx)).isError).toBeFalsy();
	const full = await cronCreateTool.execute({ cron: "*/5 * * * *", prompt: "x" }, core.ctx);
	expect(textOf(full)).toMatch(/already has 10.*cron_delete/);
	expect(textOf(await cronDeleteTool.execute({ id: "wake-3" }, core.ctx))).toBe("Cancelled wake-3.");
	expect((await cronDeleteTool.execute({ id: "wake-3" }, core.ctx)).isError).toBe(true);
	const child = await scheduleWakeupTool.execute({ delay_seconds: 600, prompt: "x", reason: "y" }, { cwd: "/", state: new Map() });
	expect(textOf(child)).toMatch(/Only the conversation itself can schedule wakeups/);
});

it("cron_create：默认循环、3 天后过期；3 天里对不上的拒绝、点名定时任务页", async () => {
	const core = fakeCore();
	const before = Date.now();
	const made = await cronCreateTool.execute({ cron: "*/5 * * * *", prompt: "看部署" }, core.ctx);
	expect(textOf(made)).toMatch(/^Created cron-1\. Next firing: .* It repeats until .*, when it expires;/);
	expect(core.made[0]).toMatchObject({ cron: "*/5 * * * *", recurring: true, prompt: "看部署" });
	expect(core.made[0]!.expiresAt! - before).toBeGreaterThanOrEqual(3 * 24 * 60 * MINUTE);
	const once = await cronCreateTool.execute({ cron: "30 14 * * *", prompt: "x", recurring: false }, core.ctx);
	expect(textOf(once)).toContain("It fires once, then is deleted.");
	const never = fakeCore({ never: true });
	const refused = await cronCreateTool.execute({ cron: " 0  0 30 2 * ", prompt: "x" }, never.ctx);
	expect(textOf(refused)).toMatch(/^"0 0 30 2 \*" does not match any time between one minute and 3 days from now\..*Scheduled page/);
});

it("cron_list 列出待触发的", async () => {
	const core = fakeCore();
	await scheduleWakeupTool.execute({ delay_seconds: 600, prompt: "看 CI", reason: "等 CI" }, core.ctx);
	expect(textOf(await cronListTool.execute({}, core.ctx))).toMatch(/wake-1: one-time wakeup, next .* — 等 CI/);
	expect(textOf(await cronListTool.execute({}, { cwd: "/", state: new Map() }))).toBe("No pending wakeups or cron jobs in this conversation.");
});

const base: SessionWakeup = {
	id: "wake-1",
	kind: "wakeup",
	prompt: "看 CI 结果",
	reason: "等 PR 482 的 CI",
	recurring: false,
	createdAt: 0,
	nextAt: 0,
	fired: 1,
};

it("到点送进去的话：一次性的说清不会再来；那一行带着 id 和理由", () => {
	const { text, delivery } = wakeupMessage(base, { next: null, skipped: 0 });
	expect(delivery).toEqual({ id: "wake-1", title: "等 PR 482 的 CI", status: "done", details: { kind: "wakeup" } });
	expect(text).toMatch(/schedule_wakeup.*id="wake-1".*等 PR 482 的 CI/);
	expect(text).toMatch(/一次性的，之后不会再唤醒你/);
	expect(text).toMatch(/<wakeup id="wake-1">\n看 CI 结果\n<\/wakeup>/);
});

it("到点送进去的话：循环 cron 写明第几次、下一次和过期，跳过了几次；最后一次说这是最后一次", () => {
	const cron: SessionWakeup = {
		...base,
		id: "cron-1",
		kind: "cron",
		cron: "*/5 * * * *",
		recurring: true,
		expiresAt: new Date(2026, 9, 26, 14, 0).getTime(),
		fired: 2,
	};
	const { text, delivery } = wakeupMessage(cron, { next: new Date(2026, 9, 23, 14, 10).getTime(), skipped: 1 });
	expect(delivery.details).toEqual({ kind: "wakeup", cron: "*/5 * * * *" });
	expect(text).toMatch(/cron_create.*id="cron-1".*第 2 次触发/);
	expect(text).toMatch(/又到点了 1 次，那几次跳过了/);
	expect(text).toMatch(/下一次在 2026-10-23 14:10 \(UTC\+08:00\)；它在 2026-10-26 14:00 \(UTC\+08:00\) 过期/);
	expect(wakeupMessage(cron, { next: null, skipped: 0 }).text).toMatch(/这是它过期前的最后一次触发/);
});
