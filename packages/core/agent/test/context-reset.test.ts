import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompactSummary, Message, ModelContext, Plugin, PluginContext } from "@plume/contract";
import type { ModelConfig, ProviderConfig } from "@plume/llm/types";
import { emptyRecord } from "../src/compaction.ts";
import { PluginHost } from "../src/host.ts";
import { createCompactor, type CompactingSession } from "../src/session-compaction.ts";

let dir: string;
let hosts: PluginHost[];
let logs: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-context-reset-"));
	hosts = [];
	logs = [];
});
afterEach(async () => {
	for (const host of hosts) await host.dispose();
	await rm(dir, { recursive: true, force: true });
});

function host(): PluginHost {
	const value = new PluginHost({
		dataDir: dir,
		appDataDir: dir,
		log: (_source, _level, message) => logs.push(message),
		model: {
			complete: async () => "",
			usage: async () => ({ requests: [], providerNames: {}, archived: [] }),
			findImageModel: async () => ({ reason: "none", candidates: [] }),
			image: async () => ({ ok: false, failure: { summary: "" } }),
		},
		notice() {},
	});
	hosts.push(value);
	return value;
}

const entry = (plugin: Plugin) => ({ key: plugin.name, load: async () => plugin });

it("上下文刷新订阅可撤下，停用和 apply 失败时清理，旧 ctx 不能重新注册", async () => {
	const h = host();
	const called = vi.fn();
	let ctx!: PluginContext;
	let off!: () => void;
	await h.load([
		entry({
			name: "test.reset",
			apply(context) {
				ctx = context;
				off = ctx.sessions.onContextReset(called);
			},
		}),
		entry({
			name: "test.failed",
			apply(context) {
				context.sessions.onContextReset(() => called("failed"));
				throw new Error("加载失败");
			},
		}),
	]);
	h.sessionContextReset("s1");
	expect(called.mock.calls).toEqual([["s1"]]);
	off();
	off();
	h.sessionContextReset("s2");
	expect(called).toHaveBeenCalledTimes(1);
	ctx.sessions.onContextReset(called);
	await h.setEnabled("test.reset", false);
	h.sessionContextReset("s3");
	expect(called).toHaveBeenCalledTimes(1);
	expect(() => ctx.sessions.onContextReset(called)).toThrow();
});

it("一个插件的同步异常或异步拒绝不妨碍其他刷新订阅", async () => {
	const h = host();
	const called = vi.fn();
	await h.load([
		entry({
			name: "test.sync",
			apply: (ctx) => {
				ctx.sessions.onContextReset(() => {
					throw new Error("同步坏了");
				});
			},
		}),
		entry({
			name: "test.async",
			apply: (ctx) => {
				ctx.sessions.onContextReset(async () => {
					throw new Error("异步坏了");
				});
			},
		}),
		entry({
			name: "test.good",
			apply: (ctx) => {
				ctx.sessions.onContextReset(called);
			},
		}),
	]);
	h.sessionContextReset("s1");
	await Promise.resolve();
	expect(called).toHaveBeenCalledExactlyOnceWith("s1");
	expect(logs.join("\n")).toContain("同步坏了");
	expect(logs.join("\n")).toContain("异步坏了");
});

