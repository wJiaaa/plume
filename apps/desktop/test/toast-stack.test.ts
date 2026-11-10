/**
 * 不止一条提示时一摞提示条怎么表现：同一句话两次是一张卡片，重复来的不让整列在指针底下换位置，一阵连发在屏幕上有上限、多的也不悄悄排队。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { translateIn } from "../../../packages/client/ui/src/i18n/translate.ts";
import { groupNotices, schedule, TOAST_LIFETIME, TOAST_LIMIT, TOAST_Z, visibleToasts, type Notice } from "../src/renderer/toast/stack.ts";

const zh = (key: Parameters<typeof translateIn>[1]) => translateIn("zh-CN", key);
const notice = (id: string, message: string, level: Notice["level"] = "error"): Notice => ({ id, level, message });

test("不同的话是不同的卡片，按到达的顺序", () => {
	const groups = groupNotices([notice("1", "甲"), notice("2", "乙"), notice("3", "丙")], zh);
	assert.deepEqual(
		groups.map((g) => g.message),
		["甲", "乙", "丙"],
	);
	assert.ok(groups.every((g) => g.ids.length === 1));
});

test("同一句话三次是一张卡片，记着每一条", () => {
	const groups = groupNotices([notice("1", "删除失败"), notice("2", "删除失败"), notice("3", "删除失败")], zh);
	assert.equal(groups.length, 1);
	assert.deepEqual(groups[0]!.ids, ["1", "2", "3"], "每条都留着，关掉时一起清掉");
});

test("同样的字、不同的级别是两张卡片", () => {
	assert.equal(groupNotices([notice("1", "同一句话", "warn"), notice("2", "同一句话", "error")], zh).length, 2);
});

test("说法不同、意思相同的按换过的说法并", () => {
	const groups = groupNotices([notice("1", "connect ECONNREFUSED 127.0.0.1:1"), notice("2", "connect ECONNREFUSED 127.0.0.1:2")], zh);
	assert.equal(groups.length, 1);
	assert.equal(groups[0]!.message, "连接被拒绝");
});

test("系统自己在说的不说", () => {
	assert.deepEqual(groupNotices([notice("1", "Failed to get sources.")], zh), []);
});

test("重复来的留在原来的位置", () => {
	const groups = groupNotices([notice("1", "甲"), notice("2", "乙"), notice("3", "甲")], zh);
	assert.deepEqual(
		groups.map((g) => g.message),
		["甲", "乙"],
	);
	assert.deepEqual(groups[0]!.ids, ["1", "3"]);
});

test("只画最新的几张，其余的不丢", () => {
	const groups = groupNotices(
		Array.from({ length: 7 }, (_, i) => notice(String(i), `第 ${i} 条`)),
		zh,
	);
	assert.equal(groups.length, 7, "它们的计时还在走");
	const shown = visibleToasts(groups);
	assert.equal(shown.length, TOAST_LIMIT);
	assert.deepEqual(
		shown.map((g) => g.message),
		["第 4 条", "第 5 条", "第 6 条"],
	);
});

test("没有就什么都没有", () => {
	assert.deepEqual(groupNotices([], zh), []);
	assert.deepEqual(visibleToasts([]), []);
});

test("只有新来的一条重新计时，别的卡片来去不算", () => {
	const first = groupNotices([notice("1", "甲")], zh);
	const due = schedule(new Map(), first, 1000);
	assert.equal(due.get(first[0]!.key)?.at, 1000 + TOAST_LIFETIME.error);
	const withOther = groupNotices([notice("1", "甲"), notice("2", "乙")], zh);
	assert.equal(schedule(due, withOther, 5000).get(first[0]!.key)?.at, 1000 + TOAST_LIFETIME.error, "乙来了不该让甲多留");
	const repeated = groupNotices([notice("1", "甲"), notice("3", "甲")], zh);
	assert.equal(schedule(due, repeated, 5000).get(first[0]!.key)?.at, 5000 + TOAST_LIFETIME.error, "甲又来一次，重新算");
});

test("每一级都有寿命，错误比闲话留得久", () => {
	for (const level of ["info", "warn", "error"] as const) assert.ok(TOAST_LIFETIME[level] > 0);
	assert.ok(TOAST_LIFETIME.error > TOAST_LIFETIME.info);
});

test("提示条在产品自己的层和 CodeMirror 的层上面", () => {
	assert.ok(TOAST_Z > 200, `提示条在 ${TOAST_Z}，会被盖住`);
});
