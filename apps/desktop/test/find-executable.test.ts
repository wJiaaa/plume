/**
 * 按平台自己的规矩在 PATH 里找程序（main/find-executable.ts）。平台是参数，Windows 的规矩在任何机器上都能验：
 * 磁盘上是 `code.cmd` 而不是 `code`、从资源管理器启动给的是 `Path`、`wt.exe` 这种执行别名 `stat` 不了。
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateNames, envValue, findExecutable, searchDirs } from "../src/main/find-executable.ts";

test("Windows 按 PATHEXT 挨个试扩展名：磁盘上的是 gofmt.exe", () => {
	const onDisk = new Set(["C:\\Go\\bin\\gofmt.exe"]);
	const found = findExecutable("gofmt", {
		platform: "win32",
		env: { PATH: "C:\\Windows;C:\\Go\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
		isExecutable: (path) => onDisk.has(path),
	});
	assert.equal(found, "C:\\Go\\bin\\gofmt.exe");
});

test("已经带扩展名的按写的找，没带的不找裸名字", () => {
	assert.deepEqual(candidateNames("code.cmd", "win32", { PATHEXT: ".EXE;.CMD" }), ["code.cmd"]);
	assert.deepEqual(candidateNames("wt.exe", "win32", {}), ["wt.exe"]);
	assert.deepEqual(candidateNames("black", "win32", { PATHEXT: ".EXE;.CMD" }), ["black.exe", "black.cmd"]);
});

test("没有 PATHEXT 时用系统的缺省值", () => {
	assert.deepEqual(candidateNames("ruff", "win32", {}), ["ruff.com", "ruff.exe", "ruff.bat", "ruff.cmd"]);
});

test("Windows 上 Path 和 PATH 是同一个变量，别处大小写算数", () => {
	assert.equal(envValue({ Path: "C:\\bin" }, "PATH", "win32"), "C:\\bin");
	assert.equal(envValue({ Path: "/bin" }, "PATH", "linux"), undefined);
	const onDisk = new Set(["C:\\Tools\\shfmt.exe"]);
	assert.equal(findExecutable("shfmt", { platform: "win32", env: { Path: "C:\\Tools" }, isExecutable: (path) => onDisk.has(path) }), "C:\\Tools\\shfmt.exe");
});

test("Windows PATH 里带引号的一项去掉引号再找，重复的只找一次", () => {
	assert.deepEqual(searchDirs("win32", { PATH: '"C:\\Program Files\\Go\\bin";;C:\\x;C:\\x' }), ["C:\\Program Files\\Go\\bin", "C:\\x"]);
});

test("本身是路径的在原处查，不去搜", () => {
	const onDisk = new Set(["C:\\Apps\\tool.exe"]);
	assert.equal(findExecutable("C:\\Apps\\tool", { platform: "win32", env: {}, isExecutable: (path) => onDisk.has(path) }), "C:\\Apps\\tool.exe");
	assert.equal(findExecutable("/opt/x/tool", { platform: "linux", env: { PATH: "/usr/bin" }, isExecutable: () => false }), null);
});

test("真磁盘上：没有可执行位的不算程序，目录也不算", { skip: process.platform === "win32" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "plume-which-"));
	try {
		writeFileSync(join(dir, "plain"), "#!/bin/sh\n");
		writeFileSync(join(dir, "runnable"), "#!/bin/sh\n");
		chmodSync(join(dir, "runnable"), 0o755);
		const env = { PATH: dir };
		assert.equal(findExecutable("plain", { env }), null);
		assert.equal(findExecutable("runnable", { env }), join(dir, "runnable"));
		assert.equal(findExecutable(".", { env }), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
