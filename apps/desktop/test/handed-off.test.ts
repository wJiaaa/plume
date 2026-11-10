/**
 * 输入框上方那一条列哪些会话、各自说哪一步（`renderer/conversation/handed-off.ts`）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, SessionSummary } from "@plume/contract";
import type { SessionActivity } from "@plume/contract/ui";
import { handedOffFrom, noteSessionDoing, sessionDoing } from "../src/renderer/conversation/handed-off.ts";

function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
	return { id, title: id, cwd: "/work", createdAt: 0, updatedAt: 0, running: false, ...extra };
}

test("只列从这个会话交出去、此刻有话可说的：在跑、在等、跑完还没看；归档的、别处开的、看过的不列", () => {
	const from = { sessionId: "main" };
	const sessions = [
		session("plan", { spawnedFrom: from, running: true }),
		session("seen", { spawnedFrom: from }),
		session("other", { spawnedFrom: { sessionId: "elsewhere" }, running: true }),
		session("plain", { running: true }),
		session("review", { spawnedFrom: from }),
		session("asking", { spawnedFrom: from, running: true }),
		session("archived", { spawnedFrom: from, archived: true }),
	];
	const marks: Record<string, SessionActivity> = { review: "done", asking: "waiting", archived: "done" };
	assert.deepEqual(
		handedOffFrom(sessions, (id) => marks[id], "main").map((row) => [row.session.id, row.state]),
		[
			["plan", "running"],
			["review", "done"],
			["asking", "waiting"],
		],
	);
});

test("记着最近开始的那一步：按调用 id 认出是哪一次调用；一轮停下、截掉就清掉", () => {
	const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id, name, arguments: args });
	const assistant = (...calls: ReturnType<typeof call>[]) =>
		({ type: "message", sessionId: "child", message: { role: "assistant", content: calls, stopReason: "toolUse" } }) as unknown as AgentEvent;
	const start = (toolCallId: string): AgentEvent => ({ type: "toolStart", sessionId: "child", toolCallId, startedAt: 1 });
	const running = (value: boolean): AgentEvent => ({ type: "sessions", sessions: [session("child", { running: value })] });

	noteSessionDoing(assistant(call("a", "read", { path: "/work/pom.xml" }), call("b", "bash", { command: "mvn test" })));
	noteSessionDoing(running(true));
	assert.equal(sessionDoing("child"), undefined, "写进会话、还没开始的调用不算在做");
	noteSessionDoing(start("a"));
	assert.equal(sessionDoing("child")?.name, "read");
	noteSessionDoing(start("b"));
	assert.equal(sessionDoing("child")?.name, "bash");
	noteSessionDoing(start("nope"));
	assert.equal(sessionDoing("child")?.name, "bash", "认不出的调用不换掉上一步");
	noteSessionDoing(running(false));
	assert.equal(sessionDoing("child"), undefined);

	noteSessionDoing(assistant(call("c", "grep", { pattern: "x" })));
	noteSessionDoing(start("c"));
	assert.equal(sessionDoing("child")?.name, "grep");
	noteSessionDoing({ type: "rewound", sessionId: "child", count: 0, compactions: [], runs: [] });
	assert.equal(sessionDoing("child"), undefined);
});
