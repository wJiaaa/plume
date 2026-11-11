import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, AgentService, AssistantMessage, Message, SessionView, ToolResultMessage, UserMessage } from "@plume/contract";
import type { Remote } from "@plume/rpc";
import { applyLive, readSessionView, viewChange } from "../src/renderer/session-live.ts";

const ask: UserMessage = { role: "user", content: [{ type: "text", text: "看看" }], timestamp: 1 };
const call = {
	role: "assistant",
	content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
	stopReason: "toolUse",
	timestamp: 2,
} as unknown as AssistantMessage;
const result: ToolResultMessage = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [], isError: false, timestamp: 3 };
const answer = { role: "assistant", content: [{ type: "text", text: "好了" }], stopReason: "stop", timestamp: 4 } as unknown as AssistantMessage;

function snapshot(messages: Message[]): SessionView {
	return {
		summary: { id: "s", cwd: "/w", title: "", createdAt: 0, updatedAt: 0, running: true },
		messages,
		progress: {},
		startedAt: {},
		hiccups: [],
		compactions: [],
		compactionRuns: [],
		compacting: false,
		queue: [],
	};
}

const message = (item: Message, count: number): AgentEvent => ({ type: "message", sessionId: "s", message: item, count });

function replay(view: SessionView, events: AgentEvent[]): SessionView {
	let next = view;
	for (const event of events) {
		const change = "sessionId" in event ? viewChange(event as Extract<AgentEvent, { sessionId: string }>) : undefined;
		if (change) next = { ...next, ...change(next) };
	}
	return next;
}

test("快照接上从更早处回放的事件：已有的消息落回原位不重复，草稿、调用的开始时刻跟着收掉", () => {
	const events: AgentEvent[] = [
		message(ask, 1),
		{ type: "draft", sessionId: "s", draft: { ...call, stopReason: "pending" } as AssistantMessage },
		message(call, 2),
		{ type: "toolStart", sessionId: "s", toolCallId: "c1", startedAt: 5 },
		{ type: "progress", sessionId: "s", toolCallId: "c1", output: "…" },
		message(result, 3),
	];
	// 快照停在调用写完、结果还没到的时候，事件从人发问那一刻回放。
	const view = replay(snapshot([ask, call]), events);
	assert.deepEqual(view.messages, [ask, call, result]);
	assert.equal(view.draft, undefined);
	assert.deepEqual(view.progress, {});
	assert.deepEqual(view.startedAt, {});
	// 撤回过的也收敛：快照是撤回后又答了一轮的样子。
	const rewound = replay(snapshot([ask, answer]), [
		message(call, 2),
		{ type: "rewound", sessionId: "s", count: 1, compactions: [], runs: [] },
		message(answer, 2),
	]);
	assert.deepEqual(rewound.messages, [ask, answer]);
});

test("读的期间到的事件补进读回来的那份，只读一次；别的会话的事件不混进来", async () => {
	let reads = 0;
	let resolve!: (view: SessionView) => void;
	const service = {
		getSession: () => {
			reads++;
			return new Promise<SessionView>((done) => (resolve = done));
		},
	} as unknown as Remote<AgentService>;
	const reading = readSessionView(service, "s");
	// 前两条快照里已经有了，后一条还没有；草稿每一拍都来。
	applyLive(message(ask, 1));
	applyLive({ type: "draft", sessionId: "s", draft: { ...call, stopReason: "pending" } as AssistantMessage });
	applyLive(message(call, 2));
	applyLive({ type: "message", sessionId: "other", message: answer, count: 1 });
	applyLive(message(result, 3));
	resolve(snapshot([ask, call]));
	const view = await reading;
	assert.equal(reads, 1);
	assert.deepEqual(view.messages, [ask, call, result]);
	assert.equal(view.draft, undefined);
	// 读完就不再攒：之后的事件不会混进下一次读。
	applyLive(message(answer, 4));
	const again = readSessionView(service, "s");
	resolve(snapshot([ask, call, result]));
	assert.deepEqual((await again).messages, [ask, call, result]);
});
