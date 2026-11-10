/**
 * Windows 上起 stdio 服务器要多管的两件事。只在 Windows 上看得见，测试跑在别的系统上：把 `process.platform` 换成 win32，
 * 截下 `execFile` 看它拿到了什么。
 */

import assert from "node:assert/strict";
import childProcess, { ChildProcess, type ExecFileOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { stdioEnv, TreeKillingStdioTransport } from "../src/stdio.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

function asWindows(t: TestContext): void {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform);
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", platform));
}

test("Windows 上服务器自己的 Path 替掉继承来的 PATH，不和它并排", (t) => {
	asWindows(t);
	// `{ ...process.env }` 在 Windows 上拼作 `Path`，SDK 又在底下垫一份 `PATH`；子进程两个都拿到时读哪个由不得我们。
	const env = stdioEnv({ Path: "C:\\inherited", windir: "C:\\Windows" }, { path: "C:\\configured" });
	assert.deepEqual(
		Object.keys(env).filter((key) => key.toUpperCase() === "PATH"),
		["PATH"],
	);
	assert.equal(env.PATH, "C:\\configured");
	assert.equal(env.windir, "C:\\Windows");
});

test("别处名字分大小写，原样放着", () => {
	if (process.platform === "win32") return;
	assert.deepEqual(stdioEnv({ PATH: "/usr/bin" }, { Path: "/opt" }), { PATH: "/usr/bin", Path: "/opt" });
});

test("Windows 上关服务器连整棵进程树一起结束，不只是 cmd.exe", async (t) => {
	const transport = new TreeKillingStdioTransport({ command: process.execPath, args: [FIXTURE], stderr: "pipe" });
	await transport.start();
	const pid = transport.pid;
	assert.ok(pid);
	const calls: { file: string; args: readonly string[]; options: ExecFileOptions }[] = [];
	const exec = t.mock.method(
		childProcess,
		"execFile",
		(file: string, args: readonly string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
			calls.push({ file, args, options });
			callback(null, "", "");
			return new ChildProcess();
		},
	);
	syncBuiltinESMExports();
	t.after(() => {
		exec.mock.restore();
		syncBuiltinESMExports();
	});
	// 只在关的这一下当 Windows：SDK 在那边经 `cmd.exe /c` 起 `npx`，自己的 close 只 kill 那个 shell。
	asWindows(t);
	await transport.close();
	assert.deepEqual(
		calls.map(({ file, args }) => [file, args]),
		[["taskkill", ["/PID", String(pid), "/T", "/F"]]],
	);
	// agent 进程没有控制台，不带它每停一次就闪一个黑窗口。
	assert.equal(calls[0]?.options.windowsHide, true);
});
