/**
 * 运行行什么时候给这一轮开头的话让开（`renderer/conversation/running-line.ts` 的 `leadsTheTurn`）：只让第一次调工具之前的那段，
 * 插话不开新的一轮，插话之后、下一批调用之前的话照旧不让。
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import type { Message } from "@plume/contract";
import { leadsTheTurn } from "../src/renderer/conversation/running-line.ts";

const ask = (text: string, steered = false) =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 0, ...(steered ? { steered: true } : {}) }) as Message;
const call = {
	role: "assistant",
	content: [{ type: "toolCall", id: "c", name: "ls", arguments: {} }],
	stopReason: "toolUse",
	timestamp: 0,
} as unknown as Message;
const done = { role: "toolResult", toolCallId: "c", toolName: "ls", content: [], isError: false, timestamp: 0 } as Message;
const writing = { role: "assistant", content: [{ type: "text", text: "好的" }], stopReason: "pending", timestamp: 0 } as unknown as Message;

test("这一轮第一次调工具之前的话让开；插话之后的不算新的一轮", () => {
	assert.equal(leadsTheTurn([ask("看看"), writing]), true);
	assert.equal(leadsTheTurn([ask("看看"), call, done, writing]), false);
	assert.equal(leadsTheTurn([ask("看看"), call, done, ask("只看 src/", true), writing]), false);
});
