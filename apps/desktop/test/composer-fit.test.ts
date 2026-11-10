/**
 * 输入框底下那一排让出什么、什么时候让：按模型名量出来，不按宽度猜。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FIT_LEVELS, MAX_FIT_LEVEL, MIN_NAME_WIDTH, nextLevel, settle, tight } from "../src/renderer/composer/fit.ts";

test("名字放得下不算紧", () => {
	assert.equal(tight({ scrollWidth: 171, clientWidth: 171 }), false);
});

test("名字被截掉几个像素不是急事", () => {
	// 截断末尾有省略号、悬停提示有全名，几乎不要钱；为它收起权限签的字是花一整段字去换。
	assert.equal(tight({ scrollWidth: 171, clientWidth: 164 }), false);
});

test("截到认不出才算紧", () => {
	assert.equal(tight({ scrollWidth: 436, clientWidth: 71 }), true);
});

test("短名字多窄都不算紧", () => {
	assert.equal(tight({ scrollWidth: 40, clientWidth: 40 }), false);
	assert.equal(tight({ scrollWidth: 40, clientWidth: 300 }), false);
});

test("留一个像素给小数像素的排版，免得来回闪", () => {
	assert.equal(tight({ scrollWidth: 172, clientWidth: 171 }), false);
	assert.equal(tight({ scrollWidth: 173, clientWidth: 40 }), true);
});

test("没有可量的不算紧", () => {
	// 没有模型那一格的输入框（子会话里只读的那种）照样留着它有的一切。
	assert.equal(tight(null), false);
	assert.equal(tight(undefined), false);
});

test("放得下就什么都不让；放不下按顺序让，权限签的字先于上下文用量", () => {
	assert.equal(nextLevel(FIT_LEVELS.all, false), null);
	assert.equal(nextLevel(FIT_LEVELS.all, true), FIT_LEVELS.noAccessLabel);
	assert.equal(nextLevel(FIT_LEVELS.noAccessLabel, true), FIT_LEVELS.noMeter);
	assert.ok(FIT_LEVELS.noAccessLabel < FIT_LEVELS.noMeter);
	assert.equal(nextLevel(MAX_FIT_LEVEL, true), null, "没得让了就停");
});

/** 事先定好量法的一排：`tightAt` 列出放不下的级别。 */
const rowWhere = (...tightAt: number[]) => {
	const asked: number[] = [];
	const measure = (level: number) => {
		asked.push(level);
		return tightAt.includes(level);
	};
	return { measure, asked };
};

test("宽的一排全画出来，只量一次", () => {
	const row = rowWhere();
	assert.equal(settle(row.measure), FIT_LEVELS.all);
	assert.deepEqual(row.asked, [FIT_LEVELS.all]);
});

test("缺权限签那点宽度的，让出它就停", () => {
	const row = rowWhere(FIT_LEVELS.all);
	assert.equal(settle(row.measure), FIT_LEVELS.noAccessLabel);
	assert.deepEqual(row.asked, [FIT_LEVELS.all, FIT_LEVELS.noAccessLabel]);
});

test("还不够就接着让上下文用量", () => {
	assert.equal(settle(rowWhere(FIT_LEVELS.all, FIT_LEVELS.noAccessLabel).measure), FIT_LEVELS.noMeter);
});

test("什么都放不下时停在最光秃的一级，每级只问一次", () => {
	const row = rowWhere(FIT_LEVELS.all, FIT_LEVELS.noAccessLabel, FIT_LEVELS.noMeter);
	assert.equal(settle(row.measure), MAX_FIT_LEVEL);
	assert.equal(row.asked.length, MAX_FIT_LEVEL + 1);
});

test("认得出的下限是十来个字符的宽度", () => {
	assert.ok(MIN_NAME_WIDTH >= 64 && MIN_NAME_WIDTH <= 140, `${MIN_NAME_WIDTH}px`);
});
