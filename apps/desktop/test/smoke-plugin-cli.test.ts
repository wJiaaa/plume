/**
 * 冒烟跑 `plume-plugin` 启动脚本（main/smoke-plugin-cli.ts）：Windows 上那是 `.cmd`，要经 cmd.exe 起，路径里有空格也不能拆散。
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pluginCliLine, runPluginCli } from "../src/main/smoke-plugin-cli.ts";

test("交给 cmd /s /c 的一行：每个词各自加引号，整行再包一层", () => {
	assert.equal(
		pluginCliLine("C:\\Users\\me\\smoke dir\\bin\\plume-plugin.cmd", ["install", "C:\\repo\\plugins\\git", "--to", "C:\\Users\\me\\smoke dir\\plugins"]),
		'""C:\\Users\\me\\smoke dir\\bin\\plume-plugin.cmd" "install" "C:\\repo\\plugins\\git" "--to" "C:\\Users\\me\\smoke dir\\plugins""',
	);
});

test("启动脚本收到的参数原样是传进去的那些，路径里有空格也一样", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "plume smoke cli "));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const windows = process.platform === "win32";
	const cli = join(dir, windows ? "plume-plugin.cmd" : "plume-plugin");
	await writeFile(cli, windows ? "@echo off\r\necho [%~1] [%~2] [%~3]\r\n" : '#!/bin/sh\nprintf "[%s] [%s] [%s]\\n" "$1" "$2" "$3"\n');
	await chmod(cli, 0o755);
	const target = join(dir, "plugins here");
	const { stdout } = await runPluginCli(cli, ["install", target, "--to"]);
	assert.equal(stdout.trim(), `[install] [${target}] [--to]`);
});