async function compactor(result: CompactSummary | Error) {
	const h = host();
	const reset = vi.fn();
	await h.load([
		entry({
			name: "test.compaction",
			apply(ctx) {
				ctx.sessions.onContextReset(reset);
				ctx.hook("context.compact", async () => {
					if (result instanceof Error) throw result;
					return result;
				});
			},
		}),
	]);
	const messages: Message[] = Array.from({ length: 8 }, (_, timestamp) => ({ role: "user", content: [{ type: "text", text: "消息" }], timestamp }));
	messages[3] = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "x".repeat(9000) }], isError: false, timestamp: 3 };
	const record = emptyRecord();
	const session: CompactingSession = { summary: { id: "s1", title: "会话", cwd: dir, createdAt: 0, updatedAt: 0, running: false, kind: "top" }, record };
	const model: ModelConfig = {
		id: "p/m",
		providerId: "p",
		modelId: "m",
		name: "M",
		contextWindow: 100000,
		maxOutputTokens: 10000,
		supportsThinking: false,
		supportsImages: false,
		supportsTools: true,
	};
	const provider: ProviderConfig = {
		id: "p",
		name: "P",
		baseUrl: "http://127.0.0.1",
		api: "anthropic-messages",
		apiKey: "test",
		enabled: true,
		models: [model],
	};
	const onCompacted = vi.fn();
	const save = vi.fn();
	const instance = createCompactor({
		host: h,
		log: () => {},
		emit: () => {},
		saveContext: save,
		messagesOf: async () => messages,
		recordOf: async () => record,
		model: async () => ({ provider, model }),
		onCompacted,
	});
	const context: ModelContext = {
		sessionId: "s1",
		session: { id: "s1", kind: "top" },
		cwd: dir,
		scratchDir: dir,
		model,
		permissionMode: "auto",
		personalization: { tone: "friendly", customInstructions: "" },
		systemPrompt: "",
		sections: [],
		messages,
		tools: [],
	};
	const stop = new AbortController();
	return {
		reset,
		onCompacted,
		save,
		record,
		session,
		stop,
		instance,
		run: () => instance.compact(session, context, { force: true, fork: false }, stop.signal),
	};
}

it("摘要保存后刷新记忆和循环状态", async () => {
	const test = await compactor({ keep: 4, summary: "保留的结论", head: [{ role: "user", content: [{ type: "text", text: "摘要" }], timestamp: 0 }] });
	expect(await test.run()).toMatchObject({ compacted: true, outcome: { ok: true } });
	expect(test.record.compactions).toHaveLength(1);
	expect(test.reset).toHaveBeenCalledExactlyOnceWith("s1");
	expect(test.onCompacted).toHaveBeenCalledExactlyOnceWith(test.session);
	expect(test.save.mock.invocationCallOrder[0]).toBeLessThan(test.reset.mock.invocationCallOrder[0]!);
});

it("实际剪枝刷新，重复同一份视图不再刷新", async () => {
	const test = await compactor({ pruneOnly: true, views: [{ toolCallId: "call", texts: ["节选"] }] });
	expect(await test.run()).toMatchObject({ compacted: true, outcome: { code: "prune-only" } });
	expect(test.record.views).toEqual({ call: ["节选"] });
	expect(test.reset).toHaveBeenCalledExactlyOnceWith("s1");
	expect(test.onCompacted).toHaveBeenCalledExactlyOnceWith(test.session);
	await test.run();
	expect(test.reset).toHaveBeenCalledTimes(1);
});

it.each([
	["无动作", undefined],
	["空剪枝", { pruneOnly: true, views: [] }],
	["无效边界", { keep: 3, summary: "摘要", head: [{ role: "user", content: [{ type: "text", text: "摘要" }], timestamp: 0 }] }],
	["剪枝不存在的结果", { pruneOnly: true, views: [{ toolCallId: "missing", texts: ["节选"] }] }],
	["插件失败", new Error("失败")],
] as const)("%s 不刷新上下文", async (_name, result) => {
	const test = await compactor(result as CompactSummary | Error);
	expect((await test.run()).compacted).toBe(false);
	expect(test.reset).not.toHaveBeenCalled();
	expect(test.onCompacted).not.toHaveBeenCalled();
});

it("取消的压缩不采纳结果、不刷新", async () => {
	const test = await compactor({ keep: 4, summary: "摘要", head: [{ role: "user", content: [{ type: "text", text: "摘要" }], timestamp: 0 }] });
	test.stop.abort();
	expect(await test.run()).toMatchObject({ compacted: false, outcome: { code: "cancelled" } });
	expect(test.record.compactions).toEqual([]);
	expect(test.reset).not.toHaveBeenCalled();
	expect(test.onCompacted).not.toHaveBeenCalled();
});

it("拒收后的工具输出裁剪也刷新，无内容可裁时不刷新", async () => {
	const test = await compactor(undefined);
	expect(await test.instance.withhold(test.session)).toBe(true);
	expect(test.reset).toHaveBeenCalledExactlyOnceWith("s1");
	expect(test.onCompacted).toHaveBeenCalledExactlyOnceWith(test.session);
	expect(await test.instance.withhold(test.session)).toBe(false);
	expect(test.reset).toHaveBeenCalledTimes(1);
});
