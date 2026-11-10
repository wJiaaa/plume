/**
 * 出字的节奏——见 `stream-pace.ts`。
 *
 * 钉住几件事：按 token 流的上游屏幕几乎不落后；一阵一停的上游，停顿里屏幕不停，落后也不超过上限；
 * 上游再快也不封顶；一大批字一起到，从第一个起就匀着放；正在打的半个拉丁词不放出来，中文照字放。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FADE, Pace, wordCut } from "../src/renderer/markdown/stream-pace.ts";

/** 每 `every` 毫秒来一块 `chunk` 个字，写 3 秒。 */
function play(chunk: number, every: number) {
	const pace = new Pace();
	let count = 0;
	let last = 0;
	for (let t = 0; t < 3000; t += every) {
		count += chunk;
		pace.plan(t, count);
		last = t;
	}
	return { births: pace.births, last, pace };
}

function gaps(births: number[]): number[] {
	return births.slice(1).map((at, i) => at - births[i]);
}

test("按 token 流的上游（每 24ms 四个字），屏幕落后不到 150ms，字一个一个出、不成堆", () => {
	const { births, last } = play(4, 24);
	const lag = births.at(-1)! - last;
	assert.ok(lag >= 0 && lag < 150, `落后 ${lag.toFixed(0)}ms`);
	for (const [i, gap] of gaps(births).entries()) assert.ok(gap >= 0 && gap <= 1000 / 60 + 1e-9, `第 ${i + 1} 个字隔了 ${gap}ms`);
});

test("流半秒、停三百毫秒的上游（DeepSeek 经中转），停顿里屏幕不停，落后不超过 700ms", () => {
	// 每 24ms 四个字，流 500ms、停 300ms，循环。
	const pace = new Pace();
	let count = 0;
	let last = 0;
	for (let t = 0; t < 4000; t += 24) {
		if (t % 800 >= 500) continue;
		count += 4;
		pace.plan(t, count);
		last = t;
	}
	// 头一个停顿还没见过，不算；之后的每一个停顿里都有字在出。
	for (const start of [1300, 2100, 2900]) {
		const during = pace.births.filter((at) => at >= start && at < start + 300).length;
		assert.ok(during >= 10, `${start}ms 起的停顿里只出了 ${during} 个字`);
	}
	const lag = pace.births.at(-1)! - last;
	assert.ok(lag <= 700, `落后 ${lag.toFixed(0)}ms`);
});

test("每 600ms 倒一批 150 个字的上游，第二批起屏幕就不再停，落后不超过 700ms", () => {
	const { births, last } = play(150, 600);
	const after = births.filter((at) => at >= 600);
	const idle = Math.max(...gaps(after));
	assert.ok(idle < 100, `两个字之间最长空了 ${idle.toFixed(0)}ms`);
	const lag = births.at(-1)! - last;
	assert.ok(lag <= 700, `落后 ${lag.toFixed(0)}ms`);
});

test("慢的上游（每秒二三十字）一批几个字，摊满到下一批来，不是几帧放完再干等", () => {
	for (const [chunk, every] of [
		[6, 300],
		[15, 500],
		[3, 100],
	]) {
		const { births, last } = play(chunk, every);
		// 头一秒在摸上游的节奏，不算。
		const idle = Math.max(...gaps(births.filter((at) => at >= 1000)));
		assert.ok(idle < 100, `每 ${every}ms ${chunk} 个字：两个字之间最长空了 ${idle.toFixed(0)}ms`);
		const lag = births.at(-1)! - last;
		assert.ok(lag <= 700, `每 ${every}ms ${chunk} 个字：落后 ${lag.toFixed(0)}ms`);
	}
});

test("快的上游停了一秒再接着来，接着来的字不按撑满的余量摊成慢动作", () => {
	const pace = new Pace();
	let count = 0;
	for (let t = 0; t < 1000; t += 24) pace.plan(t, (count += 4));
	const resumed = count;
	for (let t = 2000; t < 3000; t += 24) pace.plan(t, (count += 4));
	const span = pace.births[resumed + 11] - pace.births[resumed];
	assert.ok(span < 400, `停顿之后的 12 个字放了 ${span.toFixed(0)}ms`);
});

test("上游每秒八百多字，屏幕跟得上，不封顶", () => {
	const { births, last } = play(14, 16);
	const lag = births.at(-1)! - last;
	assert.ok(lag < 200, `落后 ${lag.toFixed(0)}ms：从前封在每秒 500 字，写完还要放一秒多`);
});

test("一大批字一起到，从一开始就匀着放，400ms 内放完", () => {
	const pace = new Pace();
	pace.plan(0, 600);
	const spread = gaps(pace.births);
	assert.ok(Math.max(...spread) - Math.min(...spread) < 1e-9, "间隔应该一样");
	assert.ok(pace.births[599] <= 400, `最后一个字在 ${pace.births[599]}ms`);
	// 一小批也不拖：四个字几帧就出完。
	const small = new Pace();
	small.plan(0, 4);
	assert.ok(small.births[3] <= 60, `最后一个字在 ${small.births[3]}ms`);
});

test("一次进来几千字不是在输出（重连、补发），直接全放", () => {
	const pace = new Pace();
	pace.plan(500, 3000);
	assert.ok(pace.births.every((at) => at === 500));
});

test("挂上时已有的字当作早就放出来了，之后来的字从头按新的一条流排", () => {
	const pace = new Pace();
	pace.present(5, 1000);
	assert.equal(pace.cut(1000), 5);
	assert.equal(pace.recentCount(1000, FADE), 0, "不算最近放出来的");
	pace.plan(2000, 9);
	assert.ok(pace.births[5] >= 2000);
	assert.equal(pace.cut(1999), 5);
	assert.ok(pace.recentCount(2100, FADE) > 0);
});

test("正在打的半个拉丁词不放出来；中文、标点、上游停下了都照常放", () => {
	assert.equal(wordCut("Hello wor", 8, true), 6, "扣着 wor");
	assert.equal(wordCut("Hello wor", 8, false), 8, "上游停下了就放");
	assert.equal(wordCut("Hello world", 11, true), 6, "切在末尾也扣：最后那个词多半还没打完");
	assert.equal(wordCut("Hello world.", 12, true), 12, "末尾是标点就不是半个词");
	assert.equal(wordCut("Hello, wo", 6, true), 6, "逗号后面是边界");
	assert.equal(wordCut("你好世界", 2, true), 2, "中文照字放");
	assert.equal(wordCut("用 React 写", 5, true), 2, "中文里夹的拉丁词也按词");
	assert.equal(wordCut("中文的词word", 6, true), 4, "汉字和拉丁字母之间是边界");
	const hash = "a".repeat(40);
	assert.equal(wordCut(hash, 30, true), 30, "太长的不是词，照常放");
	assert.equal(wordCut("x😀y", 2, true), 3, "不切在代理对中间");
});
