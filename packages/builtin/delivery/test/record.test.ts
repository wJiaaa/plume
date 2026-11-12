import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedFile, FileChangesSummary, HookLayer, Locale, Message, PluginContext, SessionSummary } from "@plume/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeliveryApi } from "../src/api.ts";
import plugin from "../src/index.ts";
import { deliveryMessages, recordedChanges } from "../src/record.ts";
import { answer, result, user } from "./fixtures.ts";

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
	const collect = vi.fn(async (_id: string, _cwd: string, _ids: readonly string[]) => summary);
	const undo = vi.fn(async (_id: string, _cwd: string, _ids: readonly string[], _path?: string) => {});
	const sessions: SessionSummary[] = [{ id: sessionId, title: "Test", cwd, createdAt: 1, updatedAt: 10, running: false, kind: "top" }];
	let api!: DeliveryApi;
	let rewind!: HookLayer<"session.rewind">;
	const ctx = {
		locale: () => locale,
		use: vi.fn(() => ({ collect, undo })),
		serve: (value: DeliveryApi) => {
			api = value;
		},
		hook: (name: string, layer: HookLayer<"session.rewind">) => {
			if (name === "session.rewind") rewind = layer;
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
		rewind: (messages: Message[], restore: boolean) =>
			rewind({ sessionId, session: { id: sessionId, kind: "top" }, cwd, messages, restore }, async () => ({
				files: [{ path: "/inner", added: 2, removed: 0, problem: null }],
				unrecorded: false,
			})),
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
	const first = [user(1, "First"), result({ changeId: "first" }), answer(3)];
	const second = [
		user(4, "Second"),
		answer(5, "Working", "toolUse"),
		result({ changeId: "second" }),
		user(6, "Continue", true),
		result({ changeIds: ["continued"] }),
		answer(10),
	];
	const all = [...first, ...second, user(11, "Third"), result({ changeId: "third" }), answer(12)];
	expect(deliveryMessages(all, 3, "en")).toEqual(first);
	expect(deliveryMessages(all, 10, "en")).toEqual(second);
	expect(() => deliveryMessages(all, 5, "en")).toThrow(/final answer/);
	expect(() => deliveryMessages(all, 999, "en")).toThrow(/final answer/);
	expect(() => deliveryMessages([user(1, "Injected", true), answer()], 10, "en")).toThrow(/final answer/);
});

it("回答后补勾清单仍能找到原回答那一轮", () => {
	const turn = [user(), result({ changeId: "one" }), answer()];
	const tick = answer(12, "", "toolUse");
	tick.content = [{ type: "toolCall", id: "todo", name: "todo_write", arguments: {} }];
	expect(deliveryMessages([...turn, user(11, "tick", true), tick, result({ kind: "todo" })], 10, "en")).toEqual(turn);
});

