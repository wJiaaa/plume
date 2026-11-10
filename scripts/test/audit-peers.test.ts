import assert from "node:assert/strict";
import { test } from "node:test";
import { peerOutcome, peerStats } from "../audit-peers.ts";

const call = (name: string, extra: { isError?: boolean; kind?: string } = {}) => ({ name, isError: false, ...extra });

test("寄出去的按 details.kind 分，被拦下的是 refused", () => {
	assert.equal(peerOutcome(call("ask_session", { kind: "session_ask" })), "session_ask");
	assert.equal(peerOutcome(call("notify_session", { isError: true })), "refused");
});

test("来信按种类、按有没有开一轮数；只有有往来的会话才算参与", () => {
	const stats = peerStats([
		{
			calls: [
				call("notify_session", { kind: "session_notify" }),
				call("notify_session", { kind: "session_notify" }),
				call("list_sessions"),
				call("ask_session", { isError: true }),
				call("bash"),
			],
			arrivals: [
				{ steered: true, letters: [{}, { request: true }] },
				{ steered: false, letters: [{ answer: "replied" }] },
			],
		},
		{ calls: [call("read")], arrivals: [] },
	]);
	assert.equal(stats.involvedSessions, 1);
	assert.deepEqual(stats.calls, { notify_session: 2, list_sessions: 1, ask_session: 1 });
	assert.deepEqual(stats.outcomes, { session_notify: 2, refused: 1 }, "list_sessions 只读不寄，不算结果");
	assert.deepEqual(stats.letters, { notice: 1, request: 1, "answer:replied": 1 });
	assert.deepEqual(stats.arrivals, { steered: 1, opened: 1 });
	assert.equal(stats.noticesPerInvolvedSession, 2);
});
