import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary, ToolResultMessage } from "@plume/contract";
import type { SessionChange } from "@plume/contract/ui";
import { publishSessionChanges, subscribeSessionChanges } from "../src/renderer/plugin-session-changes.ts";

test("插件收到后台落盘结果和删除通知，流式草稿不刷新，撤销后不再通知", () => {
	const seen: SessionChange[] = [];
	const dispose = subscribeSessionChanges((event) => seen.push(event));
	const session: SessionSummary = { id: "background", cwd: "/project", title: "", createdAt: 0, updatedAt: 1, running: true };
	publishSessionChanges({ type: "draft", sessionId: session.id, draft: undefined }, []);
	assert.equal(seen.length, 0);
	const message: ToolResultMessage = { role: "toolResult", toolName: "image_generate", toolCallId: "call", content: [], isError: false, timestamp: 1 };
	publishSessionChanges({ type: "message", sessionId: session.id, message }, []);
	publishSessionChanges({ type: "sessions", sessions: [] }, [session]);
	assert.deepEqual(seen, [
		{ sessionId: session.id, type: "messages", tools: ["image_generate"] },
		{ sessionId: session.id, type: "deleted" },
	]);
	dispose();
	publishSessionChanges({ type: "sessions", sessions: [session] }, []);
	assert.equal(seen.length, 2);
});
