/**
 * @plumeai/plugin-sdk/testing：假 ctx 实现的那几样要和本体说的一样（钩子按 order 串、清理后登记先执行、设置合并和 normalize、
 * 删会话丢掉 sessionStore），没实现的成员一碰就说清楚缺什么。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "vitest";
import { loadPlugin } from "../lib/testing.mjs";

test("钩子：order 小的在外层，相同按注册先后，最里层是测试给的", async () => {
	const seen = [];
	const layer = (label) => async (input, next) => {
		seen.push(label);
		return next({ ...input, path: [...input.path, label] });
	};
	const loaded = await loadPlugin({
		name: "test.hooks",
		apply(ctx) {
			ctx.hook("prompt.submit", layer("b"));
			ctx.hook("prompt.submit", layer("outer"), { order: -10 });
			ctx.hook("prompt.submit", layer("c"));
		},
	});
	const verdict = await loaded.hook("prompt.submit", { path: [] }, async (input) => ({ block: false, path: input.path }));
	assert.deepEqual(seen, ["outer", "b", "c"]);
	assert.deepEqual(verdict, { block: false, path: ["outer", "b", "c"] });
	await loaded.dispose();
});

test("工具：run 带默认的会话和目录；没给的能力碰到就报出全名", async () => {
	const loaded = await loadPlugin({
		name: "test.tools",
		apply(ctx) {
			ctx.tools.register({
				name: "where",
				description: "",
				parameters: { type: "object", properties: {} },
				execute: async (_args, run) => ({ output: `${run.sessionId} ${run.session.kind}` }),
			});
			ctx.tools.register({
				name: "asks",
				description: "",
				parameters: { type: "object", properties: {} },
				execute: async (_args, run) => ({ output: await run.ask({ kind: "tool", title: "?" }) }),
			});
		},
	});
	assert.deepEqual(await loaded.runTool("where"), { output: "session top" });
	await assert.rejects(loaded.runTool("asks"), /run 没有 ask：经 runTool 的第三个参数给一份/);
	assert.deepEqual(await loaded.runTool("asks", {}, { ask: async () => "once" }), { output: "once" });
	assert.throws(() => loaded.tool("missing"), /没有注册工具 missing；注册了的：where、asks/);
	assert.throws(() => loaded.ctx.model, /ctx 没有 model：经 loadPlugin 的 options.ctx 给一份/);
	await loaded.dispose();
});

test("设置：存着的和 defaults 合并再过 normalize；sessions 的覆盖和默认的订阅并存", async () => {
	const loaded = await loadPlugin(
		{
			name: "test.settings",
			async apply(ctx) {
				const settings = await ctx.settings({ limit: 1, mode: "a" }, (saved) => ({ ...saved, limit: Math.min(Number(saved.limit), 10) }));
				ctx.sessions.onDeleted(() => settings.set({ mode: "deleted" }));
				ctx.sessionStore("seen", 0).set("s1", 3);
				ctx.serve({ title: (id) => ctx.sessions.get(id).then((session) => session?.title) });
			},
		},
		{ settings: { limit: 50 }, ctx: { sessions: { get: async (id) => ({ id, title: "T" }) } } },
	);
	assert.deepEqual(loaded.settings?.get(), { limit: 10, mode: "a" });
	assert.equal(await loaded.api.title("s1"), "T");
	assert.equal(loaded.sessionStore("seen").get("s1"), 3);
	await loaded.emit("onDeleted", "s1");
	assert.equal(loaded.settings?.get().mode, "deleted");
	assert.equal(loaded.sessionStore("seen").get("s1"), 0);
	assert.throws(() => loaded.ctx.sessions.messages, /ctx.sessions 没有 messages/);
	await loaded.dispose();
});

test("服务：没写进 inject 的不给用；dispose 按后登记先执行跑清理、删掉临时目录", async () => {
	const order = [];
	let dataDir;
	const loaded = await loadPlugin(
		{
			name: "test.effects",
			inject: ["terminal.exec"],
			apply(ctx) {
				dataDir = ctx.dataDir;
				assert.ok(existsSync(dataDir));
				assert.equal(ctx.use("terminal.exec").tag, "fake");
				assert.throws(() => ctx.use("session.plan"), /要先写进插件的 inject/);
				ctx.effect(() => void order.push("first"));
				ctx.effect(() => void order.push("second"));
			},
		},
		{ services: { "terminal.exec": { tag: "fake" } } },
	);
	await loaded.dispose();
	assert.deepEqual(order, ["second", "first"]);
	assert.ok(!existsSync(dataDir));
});
