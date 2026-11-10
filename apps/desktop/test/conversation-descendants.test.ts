import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@plume/contract";
import { conversationDescendants } from "../src/renderer/conversation/descendants.ts";

function summary(id: string, parentId?: string): SessionSummary {
	return { id, title: id, cwd: "/work", running: false, createdAt: 1, updatedAt: 1, ...(parentId ? { parentId } : {}) };
}
test("子会话审批沿真实父链找到倒序列表中的全部后代，不拿其他会话，也不被环卡住", () => {
	const sessions = [summary("grandchild", "child"), summary("unrelated", "elsewhere"), summary("child", "root"), summary("root", "grandchild")];
	assert.deepEqual(
		conversationDescendants("root", sessions).map((session) => session.id),
		["child", "grandchild"],
	);
	assert.deepEqual(conversationDescendants("missing", sessions), []);
});
