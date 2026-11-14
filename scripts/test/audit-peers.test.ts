import assert from "node:assert/strict";
import { test } from "node:test";
import { peerOutcome, peerStats } from "../audit-peers.ts";

const call = (name: string, extra: { isError?: boolean; kind?: string } = {}) => ({ name, isError: false, ...extra });

test("寄出去的按 details.kind 分，被拦下的是 refused", () => {
	assert.equal(peerOutcome(call("send_message", { kind: "session_message" })), "session_message");
	assert.equal(peerOutcome(call("send_message", { isError: true })), "refused");
});

test("来信按有没有开一轮数；只有有往来的会话才算参与", () => {
	const stats = peerStats([
		{
			calls: [
				call("send_message", { kind: "session_message" }),
				call("send_message", { kind: "session_message" }),
				call("list_sessions"),
				call("send_message", { isError: true }),
				call("bash"),
			],
			arrivals: [
				{ steered: true, letters: [{}, {}] },
				{ steered: false, letters: [{}] },
			],
		},
		{ calls: [call("read")], arrivals: [] },
	]);
	assert.equal(stats.involvedSessions, 1);
	assert.deepEqual(stats.calls, { send_message: 3, list_sessions: 1 });
	assert.deepEqual(stats.outcomes, { session_message: 2, refused: 1 }, "list_sessions 只读不寄，不算结果");
	assert.equal(stats.letters, 3);
	assert.deepEqual(stats.arrivals, { steered: 1, opened: 1 });
	assert.equal(stats.messagesPerInvolvedSession, 3);
});
