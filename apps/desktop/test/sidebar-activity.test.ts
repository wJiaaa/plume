/**
 * 侧栏行首的等批准、完成、失败：从会话摘要的变化里推出来。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@plume/contract";
import { activityOf, approvalChanged, outcome, sessionsChanged, settle, sortNotices } from "../src/renderer/sidebar/activity.ts";

const base: SessionSummary = { id: "s", title: "s", cwd: "/work", createdAt: 0, updatedAt: 0, running: false };
const running = { ...base, running: true };

test("没看着时一轮停下：做完是完成，出错、到步数上限、卡住是失败，人按停和退出打断不提醒", () => {
	assert.equal(settle(running, { ...base, stop: { reason: "done" } }, undefined, false), "done");
	assert.equal(settle(running, { ...base, stop: { reason: "error", error: "x" } }, undefined, false), "failed");
	assert.equal(outcome("max_turns"), "failed");
	assert.equal(outcome("stalled"), "failed");
	assert.equal(settle(running, { ...base, stop: { reason: "aborted" } }, undefined, false), undefined);
	assert.equal(outcome("interrupted"), undefined);
});

test("看着的会话跑完不留记号；等批准的记号在一轮停下时撤掉", () => {
	assert.equal(settle(running, { ...base, stop: { reason: "done" } }, undefined, true), undefined);
	assert.equal(settle(running, { ...base, stop: { reason: "aborted" } }, "waiting", false), undefined);
});

test("新一轮开始清掉上一轮的结果，跑着时等批准的记号留着；摘要别的变化不动记号", () => {
	assert.equal(settle(base, running, "done", false), undefined);
	assert.equal(settle(running, running, "waiting", false), "waiting");
	assert.equal(settle(base, { ...base, title: "改名" }, "failed", false), "failed");
});

test("子会话在等批准时父会话也是等批准；子会话答完了父会话回到自己的记号", () => {
	const parent = { ...base, id: "p" };
	const child = { ...base, id: "c", parentId: "p", running: true };
	sessionsChanged([], [parent, child], undefined);
	approvalChanged("c", true);
	assert.equal(activityOf("p"), "waiting");
	approvalChanged("c", false);
	assert.equal(activityOf("p"), undefined);
	sessionsChanged([parent, child], [], undefined);
});

test("通知合起来排：页面的失败排在会话的完成前面，同类里新的在前、没时间的在后", () => {
	const notices = sortNotices([
		{ id: "done", state: "done", updatedAt: 5 },
		{ id: "page", state: "failed" },
		{ id: "failed", state: "failed", updatedAt: 3 },
		{ id: "waiting", state: "waiting", updatedAt: 1 },
	] as const);
	assert.deepEqual(
		notices.map((notice) => notice.id),
		["waiting", "failed", "page", "done"],
	);
});
