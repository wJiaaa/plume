import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/contract";
import { addToolLine, removeToolLines } from "../src/renderer/conversation/tool-lines.ts";
import { latestFooterTimestamp } from "../src/renderer/conversation/turn-footer.ts";

const user = (synthetic = false): Message => ({
	role: "user",
	content: [{ type: "text", text: "go" }],
	timestamp: 1,
	...(synthetic ? { synthetic: true } : {}),
});
const answer = (timestamp: number, stopReason = "stop", content: unknown[] = [{ type: "text", text: "done" }]): Message =>
	({ role: "assistant", timestamp, stopReason, content }) as Message;
const result = (toolName = "edit"): Message => ({ role: "toolResult", toolName, toolCallId: "call", timestamp: 3, isError: false, content: [] });

test("只有最新已结束回复有页脚，新消息和运行中不借用旧轮", () => {
	const messages = [user(), answer(2)];
	assert.equal(latestFooterTimestamp(messages, false), 2);
	assert.equal(latestFooterTimestamp(messages, true), null);
	assert.equal(latestFooterTimestamp([...messages, user()], false), null);
	assert.equal(latestFooterTimestamp([...messages, answer(4, "toolUse"), result()], false), null);
	assert.equal(latestFooterTimestamp([user(), answer(2, "pending")], false), null);
	assert.equal(latestFooterTimestamp([], false), null);
});

test("补勾清单不抢走最后回复的页脚，普通工具未结束不能挂", (t) => {
	// 哪个工具记清单由插件在界面入口说（`ToolLine.checklist`）。
	addToolLine("example.todo", "todo_write", { verb: "更新清单", checklist: true });
	t.after(() => removeToolLines("example.todo"));
	const tick = answer(4, "toolUse", [{ type: "toolCall", id: "call", name: "todo_write", arguments: {} }]);
	assert.equal(latestFooterTimestamp([user(), answer(2), user(true), tick, result("todo_write")], false), 2);
	assert.equal(latestFooterTimestamp([user(), tick, result("todo_write")], false), null);
	assert.equal(latestFooterTimestamp([user(), answer(2), user(true)], false), 2);
	assert.equal(latestFooterTimestamp([user(), answer(2), user(true), tick, result("todo_write"), answer(6)], false), 6);
});
