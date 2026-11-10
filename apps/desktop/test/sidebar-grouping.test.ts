/**
 * 侧栏的分组：会话按记下的项目 id 归组，不按目录；项目移除后它的会话落到「聊天」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@plume/contract";
import { groupSessions, projectSessions, nestSpawned, withSpawned } from "../src/renderer/sidebar/grouping.ts";

function session(id: string, at: number, project?: string): SessionSummary {
	return { id, title: id, cwd: "/work", createdAt: at, updatedAt: 100 - at, running: false, ...(project ? { project } : {}) };
}

test("按项目 id 归组，不看目录；没有会话的项目也占一行；找不到项目的会话落到聊天", () => {
	const projects = [
		{ id: "b", name: "B", path: "/work" },
		{ id: "a", name: "A", path: "/work" },
		{ id: "empty", name: "空", path: "/empty" },
	];
	const grouped = groupSessions(
		[
			{ ...session("blank", 6), title: "" },
			{ ...session("blank-project", 7, "a"), title: "" },
			session("a1", 1, "a"),
			session("a2", 2, "a"),
			session("b1", 3, "b"),
			session("gone", 4, "removed"),
			session("chat", 5),
		],
		projects,
	);
	assert.deepEqual(
		grouped.projects.map((group) => [group.id, group.sessions.map((each) => each.id)]),
		[
			["b", ["b1"]],
			["a", ["a2", "a1"]],
			["empty", []],
		],
	);
	// 聊天按最后活动排：updatedAt 是 100 - at，gone 比 chat 新。
	assert.deepEqual(
		grouped.loose.map((each) => each.id),
		["gone", "chat"],
	);
});

test("会话全归档了的项目：默认照样占一行，打开 hideEmptied 时收起；从没有过会话的项目始终保留", () => {
	const projects = [
		{ id: "done", name: "告一段落", path: "/done" },
		{ id: "fresh", name: "新建的", path: "/fresh" },
		{ id: "busy", name: "还在用", path: "/busy" },
	];
	const sessions = [{ ...session("old", 1, "done"), archived: true }, { ...session("kept", 2, "busy"), archived: true }, session("live", 3, "busy")];
	assert.deepEqual(
		groupSessions(sessions, projects).projects.map((group) => group.id),
		["done", "fresh", "busy"],
	);
	assert.deepEqual(
		groupSessions(sessions, projects, true).projects.map((group) => group.id),
		["fresh", "busy"],
	);
});

test("置顶按最后活动排序，从项目和聊天中移除；空标题、子会话和归档会话不进置顶", () => {
	const projects = [{ id: "a", name: "A", path: "/work" }];
	const sessions = [
		{ ...session("project-pin", 5, "a"), pinned: true },
		{ ...session("loose-pin", 1), pinned: true },
		{ ...session("orphan-pin", 3, "removed"), pinned: true },
		{ ...session("archived-pin", 2, "a"), pinned: true, archived: true },
		{ ...session("blank-pin", 0, "a"), pinned: true, title: "" },
		{ ...session("child-pin", 0, "a"), pinned: true, parentId: "project-pin" },
		session("project", 6, "a"),
		session("chat", 7),
	];
	const grouped = groupSessions(sessions, projects);
	assert.deepEqual(
		grouped.pinned.map((each) => each.id),
		["loose-pin", "orphan-pin", "project-pin"],
	);
	assert.deepEqual(
		grouped.projects[0]!.sessions.map((each) => each.id),
		["project"],
	);
	assert.deepEqual(
		grouped.loose.map((each) => each.id),
		["chat"],
	);
	assert.equal(sessions[0]!.pinned, true);
});

test("只有置顶会话的项目仍保留标题，hideEmptied 不把它和归档会话一起判为全归档", () => {
	const projects = [
		{ id: "a", name: "A", path: "/work" },
		{ id: "fresh", name: "新建", path: "/fresh" },
	];
	const sessions = [
		{ ...session("pinned", 1, "a"), pinned: true },
		{ ...session("archived", 2, "a"), archived: true },
	];
	const grouped = groupSessions(sessions, projects, true);
	assert.deepEqual(
		grouped.projects.map((group) => [group.id, group.sessions.length]),
		[
			["a", 0],
			["fresh", 0],
		],
	);
	assert.deepEqual(
		grouped.pinned.map((each) => each.id),
		["pinned"],
	);
});

test("置顶归档后隐藏，取消归档回置顶；分组不改掉置顶标记", () => {
	const projects = [{ id: "a", name: "A", path: "/work" }];
	const pinned = { ...session("pinned", 1, "a"), pinned: true, archived: true };
	const archived = groupSessions([pinned], projects, true);
	assert.equal(archived.pinned.length, 0);
	assert.equal(archived.projects.length, 0);
	assert.equal(pinned.pinned, true);
	const restored = groupSessions([{ ...pinned, archived: false }], projects, true);
	assert.deepEqual(
		restored.pinned.map((each) => each.id),
		["pinned"],
	);
	assert.deepEqual(
		restored.projects.map((group) => [group.id, group.sessions.length]),
		[["a", 0]],
	);
});

test("取消置顶回原项目或聊天，并恢复各自的排序", () => {
	const projects = [{ id: "a", name: "A", path: "/work" }];
	const sessions = [
		session("project", 1, "a"),
		{ ...session("unpin-project", 3, "a"), pinned: false },
		session("chat", 2),
		{ ...session("unpin-chat", 4), pinned: false },
	];
	const grouped = groupSessions(sessions, projects);
	assert.deepEqual(grouped.pinned, []);
	assert.deepEqual(
		grouped.projects[0]!.sessions.map((each) => each.id),
		["unpin-project", "project"],
	);
	assert.deepEqual(
		grouped.loose.map((each) => each.id),
		["chat", "unpin-chat"],
	);
});

test("移动会话只按项目 id 归组，移出保留工作目录；置顶不随项目移动重复出现", () => {
	const projects = [
		{ id: "a", name: "A", path: "/work" },
		{ id: "b", name: "B", path: "/other" },
	];
	const moved = { ...session("moved", 1, "b"), cwd: "/other", unread: true };
	const pinned = { ...session("pinned", 2, "b"), pinned: true };
	const grouped = groupSessions([moved, pinned], projects);
	assert.deepEqual(
		grouped.projects.map((group) => [group.id, group.sessions.map((each) => each.id)]),
		[
			["a", []],
			["b", ["moved"]],
		],
	);
	assert.deepEqual(
		grouped.pinned.map((each) => each.id),
		["pinned"],
	);
	const removed = { ...moved, project: undefined };
	const loose = groupSessions([removed, { ...pinned, project: undefined }], projects);
	assert.deepEqual(loose.loose, [removed]);
	assert.equal(loose.loose[0]!.cwd, "/other");
	assert.equal(loose.loose[0]!.unread, true);
	assert.deepEqual(
		loose.pinned.map((each) => each.id),
		["pinned"],
	);
});

test("项目里的会话可以改按最近更新排；置顶和聊天不受影响", () => {
	const projects = [{ id: "a", name: "A", path: "/work" }];
	const sessions = [session("a1", 1, "a"), session("a2", 2, "a"), session("c1", 3), session("c2", 4)];
	assert.deepEqual(
		groupSessions(sessions, projects, false, "updatedAt").projects[0]?.sessions.map((each) => each.id),
		["a1", "a2"],
	);
	assert.deepEqual(
		groupSessions(sessions, projects, false, "updatedAt").loose.map((each) => each.id),
		groupSessions(sessions, projects).loose.map((each) => each.id),
	);
});

test("项目里还列着的会话：含置顶的，不含归档、子会话和没发过消息的", () => {
	const sessions = [
		session("live", 1, "a"),
		{ ...session("pinned", 2, "a"), pinned: true },
		{ ...session("archived", 3, "a"), archived: true },
		{ ...session("child", 4, "a"), parentId: "live" },
		{ ...session("blank", 5, "a"), title: "" },
		session("other", 6, "b"),
	];
	assert.deepEqual(
		projectSessions(sessions, "a").map((each) => each.id),
		["live", "pinned"],
	);
});

test("同组来源嵌套，置顶、归档、跨项目后分开；多级后续展平且不能成环", () => {
	const projects = [
		{ id: "p", name: "项目", path: "/work" },
		{ id: "q", name: "另一个", path: "/other" },
	];
	const a = session("a", 1, "p");
	const b = { ...session("b", 2, "p"), spawnedFrom: { sessionId: "a" } };
	const c = { ...session("c", 3, "p"), forkedFrom: { sessionId: "b" } };
	const nest = (list: SessionSummary[]) => nestSpawned(groupSessions(list, projects));
	const grouped = nest([a, b, c]);
	assert.deepEqual(
		grouped.projects[0]!.sessions.map((item) => item.id),
		["a"],
	);
	assert.deepEqual(
		withSpawned(grouped.projects[0]!.sessions, grouped.spawned).map((item) => item.id),
		["a", "b", "c"],
	);
	for (const changed of [
		{ ...a, pinned: true },
		{ ...a, archived: true },
		{ ...a, project: "q" },
	])
		assert.equal(nest([changed, b, c]).spawned.a, undefined);
	assert.equal(nest([{ ...a, spawnedFrom: { sessionId: "c" } }, b, c]).projects[0]!.sessions[0]!.id, "a");
	assert.deepEqual(
		nest([
			{ ...a, pinned: true },
			{ ...b, pinned: true },
		]).spawned.a?.map((item) => item.id),
		["b"],
	);
});

test("手动顺序与拖动一致，新会话排在已排序会话前面", async () => {
	const { moveBeforeOrAfter } = await import("../src/renderer/sidebar/order.ts");
	const projects = [{ id: "p", name: "项目", path: "/work", sessionOrder: ["b", "a"] }];
	const ids = groupSessions([session("a", 1, "p"), session("b", 2, "p"), session("new", 3, "p")], projects, false, "manual").projects[0]!.sessions.map(
		(item) => item.id,
	);
	assert.deepEqual(ids, ["new", "b", "a"]);
	assert.deepEqual(moveBeforeOrAfter(ids, "a", "new", "before"), ["a", "new", "b"]);
	assert.equal(moveBeforeOrAfter(ids, "a", "b", "after"), null);
	assert.equal(moveBeforeOrAfter(ids, "missing", "a", "before"), null);
});
