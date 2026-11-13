import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedFile, FileChangesSummary, Locale, Message, PluginContext, SessionSummary } from "@plume/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeliveryApi } from "../src/api.ts";
import plugin from "../src/index.ts";
import { deliveryMessages, recordedChanges } from "../src/record.ts";
import { answer, changed, result, user } from "./fixtures.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "plume-delivery-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function setup(messages: Message[], sessionId = "session", locale: Locale = "en") {
	const cwd = join(root, "project");
	let summary: FileChangesSummary = { files: [], warnings: [] };
	const collect = vi.fn(async (_id: string, _ids: readonly string[]) => summary);
	const undo = vi.fn(async (_id: string, _ids: readonly string[], _path?: string) => {});
	const sessions: SessionSummary[] = [{ id: sessionId, title: "Test", cwd, createdAt: 1, updatedAt: 10, running: false, kind: "top" }];
	let api!: DeliveryApi;
	const ctx = {
		locale: () => locale,
		changes: { collect, undo },
		serve: (value: DeliveryApi) => {
			api = value;
		},
		sessions: {
			get: vi.fn(async (id: string) => sessions.find((session) => session.id === id)),
			messages: vi.fn(async () => messages),
		},
	} as unknown as PluginContext;
	plugin.apply(ctx);
	return {
		api,
		ctx,
		sessions,
		collect,
		undo,
		cwd,
		setSummary: (value: FileChangesSummary) => {
			summary = value;
		},
	};
}

function file(path: string): ChangedFile {
	return {
		path,
		added: 1,
		removed: 1,
		canUndo: false,
		undoReason: "Changed externally",
		hunks: [
			{
				oldStart: 1,
				newStart: 1,
				lines: [
					{ type: "context", text: "same" },
					{ type: "remove", text: "before" },
					{ type: "add", text: "after" },
				],
			},
		],
	};
}

it("分轮只在真实 user 处分开，synthetic 不截断，也不包含相邻轮次", () => {
	const first = [user(1, "First"), changed(["first"]), answer(3)];
	const second = [user(4, "Second"), answer(5, "Working", "toolUse"), changed(["second"]), user(6, "Continue", true), changed(["continued"]), answer(10)];
	const all = [...first, ...second, user(11, "Third"), changed(["third"]), answer(12)];
	expect(deliveryMessages(all, 3, "en")).toEqual(first);
	expect(deliveryMessages(all, 10, "en")).toEqual(second);
	expect(() => deliveryMessages(all, 5, "en")).toThrow(/final answer/);
	expect(() => deliveryMessages(all, 999, "en")).toThrow(/final answer/);
	expect(() => deliveryMessages([user(1, "Injected", true), answer()], 10, "en")).toThrow(/final answer/);
});

it("回答后补勾清单仍能找到原回答那一轮", () => {
	const turn = [user(), changed(["one"]), answer()];
	const tick = answer(12, "", "toolUse");
	tick.content = [{ type: "toolCall", id: "todo", name: "todo_write", arguments: {} }];
	expect(deliveryMessages([...turn, user(11, "tick", true), tick, result({ checklist: [] })], 10, "en")).toEqual(turn);
});

it("只认本体记在结果上的改动：去重快照标识，失败结果改了的也算，收集警告；工具自己在 details 里写的不认", () => {
	const messages = [
		changed(["two", "one"], "Partial capture"),
		changed(["two", "three"], "Failed command still changed files", true),
		result({ changeId: "forged", changeIds: ["forged"], path: "/work/legacy.ts", before: "old", after: "new" }),
		result(null),
		result("bad details"),
	];
	expect(recordedChanges(messages)).toEqual({ ids: ["two", "one", "three"], warnings: ["Partial capture", "Failed command still changed files"] });
});

it("严格检查会话、时间戳和最后回答，失败时不调用文件服务", async () => {
	const f = setup([user(), answer()]);
	await expect(f.api.get("missing", 10)).rejects.toThrow(/session/);
	await expect(f.api.get("session", Number.NaN)).rejects.toThrow(/final answer/);
	await expect(f.api.get("session", Infinity)).rejects.toThrow(/final answer/);
	await expect(f.api.get("session", 1)).rejects.toThrow(/final answer/);
	await expect(f.api.undo("missing", 10, undefined)).rejects.toThrow(/session/);
	expect(f.collect).not.toHaveBeenCalled();
	expect(f.undo).not.toHaveBeenCalled();
});

it("净变更完全委托本体的 ctx.changes，保留它的撤销原因和快照警告", async () => {
	const f = setup([user(), changed(["one", "two", "one"]), answer()]);
	const app = file(join(f.cwd, "app.ts"));
	f.setSummary({ files: [app], warnings: ["Snapshot missing: two"] });
	const value = await f.api.get("session", 10);
	expect(f.collect).toHaveBeenCalledWith("session", ["one", "two"]);
	expect(value.files).toEqual([app]);
	expect(value.warnings).toEqual(["Snapshot missing: two"]);
	// 本体返回空净变更时，不能根据单次写入自行拼回文件。
	f.setSummary({ files: [], warnings: [] });
	expect((await f.api.get("session", 10)).files).toEqual([]);
});

it("撤销只交快照标识，撤销后重新 get；拒绝原文对象，服务报错不伪装成功", async () => {
	const f = setup([user(), changed(["one"]), changed(["partial"], undefined, true), answer()]);
	f.setSummary({ files: [file(join(f.cwd, "app.ts"))], warnings: [] });
	f.undo.mockImplementation(async () => {
		f.setSummary({ files: [], warnings: [] });
	});
	expect((await f.api.undo("session", 10, "app.ts")).files).toEqual([]);
	expect(f.undo).toHaveBeenLastCalledWith("session", ["one", "partial"], "app.ts");
	expect(f.collect).toHaveBeenCalledTimes(1);
	await f.api.undo("session", 10, undefined);
	expect(f.undo).toHaveBeenLastCalledWith("session", ["one", "partial"], undefined);
	await expect(f.api.undo("session", 10, { before: "arbitrary content" } as unknown as string)).rejects.toThrow(/nonempty file path/);
	f.undo.mockRejectedValueOnce(new Error("File changed externally"));
	await expect(f.api.undo("session", 10, undefined)).rejects.toThrow("File changed externally");
	expect(f.collect).toHaveBeenCalledTimes(2);
});

it("快照服务整体失败也给明确警告", async () => {
	const f = setup([user(), changed(["missing"], "Capture incomplete"), answer()]);
	f.collect.mockRejectedValueOnce(new Error("Unreadable snapshot"));
	const value = await f.api.get("session", 10);
	expect(value.warnings).toEqual(["Capture incomplete", "Change snapshots are unavailable: Error: Unreadable snapshot"]);
});

it.each(["en", "zh-CN"] as const)("%s 无效会话错误按界面语言返回", async (locale) => {
	const f = setup([user(), answer()], "session", locale);
	await expect(f.api.get("missing", 10)).rejects.toThrow(locale === "en" ? "The requested session was not found." : "找不到对应的会话。");
});
