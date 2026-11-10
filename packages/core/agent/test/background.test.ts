import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TurnStop } from "@plume/contract";
import { BackgroundRuns } from "../src/background.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("后台句柄按运行而非会话记结束原因，只有所属插件能等和报告", async () => {
	const runs = new BackgroundRuns(() => undefined);
	const first = runs.start(
		"owner",
		"child",
		"parent",
		() => undefined,
		async () => ({ reason: "done" }),
	);
	await expect(runs.wait("owner", first.id)).resolves.toEqual({ reason: "done" });
	const next = Promise.withResolvers<TurnStop>();
	const second = runs.start(
		"owner",
		"child",
		"parent",
		() => next.resolve({ reason: "aborted" }),
		() => next.promise,
	);
	expect(second.id).not.toBe(first.id);
	expect(runs.report("owner", second.id, "还没结束")).toBe(false);
	await expect(runs.wait("other", first.id)).rejects.toThrow("other");
	expect(() => runs.report("other", first.id, "冒领")).toThrow("other");
	expect(() => runs.report("owner", "unknown", "冒领")).toThrow("unknown");
	runs.cancelSession("child");
	await expect(runs.wait("owner", second.id)).resolves.toEqual({ reason: "aborted" });
	await expect(runs.wait("owner", first.id)).resolves.toEqual({ reason: "done" });
	expect(runs.report("owner", first.id, "已撤销")).toBe(false);
	runs.clear();
});

it("结果聚合四百毫秒、只能报告一次，已取出的结果仍受取消保护", async () => {
	const ready = vi.fn();
	const runs = new BackgroundRuns(ready);
	const first = runs.start(
		"owner",
		"one",
		"parent",
		() => undefined,
		async () => ({ reason: "done" }),
	);
	const second = runs.start(
		"owner",
		"two",
		"parent",
		() => undefined,
		async () => ({ reason: "done" }),
	);
	await Promise.all([runs.wait("owner", first.id), runs.wait("owner", second.id)]);
	expect(runs.report("owner", first.id, "第一份")).toBe(true);
	expect(runs.report("owner", first.id, "重复")).toBe(false);
	await vi.advanceTimersByTimeAsync(200);
	expect(runs.report("owner", second.id, "第二份")).toBe(true);
	expect(runs.take("parent")).toEqual([]);
	await vi.advanceTimersByTimeAsync(199);
	expect(ready).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(ready).toHaveBeenCalledTimes(1);
	expect(ready).toHaveBeenCalledWith("parent");
	const reports = runs.take("parent");
	expect(reports.map((report) => ("text" in report ? report.text : ""))).toEqual(["第一份", "第二份"]);
	runs.cancelSession("parent");
	expect(reports.every((report) => !report.valid())).toBe(true);
	expect(runs.take("parent")).toEqual([]);
});

it("只撤销自己的插件或单个子会话，不影响其他结果；父停止清掉聚合计时器", async () => {
	const ready = vi.fn();
	const runs = new BackgroundRuns(ready);
	const first = runs.start(
		"one",
		"a",
		"parent",
		() => undefined,
		async () => ({ reason: "done" }),
	);
	const second = runs.start(
		"two",
		"b",
		"parent",
		() => undefined,
		async () => ({ reason: "done" }),
	);
	await Promise.all([runs.wait("one", first.id), runs.wait("two", second.id)]);
	runs.report("one", first.id, "第一份");
	runs.report("two", second.id, "第二份");
	runs.cancelOwner("one");
	await vi.advanceTimersByTimeAsync(400);
	expect(runs.take("parent").map((report) => ("text" in report ? report.text : ""))).toEqual(["第二份"]);
	const third = runs.start(
		"two",
		"c",
		"parent",
		() => undefined,
		async () => ({ reason: "done" }),
	);
	await runs.wait("two", third.id);
	runs.report("two", third.id, "不能唤醒");
	runs.cancelSession("parent");
	await vi.advanceTimersByTimeAsync(400);
	expect(ready).toHaveBeenCalledTimes(1);
	expect(runs.hasReady("parent")).toBe(false);
});

it("后台抛错也作为结束原因交回，不让 wait 抛出执行错误", async () => {
	const runs = new BackgroundRuns(() => undefined);
	const run = runs.start(
		"owner",
		"child",
		"parent",
		() => undefined,
		async () => {
			throw new Error("执行失败");
		},
	);
	await expect(runs.wait("owner", run.id)).resolves.toEqual({ reason: "error", error: "执行失败" });
	expect(runs.report("owner", run.id, "错误结论")).toBe(true);
	runs.clear();
});

it("结果不因任意时长失效，取消的运行即使正常收尾也不能报告", async () => {
	const runs = new BackgroundRuns(() => undefined);
	const expired = runs.start(
		"owner",
		"old",
		"parent",
		() => undefined,
		async () => ({ reason: "done" }),
	);
	await runs.wait("owner", expired.id);
	await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
	expect(runs.report("owner", expired.id, "仍属于这次运行")).toBe(true);
	runs.cancelSession("old");
	const done = Promise.withResolvers<TurnStop>();
	const cancelled = runs.start(
		"owner",
		"new",
		"parent",
		() => done.resolve({ reason: "done" }),
		() => done.promise,
	);
	runs.cancelSession("new");
	await runs.wait("owner", cancelled.id);
	expect(runs.report("owner", cancelled.id, "取消后收尾")).toBe(false);
});
