/**
 * `plume-plugin` 的启动脚本（main/plugin-cli.ts）：sh 一份，Windows 再一份 .cmd。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { cmdPath, pluginCliScripts } from "../src/main/plugin-cli.ts";

test("sh：路径用单引号包住，空格、$、单引号都不被 shell 解释", () => {
	const { sh } = pluginCliScripts("/Applications/My Plume.app/Contents/MacOS/Plume", "/x/it's $HOME/plume-plugin.mjs", {});
	assert.equal(sh, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/Applications/My Plume.app/Contents/MacOS/Plume' '/x/it'\\''s $HOME/plume-plugin.mjs' "$@"\n`);
});

test("cmd：变量只留在脚本里，参数原样转发，行尾是 CRLF", () => {
	const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" };
	const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\Plume\\Plume.exe";
	const entry = "C:\\Users\\me\\AppData\\Local\\Programs\\Plume\\resources\\plugin-sdk\\bin\\plume-plugin.mjs";
	const { cmd } = pluginCliScripts(exe, entry, env);
	assert.equal(
		cmd,
		[
			"@echo off",
			"setlocal",
			'set "ELECTRON_RUN_AS_NODE=1"',
			'"%LOCALAPPDATA%\\Programs\\Plume\\Plume.exe" "%LOCALAPPDATA%\\Programs\\Plume\\resources\\plugin-sdk\\bin\\plume-plugin.mjs" %*',
			"",
		].join("\r\n"),
	);
});

test("cmd 路径：用户目录写成变量，免得中文用户名按 OEM 代码页读成乱码；% 写成 %%", () => {
	const env = { LOCALAPPDATA: "C:\\Users\\张三\\AppData\\Local\\", USERPROFILE: "C:\\Users\\张三" };
	assert.equal(cmdPath("c:\\users\\张三\\AppData\\Local\\Programs\\Plume\\Plume.exe", env), '"%LOCALAPPDATA%\\Programs\\Plume\\Plume.exe"');
	assert.equal(cmdPath("C:\\Users\\张三\\Plume 100%\\Plume.exe", env), '"%USERPROFILE%\\Plume 100%%\\Plume.exe"');
	assert.equal(cmdPath("D:\\Apps\\50%\\Plume.exe", env), '"D:\\Apps\\50%%\\Plume.exe"');
	// 只认整段目录，`C:\Users\张三2` 不是 `C:\Users\张三` 下面的。
	assert.equal(cmdPath("C:\\Users\\张三2\\Plume.exe", { USERPROFILE: "C:\\Users\\张三" }), '"C:\\Users\\张三2\\Plume.exe"');
});
