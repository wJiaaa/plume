/**
 * 主窗口往 window.json 里写什么、要不要最大化着打开（main/window-bounds.ts）。
 *
 * 在 Windows 11、125% 缩放下量过：窗口每启动一次长 4×5 或 4×6（1202×802 → 1206×807 → 1210×813 → 1214×819），
 * 因为读回来的大小被当成下次要的大小存下；最大化着关掉的窗口下次是普通窗口，因为最大化时的边界从来不写，这件事也跟着丢了。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { reopenMaximized, stateToSave } from "../src/main/window-bounds.ts";

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const still = { maximized: false, fullScreen: false, minimized: false };

test("没人动过的窗口存的是当初要的大小，不是实际出来的大小", () => {
	const opened = { asked: box(167, 7, 1202, 802), got: box(167, 7, 1206, 807) };
	assert.deepEqual(stateToSave({ ...still, normal: opened.got, opened }), { x: 167, y: 7, width: 1202, height: 802 });
});

test("一次次启动，大小停在放下的地方", () => {
	// 每次都比要的大几像素，就像 Windows 上 125% 缩放时那样。
	const grow = (b: ReturnType<typeof box>) => box(b.x, b.y, b.width + 4, b.height + 5);
	let asked = box(167, 7, 1202, 802);
	for (let launch = 0; launch < 5; launch++) {
		const opened = { asked, got: grow(asked) };
		const saved = stateToSave({ ...still, normal: opened.got, opened })!;
		asked = box(saved.x!, saved.y!, saved.width, saved.height);
	}
	assert.deepEqual(asked, box(167, 7, 1202, 802));
});

test("有人缩放或挪过的窗口，存的是人调成的样子", () => {
	const opened = { asked: box(167, 7, 1202, 802), got: box(167, 7, 1206, 807) };
	assert.deepEqual(stateToSave({ ...still, normal: box(167, 7, 1000, 700), opened }), { x: 167, y: 7, width: 1000, height: 700 });
	assert.deepEqual(stateToSave({ ...still, normal: box(300, 40, 1206, 807), opened }), { x: 300, y: 40, width: 1206, height: 807 });
});

test("最大化时存普通状态的边界，旁边记一笔最大化；还原后这一笔就没了", () => {
	const opened = { asked: box(167, 7, 1202, 802), got: box(167, 7, 1206, 807) };
	assert.deepEqual(stateToSave({ ...still, maximized: true, normal: opened.got, opened }), { x: 167, y: 7, width: 1202, height: 802, maximized: true });
	assert.equal(stateToSave({ ...still, normal: opened.got, opened })!.maximized, undefined);
});

test("全屏和最小化时什么都不写", () => {
	const normal = box(0, 0, 900, 600);
	assert.equal(stateToSave({ ...still, fullScreen: true, normal, opened: null }), null);
	assert.equal(stateToSave({ ...still, minimized: true, normal, opened: null }), null);
});

test("Windows、Linux 最大化着关的窗口最大化着打开；macOS 按原来的大小打开", () => {
	const state = { width: 1202, height: 802, maximized: true };
	assert.equal(reopenMaximized(state, "win32"), true);
	assert.equal(reopenMaximized(state, "linux"), true);
	assert.equal(reopenMaximized(state, "darwin"), false);
	assert.equal(reopenMaximized({ width: 1202, height: 802 }, "win32"), false);
	assert.equal(reopenMaximized(undefined, "win32"), false);
});
