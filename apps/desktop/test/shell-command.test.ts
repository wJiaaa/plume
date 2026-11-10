import assert from "node:assert/strict";
import { test } from "node:test";
import { commandFrom, isShellFence } from "../src/renderer/markdown/shell-command.ts";

test("只有 shell 一类的围栏有「在终端运行」", () => {
	for (const label of ["bash", "sh", "zsh", "shell", "console", "terminal"]) assert.equal(isShellFence(label), true);
	for (const label of ["ts", "python", "text", "powershell", ""]) assert.equal(isShellFence(label), false);
});

test("交给终端的命令去掉提示符、注释和空行", () => {
	assert.equal(commandFrom("$ pnpm install\n\n# 再起开发服务\n> pnpm dev  \n"), "pnpm install\npnpm dev");
	assert.equal(commandFrom("  $ ls -la"), "ls -la");
	assert.equal(commandFrom("# 只有注释\n\n"), "");
	assert.equal(commandFrom("echo $HOME"), "echo $HOME");
});
