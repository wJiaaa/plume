/**
 * 「在终端打开」「在终端运行」交给哪个终端插件（renderer/files/open-terminal.ts）：最近登记的接，撤下后退回前一个，
 * 没有终端或打开失败时提示。
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, mock, test } from "node:test";

// open-terminal.ts 只从 @plume/ui 拿 translate；包入口是 TSX，node --test 加载不了，把这个说明符解析成只转出同一份 translate 的模块。
const translate = new URL("../../../packages/client/ui/src/i18n/translate.ts", import.meta.url).href;
registerHooks({
	resolve: (specifier, context, next) =>
		specifier === "@plume/ui"
			? { url: `data:text/javascript,export { translate } from ${JSON.stringify(translate)};`, shortCircuit: true }
			: next(specifier, context),
});
const { openInTerminal, registerTerminalOpener, registerTerminalRunner, runInTerminal } = await import("../src/renderer/files/open-terminal.ts");
const { currentNotices, dismissNotice } = await import("../src/renderer/toast/store.ts");

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanups.splice(0).reverse()) dispose();
	for (const notice of currentNotices()) dismissNotice(notice.id);
});

const failing = async () => {
	throw new Error("terminal unavailable");
};

test("最近注册的终端接请求，同插件更新后旧清理不撤掉新入口，停用恢复前一个", async () => {
	const first = mock.fn(),
		second = mock.fn(),
		updated = mock.fn();
	const old = registerTerminalOpener("first", first);
	cleanups.push(old, registerTerminalOpener("second", second));
	const newest = registerTerminalOpener("first", updated);
	cleanups.push(newest);
	old();
	await openInTerminal("session-a", "/work/a");
	assert.deepEqual(updated.mock.calls.at(-1)?.arguments, ["/work/a", "session-a"]);
	assert.equal(first.mock.callCount(), 0);
	assert.equal(second.mock.callCount(), 0);
	newest();
	await openInTerminal("session-b", "/work/b");
	assert.deepEqual(second.mock.calls.at(-1)?.arguments, ["/work/b", "session-b"]);
});

test("没有终端或打开失败都给出提示", async () => {
	await openInTerminal("session", "/work");
	assert.partialDeepStrictEqual(currentNotices().at(-1), { level: "warn", message: "请先安装并启用终端插件。" });
	cleanups.push(registerTerminalOpener("failed", failing));
	await openInTerminal("session", "/work");
	assert.partialDeepStrictEqual(currentNotices().at(-1), { level: "error", message: "terminal unavailable" });
});

test("同一个回调重新登记时，旧清理也不能撤掉最新登记", async () => {
	const open = mock.fn();
	const old = registerTerminalOpener("same", open);
	cleanups.push(old, registerTerminalOpener("same", open));
	old();
	await openInTerminal("session", "/work");
	assert.deepEqual(open.mock.calls.at(-1)?.arguments, ["/work", "session"]);
});

test("「在终端运行」交给最近登记的终端，带着命令和会话；没有终端时提示", async () => {
	await runInTerminal("session", "ls");
	assert.partialDeepStrictEqual(currentNotices().at(-1), { level: "warn", message: "请先安装并启用终端插件。" });
	const first = mock.fn(),
		second = mock.fn();
	cleanups.push(registerTerminalRunner("first", first));
	const latest = registerTerminalRunner("second", second);
	cleanups.push(latest);
	await runInTerminal("session-a", "pnpm dev");
	assert.deepEqual(second.mock.calls.at(-1)?.arguments, ["pnpm dev", "session-a"]);
	latest();
	await runInTerminal("session-b", "ls");
	assert.deepEqual(first.mock.calls.at(-1)?.arguments, ["ls", "session-b"]);
	cleanups.push(registerTerminalRunner("failed", failing));
	await runInTerminal("session", "ls");
	assert.partialDeepStrictEqual(currentNotices().at(-1), { level: "error", message: "terminal unavailable" });
});