it("去重全部快照标识，失败结果只保留 changeIds，收集警告而不接受旧 diff 原文", () => {
	const messages = [
		result({ changeId: "one", changeIds: ["two", "one", 3], changeWarning: "Partial capture" }),
		result({ changeId: "ignore", changeIds: ["two", "three"], changeWarning: "Failed command still changed files" }, true),
		result({ path: "/work/legacy.ts", before: "old", after: "new" }),
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

it("净变更完全委托 file.changes，保留服务的撤销原因和快照警告", async () => {
	const f = setup([user(), result({ changeId: "one", changeIds: ["two", "one"] }), answer()]);
	const changed = file(join(f.cwd, "app.ts"));
	f.setSummary({ files: [changed], warnings: ["Snapshot missing: two"] });
	const value = await f.api.get("session", 10);
	expect(f.ctx.use).toHaveBeenCalledWith("file.changes");
	expect(plugin.inject).toEqual(["file.changes"]);
	expect(f.collect).toHaveBeenCalledWith("session", f.cwd, ["two", "one"]);
	expect(value.files).toEqual([changed]);
	expect(value.warnings).toEqual(["Snapshot missing: two"]);
	// 服务返回空净变更时，不能根据单次写入自行拼回文件。
	f.setSummary({ files: [], warnings: [] });
	expect((await f.api.get("session", 10)).files).toEqual([]);
});

it("撤销只交快照标识，撤销后重新 get；拒绝原文对象，服务报错不伪装成功", async () => {
	const f = setup([user(), result({ changeId: "one" }), result({ changeIds: ["partial"] }, true), answer()]);
	f.setSummary({ files: [file(join(f.cwd, "app.ts"))], warnings: [] });
	f.undo.mockImplementation(async () => {
		f.setSummary({ files: [], warnings: [] });
	});
	expect((await f.api.undo("session", 10, "app.ts")).files).toEqual([]);
	expect(f.undo).toHaveBeenLastCalledWith("session", f.cwd, ["one", "partial"], "app.ts");
	expect(f.collect).toHaveBeenCalledTimes(1);
	await f.api.undo("session", 10, undefined);
	expect(f.undo).toHaveBeenLastCalledWith("session", f.cwd, ["one", "partial"], undefined);
	await expect(f.api.undo("session", 10, { before: "arbitrary content" } as unknown as string)).rejects.toThrow(/nonempty file path/);
	f.undo.mockRejectedValueOnce(new Error("File changed externally"));
	await expect(f.api.undo("session", 10, undefined)).rejects.toThrow("File changed externally");
	expect(f.collect).toHaveBeenCalledTimes(2);
});

it("快照服务整体失败也给明确警告", async () => {
	const f = setup([user(), result({ changeId: "missing", changeWarning: "Capture incomplete" }), answer()]);
	f.collect.mockRejectedValueOnce(new Error("Unreadable snapshot"));
	const value = await f.api.get("session", 10);
	expect(value.warnings).toEqual(["Capture incomplete", "Change snapshots are unavailable: Error: Unreadable snapshot"]);
});

it.each(["en", "zh-CN"] as const)("%s 无效会话错误按界面语言返回", async (locale) => {
	const f = setup([user(), answer()], "session", locale);
	await expect(f.api.get("missing", 10)).rejects.toThrow(locale === "en" ? "The requested session was not found." : "找不到对应的会话。");
});

it("撤回截掉的那段：演算标出每个文件能不能退回，并上里层的结论；退回时把全部快照标识交给服务", async () => {
	const f = setup([]);
	const cut = [user(4), result({ changeId: "one" }), result({ changeIds: ["two"] }), answer(10)];
	const kept: ChangedFile = { ...file(join(f.cwd, "a.ts")), canUndo: true };
	delete kept.undoReason;
	f.setSummary({ files: [kept, { ...file(join(f.cwd, "b.ts")), undoProblem: "modified" }], warnings: [] });
	expect(await f.rewind(cut, false)).toEqual({
		files: [
			{ path: "/inner", added: 2, removed: 0, problem: null },
			{ path: join(f.cwd, "a.ts"), added: 1, removed: 1, problem: null },
			{ path: join(f.cwd, "b.ts"), added: 1, removed: 1, problem: "modified" },
		],
		unrecorded: false,
	});
	expect(f.collect).toHaveBeenLastCalledWith("session", f.cwd, ["one", "two"]);
	expect(f.undo).not.toHaveBeenCalled();
	// 是否能写由服务在写之前再查一遍：它拒绝时原样抛出，什么都不算退回。
	f.undo.mockRejectedValueOnce(new Error("File changed externally"));
	await expect(f.rewind(cut, true)).rejects.toThrow("File changed externally");
	f.setSummary({ files: [kept], warnings: [] });
	await f.rewind(cut, true);
	expect(f.undo).toHaveBeenLastCalledWith("session", f.cwd, ["one", "two"]);
});

it.each(["en", "zh-CN"] as const)("%s 撤回时有改动没记全：演算说没记全，退回时一个文件都不写", async (locale) => {
	const f = setup([], "session", locale);
	const partial = [user(4), result({ changeId: "one", changeWarning: "Too many files" }), answer(10)];
	f.setSummary({ files: [{ ...file(join(f.cwd, "a.ts")), canUndo: true }], warnings: [] });
	expect((await f.rewind(partial, false)).unrecorded).toBe(true);
	await expect(f.rewind(partial, true)).rejects.toThrow(locale === "en" ? "weren't recorded" : "没有记录下来");
	// 快照读不出来，或者不能退回又说不出是哪一类，也算没记全。
	const cut = [user(4), result({ changeId: "one" }), answer(10)];
	f.setSummary({ files: [], warnings: ["Snapshot missing"] });
	expect((await f.rewind(cut, false)).unrecorded).toBe(true);
	f.setSummary({ files: [file(join(f.cwd, "a.ts"))], warnings: [] });
	expect(await f.rewind(cut, false)).toMatchObject({ files: [{}, { problem: null }], unrecorded: true });
	await expect(f.rewind(cut, true)).rejects.toThrow();
	expect(f.undo).not.toHaveBeenCalled();
});

it("截掉的那段没碰过文件：不读快照，退回什么都不写", async () => {
	const f = setup([]);
	const cut = [user(4), result({ command: "git status", exitCode: 0 }), answer(10)];
	expect(await f.rewind(cut, false)).toEqual({ files: [{ path: "/inner", added: 2, removed: 0, problem: null }], unrecorded: false });
	await f.rewind(cut, true);
	expect(f.collect).not.toHaveBeenCalled();
	expect(f.undo).not.toHaveBeenCalled();
});
