/**
 * 设置页「已归档的聊天」的分组、排序与筛选逻辑测试。
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProjectEntry, SessionSummary } from "@plume/contract";
import {
	filterArchivedGroups,
	groupArchivedSessions,
	LOOSE_PROJECT_KEY,
	resolveProjectFilter,
	selectArchivedSessions,
} from "../src/renderer/settings/archived.ts";

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		title: id,
		cwd: "/work",
		createdAt: 100,
		updatedAt: 100,
		running: false,
		kind: "top",
		archived: true,
		...overrides,
	};
}

const projects: ProjectEntry[] = [
	{ id: "p-alpha", name: "Alpha", path: "/alpha" },
	{ id: "p-beta", name: "Beta", path: "/beta" },
];

test("只选出顶层已归档会话，忽略未归档、子会话和插件独立会话", () => {
	const list = [
		session("top-archived"),
		session("top-active", { archived: false }),
		session("child-archived", { kind: "child", parentId: "top-archived" }),
		session("standalone-archived", { kind: "standalone", owner: "plume.demo" }),
	];
	assert.deepEqual(
		selectArchivedSessions(list).map((item) => item.id),
		["top-archived"],
	);
});

test("按项目归组并排序：数量优先、同数量按最新活动时间降序，未知项目归入未归属组", () => {
	const list = [
		session("a-old", { project: "p-alpha", updatedAt: 200 }),
		session("a-new", { project: "p-alpha", updatedAt: 500 }),
		session("b-only", { project: "p-beta", updatedAt: 900 }),
		session("loose-removed", { project: "p-removed", updatedAt: 400 }),
		session("loose-none", { updatedAt: 300 }),
	];
	const groups = groupArchivedSessions(list, projects, "聊天");
	assert.deepEqual(
		groups.map((group) => [group.key, group.name, group.sessions.map((item) => item.id)]),
		[
			["p-alpha", "Alpha", ["a-new", "a-old"]],
			[LOOSE_PROJECT_KEY, "聊天", ["loose-removed", "loose-none"]],
			["p-beta", "Beta", ["b-only"]],
		],
	);
});

test("项目筛选在对应分组被清空后自动回退到 all", () => {
	const groups = groupArchivedSessions([session("a1", { project: "p-alpha" })], projects, "聊天");
	assert.equal(resolveProjectFilter("all", groups), "all");
	assert.equal(resolveProjectFilter("p-alpha", groups), "p-alpha");
	assert.equal(resolveProjectFilter("p-beta", groups), "all");
});

test("按项目与搜索词组合筛选，不区分大小写且去掉空组", () => {
	const groups = groupArchivedSessions(
		[
			session("a1", { project: "p-alpha", title: "Fix Login Bug", updatedAt: 300 }),
			session("a2", { project: "p-alpha", title: "UI Polish", updatedAt: 200 }),
			session("b1", { project: "p-beta", title: "login refactor", updatedAt: 400 }),
			session("b2", { project: "p-beta", title: "", updatedAt: 100 }),
		],
		projects,
		"聊天",
	);

	assert.deepEqual(
		filterArchivedGroups(groups, "all", "  LOGIN ").map((group) => [group.key, group.sessions.map((item) => item.id)]),
		[
			["p-beta", ["b1"]],
			["p-alpha", ["a1"]],
		],
	);

	assert.deepEqual(
		filterArchivedGroups(groups, "p-beta", "login").map((group) => [group.key, group.sessions.map((item) => item.id)]),
		[["p-beta", ["b1"]]],
	);

	assert.deepEqual(filterArchivedGroups(groups, "p-alpha", "nonexistent"), []);
});
