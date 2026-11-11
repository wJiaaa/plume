import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionView } from "@plume/contract";
import { callCount, elapsed, ordered } from "../src/format.ts";
import { dispatchFromProgress, isDispatch, reportProse, wayBack, type TaskRecord } from "../src/types.ts";

const task = (state: TaskRecord["state"], extra: Partial<TaskRecord> = {}): TaskRecord => ({
	id: "child",
	session: "child",
	parent: "main",
	agent: "explore",
	description: "Find entry",
	prompt: "Find entry",
	state,
	createdAt: 1000,
	attempt: 1,
	reported: false,
	resumable: true,
	...extra,
});

test("dispatch payload validation and stopped tasks' draft-only way back", () => {
	assert.equal(isDispatch({ session: "child", agent: "explore" }), false);
	assert.equal(dispatchFromProgress("not json"), undefined);
	assert.equal(dispatchFromProgress(JSON.stringify(task("queued")))?.id, "child");
	assert.equal(wayBack(task("running")), undefined);
	assert.equal(wayBack(task("queued")), undefined);
	assert.equal(wayBack(task("done")), undefined);
	assert.equal(wayBack(task("failed")), "resume");
	assert.equal(wayBack(task("stopped", { resumable: false })), "redispatch");
	// 步数用完、原地打转的算「做完了但没做完活」：上下文在就接着跑，不在了也不重派一份已经交了的。
	assert.equal(wayBack(task("done", { incomplete: true })), "resume");
	assert.equal(wayBack(task("done", { incomplete: true, resumable: false })), undefined);
});

test("report deduplication only affects its final reply, not other turns or running prose", () => {
	const done = task("done", { answer: "The answer", answerTimestamp: 10 });
	assert.equal(reportProse(done, "The answer", 10), "");
	assert.equal(reportProse(done, "The answer", 9), "The answer");
	assert.equal(reportProse(done, "Different text", 10), "Different text");
	assert.equal(reportProse({ ...done, state: "running" }, "The answer", 10), "The answer");
});

test("roster keeps active tasks first and elapsed time stops at completion", () => {
	const done = task("done", { id: "done", createdAt: 0 });
	const running = task("running", { id: "running", createdAt: 2 });
	const queued = task("queued", { id: "queued", createdAt: 1 });
	assert.deepEqual(
		ordered([done, running, queued]).map((entry) => entry.id),
		["queued", "running", "done"],
	);
	assert.equal(elapsed(task("done", { startedAt: 1000, endedAt: 75_000 })), "1m 14s");
});

test("call count adds up tool calls across replies", () => {
	const view = {
		messages: [
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "read", id: "a", arguments: {} }],
				usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 20 },
				lastAttemptUsage: { input: 30, output: 5, cacheRead: 20, cacheWrite: 10 },
			},
		],
	} as SessionView;
	assert.equal(callCount(view), 1);
});
