/**
 * Windows 上跑哪个 git。给一个不带路径的名字，进程启动器会先在工作目录——也就是仓库——里找，一个顶层带着自己 `git.exe`
 * 的检出每次刷新都会被面板执行。所以那边自己按 PATH 找，用完整路径跑。平台和环境都是参数，在哪台机器上都能查。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { gitProgram } from "../src/git.ts";

test("Windows 上用 PATH 上的 git，从不用仓库里放着的那个", () => {
	const repo = "C:\\work\\evil";
	const onDisk = new Set(["C:\\work\\evil\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe"]);
	const found = gitProgram("win32", { Path: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd" }, (path) => onDisk.has(path));
	assert.equal(found, "C:\\Program Files\\Git\\cmd\\git.exe");
	assert.ok(!found?.startsWith(repo));
});

test("PATH 里的相对目录不把工作目录带回来", () => {
	// PATH 上的 `.` 会按进程碰巧在的目录解析。
	const found = gitProgram("win32", { PATH: ".;C:\\Git\\cmd" }, (path) => path === "git.exe" || path === "C:\\Git\\cmd\\git.exe");
	assert.equal(found, "C:\\Git\\cmd\\git.exe");
});

test("git.cmd 不当 git；根本没有 git 时是 null，不去猜", () => {
	// 启动器不会为 `git` 去跑 `.cmd`，execFile 也起不来它。
	assert.equal(
		gitProgram("win32", { PATH: "C:\\shims" }, (path) => path === "C:\\shims\\git.cmd"),
		null,
	);
	assert.equal(
		gitProgram("win32", { PATH: "C:\\Windows" }, () => false),
		null,
	);
});

test("别处照旧按名字跑 git", () => {
	assert.equal(
		gitProgram("darwin", { PATH: "/usr/bin" }, () => false),
		"git",
	);
	assert.equal(
		gitProgram("linux", {}, () => false),
		"git",
	);
});
