/**
 * 转录里一次调用的状态跟着它在后台留下的事走（`renderer/conversation/view-state.ts` 的 `callStatus`、`callStopped`）：
 * 答完了、起的任务还在跑的照跑着画，被叫停、唤醒被取消的照人按的停画，后台出错的照失败画；会话事件把最新的那一份换进视图。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BackgroundCallState, SessionView, ToolResultMessage } from "@plume/contract";
import { viewChange } from "../src/renderer/session-live.ts";
import { type CallState, callStatus, callStopped } from "../src/renderer/conversation/view-state.ts";

function result(toolCallId: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0, ...extra };
}

function calls(background: Record<string, BackgroundCallState>, results: ToolResultMessage[] = []): CallState {
	return { running: false, results: new Map(results.map((one) => [one.toolCallId, one])), jobs: new Map(), background };
}

test("答完的调用跟着后台那件画：在跑、停下、失败；正常结束、没有后台的照自己的结果", () => {
	const state = calls({ job: "running", stopped: "stopped", broke: "failed", ended: "exited" }, [
		result("job"),
		result("stopped"),
		result("broke"),
		result("ended"),
		result("plain"),
	]);
	assert.equal(callStatus(state, "job", "toolUse"), "running");
	assert.equal(callStatus(state, "stopped", "toolUse"), "error");
	assert.equal(callStopped(state, "stopped"), true);
	assert.equal(callStatus(state, "broke", "toolUse"), "error");
	assert.equal(callStopped(state, "broke"), false);
	assert.equal(callStatus(state, "ended", "toolUse"), "done");
	assert.equal(callStatus(state, "plain", "toolUse"), "done");
	assert.equal(callStopped(state, "plain"), false);
});

test("调用自己出错的照它自己的结果：后台那份不改它；人按停的照旧认作停下", () => {
	const cancelled = result("cut", { isError: true, details: { cancelled: true } });
	const state = calls({ failed: "running" }, [result("failed", { isError: true }), cancelled]);
	assert.equal(callStatus(state, "failed", "toolUse"), "error");
	assert.equal(callStopped(state, "failed"), false);
	assert.equal(callStopped(state, "cut"), true);
});

test("会话事件把这个会话后台那份整份换掉", () => {
	const change = viewChange({ type: "backgroundCalls", sessionId: "s", calls: { job: "stopped" } });
	assert.ok(change);
	assert.deepEqual(change({ backgroundCalls: { job: "running" } } as unknown as SessionView), { backgroundCalls: { job: "stopped" } });
});
