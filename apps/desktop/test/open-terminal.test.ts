/**
 * 「在终端打开」「在终端运行」交给哪个终端插件（renderer/files/open-terminal.ts）：最近登记的接，撤下后退回前一个，
 * 没有终端或打开失败时提示。
 */

import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { openInTerminal, registerTerminalOpener, registerTerminalRunner, runInTerminal } from "../src/renderer/files/open-terminal.ts";
import { currentNotices, dismissNotice } from "../src/renderer/toast/store.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanups.splice(0).reverse()) dispose();
	for (const notice of currentNotices()) dismissNotice(notice.id);
});

const failing = async () => {
	throw new Error("terminal unavailable");
};

test("最近注册的终端接请求，同插件更新后旧清理不撤掉新入口，停用恢复前一个", async () => {
	const first = vi.fn(),
		second = vi.fn(),
		updated = vi.fn();
	const old = registerTerminalOpener("first", first);
	cleanups.push(old, registerTerminalOpener("second", second));
	const newest = registerTerminalOpener("first", updated);
	cleanups.push(newest);
	old();
	await openInTerminal("session-a", "/work/a");
	assert.deepEqual(updated.mock.calls.at(-1), ["/work/a", "session-a"]);
	assert.equal(first.mock.calls.length, 0);
	assert.equal(second.mock.calls.length, 0);
	newest();
	await openInTerminal("session-b", "/work/b");
	assert.deepEqual(second.mock.calls.at(-1), ["/work/b", "session-b"]);
});

test("没有终端或打开失败都给出提示", async () => {
	await openInTerminal("session", "/work");
	assert.partialDeepStrictEqual(currentNotices().at(-1), { level: "warn", message: "终端插件没有加载。" });
	cleanups.push(registerTerminalOpener("failed", failing));
	await openInTerminal("session", "/work");
	assert.partialDeepStrictEqual(currentNotices().at(-1), { level: "error", message: "terminal unavailable" });
});

test("同一个回调重新登记时，旧清理也不能撤掉最新登记", async () => {
	const open = vi.fn();
	const old = registerTerminalOpener("same", open);
	cleanups.push(old, registerTerminalOpener("same", open));
	old();
	await openInTerminal("session", "/work");
	assert.deepEqual(open.mock.calls.at(-1), ["/work", "session"]);
});

test("「在终端运行」交给最近登记的终端，带着命令和会话；没有终端时提示", async () => {
	await runInTerminal("session", "ls");
	assert.partialDeepStrictEqual(currentNotices().at(-1), { level: "warn", message: "终端插件没有加载。" });
	const first = vi.fn(),
		second = vi.fn();
	cleanups.push(registerTerminalRunner("first", first));
	const latest = registerTerminalRunner("second", second);
	cleanups.push(latest);
	await runInTerminal("session-a", "pnpm dev");
	assert.deepEqual(second.mock.calls.at(-1), ["pnpm dev", "session-a"]);
	latest();
	await runInTerminal("session-b", "ls");
	assert.deepEqual(first.mock.calls.at(-1), ["ls", "session-b"]);
	cleanups.push(registerTerminalRunner("failed", failing));
	await runInTerminal("session", "ls");
	assert.partialDeepStrictEqual(currentNotices().at(-1), { level: "error", message: "terminal unavailable" });
});
