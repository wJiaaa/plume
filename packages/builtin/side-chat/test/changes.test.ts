import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { HookLayer, Message, PluginContext, PromptSubmit, SessionSummary } from "@plume/contract";
import { changeIds, sideChangesNote } from "../src/changes.ts";
import plugin from "../src/index.ts";

const result = (details: unknown, isError = false): Message =>
	({ role: "toolResult", toolCallId: "c", toolName: "write", content: [{ type: "text", text: "ok" }], details, isError, timestamp: 1 }) as Message;

test("只认没出错的工具结果上挂的改动记录，去重", () => {
	assert.deepEqual(changeIds([result({ changeId: "a" }), result({ changeIds: ["b", "a", 3] }), result({ changeId: "x" }, true), result(undefined)]), [
		"a",
		"b",
	]);
	assert.equal(
		sideChangesNote(["/w/a.ts", "/w/b.ts"]),
		"<side-chat-changes>\nA side chat changed these files while you were not looking. Re-read any of them before relying on or editing it:\n- /w/a.ts\n- /w/b.ts\n</side-chat-changes>",
	);
});

async function fixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "plume-side-chat-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const summary = (id: string, parentId?: string): SessionSummary =>
		({ id, title: "", cwd: "/w", running: false, createdAt: 0, updatedAt: 0, ...(parentId ? { parentId, owner: "plume.side-chat" } : {}) }) as SessionSummary;
	const sessions = new Map([
		["main", summary("main")],
		["side", summary("side", "main")],
		["other", summary("other")],
	]);
	const messages = new Map<string, Message[]>([
		["main", []],
		["side", [result({ changeId: "old" })]],
		["other", []],
	]);
	const collected: string[][] = [];
	const layers = new Map<string, unknown>();
	const ctx = {
		name: "plume.side-chat",
		dataDir: directory,
		locale: () => "en",
		log: { info() {}, warn() {}, error() {} },
		use: () => ({
			collect: async (sessionId: string, _cwd: string, ids: readonly string[]) => {
				assert.equal(sessionId, "side");
				collected.push([...ids]);
				return { files: ids.map((id) => ({ path: `/w/${id}.ts` })), warnings: [] };
			},
		}),
		hook: (name: string, layer: unknown) => void layers.set(name, layer),
		tools: { register: () => () => {} },
		commands: { provide() {} },
		serve() {},
		sessions: {
			list: async () => [...sessions.values()],
			messages: async (id: string) => structuredClone(messages.get(id) ?? []),
			onDeleted() {},
		},
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	const submit = layers.get("prompt.submit") as HookLayer<"prompt.submit">;
	const ask = (sessionId: string, inner: { block: false; context?: string } | { block: true; reason: string } = { block: false }) =>
		submit({ sessionId, cwd: "/w", text: "next", attachments: [], fresh: false, signal: new AbortController().signal } as PromptSubmit, async () => inner);
	return { messages, collected, ask };
}

test("侧边聊天改过的文件在主会话的下一问后面说一次；加载前的、别的会话的、被拦下的不说", async (t) => {
	const f = await fixture(t);
	// 加载前就有的改动不再补说。
	assert.deepEqual(await f.ask("main"), { block: false });
	f.messages.get("side")!.push(result({ changeIds: ["a", "b"] }), result({ changeId: "c" }, true));
	assert.deepEqual(await f.ask("other"), { block: false });
	// 被里层拦下的这一问没写进会话，说明留到下一问。
	assert.deepEqual(await f.ask("main", { block: true, reason: "no" }), { block: true, reason: "no" });
	const verdict = await f.ask("main", { block: false, context: "inner" });
	assert.equal(verdict.block, false);
	assert.equal((verdict as { context: string }).context, `inner\n\n${sideChangesNote(["/w/a.ts", "/w/b.ts"])}`);
	assert.deepEqual(f.collected, [["a", "b"]]);
	// 说过一次就不再说。
	assert.deepEqual(await f.ask("main"), { block: false });
	assert.deepEqual(f.collected, [["a", "b"]]);
	// 侧边聊天编辑重问截掉了后面那段、又写了新的：新写的照样说，不因为条数变少漏掉。
	f.messages.set("side", [result({ changeId: "old" }), { ...result({ changeId: "d" }), timestamp: 5 } as Message]);
	await f.ask("main");
	assert.deepEqual(f.collected, [["a", "b"], ["d"]]);
});
