/**
 * 交给系统打开会不会变成运行一个程序（main/security-policy.ts）。会的改成在文件夹里指出来，见 files.ts 的 openPathSafely。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isRemoteOrDevicePath, opensAsProgram } from "../src/main/security-policy.ts";

const FILE = { isDirectory: false, executable: false };

test("会被运行的类型：各平台按各自的扩展名", () => {
	const cases: Array<[string, string]> = [
		["/Users/me/Downloads/run.command", "darwin"],
		["/Users/me/x.scpt", "darwin"],
		["/Users/me/install.sh", "darwin"],
		["C:\\Users\\me\\a.exe", "win32"],
		["C:\\Users\\me\\a.BAT", "win32"],
		["C:\\Users\\me\\a.cmd", "win32"],
		["C:\\Users\\me\\a.ps1", "win32"],
		["C:\\Users\\me\\a.lnk", "win32"],
		["C:\\Users\\me\\a.js", "win32"],
		["C:\\Users\\me\\a.py", "win32"],
		// Windows 吞掉结尾的点和空格，`a.exe.` 跑的就是 `a.exe`。
		["C:\\Users\\me\\a.exe.", "win32"],
		["C:\\Users\\me\\a.exe . ", "win32"],
		// 备用数据流。
		["C:\\Users\\me\\a.txt:evil.exe", "win32"],
	];
	for (const [path, platform] of cases) assert.equal(opensAsProgram(path, FILE, platform), true, `${platform} ${path}`);
});

test("文档照常用默认应用打开", () => {
	const cases: Array<[string, string]> = [
		["/Users/me/report.pdf", "darwin"],
		// macOS 上 .js 只是文本；Windows 上它归 Windows Script Host。
		["/Users/me/app.js", "darwin"],
		["C:\\Users\\me\\report.docx", "win32"],
		["C:\\Users\\me\\notes.txt", "win32"],
		["C:\\Users\\me\\README", "win32"],
	];
	for (const [path, platform] of cases) assert.equal(opensAsProgram(path, FILE, platform), false, `${platform} ${path}`);
});

test("目录只有 .app 这类包才算程序；Windows 上没有扩展名的不看可执行位", () => {
	const dir = { isDirectory: true, executable: true };
	assert.equal(opensAsProgram("/Applications/Calculator.app", dir, "darwin"), true);
	assert.equal(opensAsProgram("/Users/me/project", dir, "darwin"), false);
	assert.equal(opensAsProgram("C:\\Users\\me\\tools.exe", dir, "win32"), false);
	assert.equal(opensAsProgram("/Users/me/bin/deploy", { isDirectory: false, executable: true }, "darwin"), true);
	assert.equal(opensAsProgram("C:\\Users\\me\\deploy", { isDirectory: false, executable: true }, "win32"), false);
});

test("网络共享和设备路径两种斜杠都认", () => {
	for (const path of ["\\\\server\\share\\a.png", "//server/share/a.png", "\\\\?\\C:\\a.txt", "\\\\.\\pipe\\x"])
		assert.equal(isRemoteOrDevicePath(path), true, path);
	for (const path of ["C:\\a.txt", "/Users/me/a.txt", "\\a.txt"]) assert.equal(isRemoteOrDevicePath(path), false, path);
});
