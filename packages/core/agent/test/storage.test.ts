import { expect, it } from "vitest";
import type { SessionSummary } from "@plume/contract";
import { sessionTrees, storageUse, withinRange } from "../src/storage.ts";

const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();
const summary = (id: string, updatedAt: number, parentId?: string): SessionSummary => ({
	id,
	title: id,
	cwd: "/tmp",
	createdAt: 0,
	updatedAt,
	running: false,
	kind: parentId ? "child" : "top",
	...(parentId ? { parentId } : {}),
});

it("按最后活动的本地日期筛，两头都含当天，空的那头不设限", () => {
	const late = summary("a", at(5, 23));
	expect(withinRange(late, { from: "2026-11-05", to: "2026-11-05" })).toBe(true);
	expect(withinRange(late, { from: "2026-11-06", to: null })).toBe(false);
	expect(withinRange(late, { from: null, to: "2026-11-04" })).toBe(false);
	expect(withinRange(late, { from: null, to: null })).toBe(true);
});

it("记录大小按最后活动日摊开", () => {
	const use = storageUse(
		[summary("a", at(5)), summary("b", at(5, 8)), summary("c", at(2))],
		new Map([
			["a", 100],
			["c", 40],
		]),
	);
	expect(use).toEqual({
		bytes: 140,
		sessions: 3,
		earliest: "2026-11-02",
		latest: "2026-11-05",
		days: [
			{ day: "2026-11-02", sessions: 1, bytes: 40 },
			{ day: "2026-11-05", sessions: 2, bytes: 100 },
		],
	});
});

it("子会话不单独统计、不单独挑：大小算在顶层会话头上，按顶层会话的最后活动日", () => {
	// 子 Agent 早几天跑完，父会话后来还在用：清 11 月 2 日时不该把它单独挑出来。
	const sessions = [summary("main", at(5)), summary("agent", at(2), "main"), summary("orphan", at(3), "gone")];
	const sizes = new Map([
		["main", 100],
		["agent", 30],
		["orphan", 7],
	]);
	expect(sessionTrees(sessions, sizes).map(({ summary: { id }, bytes }) => [id, bytes])).toEqual([
		["main", 130],
		["orphan", 7],
	]);
	expect(storageUse(sessions, sizes)).toMatchObject({
		bytes: 137,
		sessions: 2,
		days: [
			{ day: "2026-11-03", sessions: 1, bytes: 7 },
			{ day: "2026-11-05", sessions: 1, bytes: 130 },
		],
	});
});
