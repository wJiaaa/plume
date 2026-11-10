/**
 * Windows 上用户插件的原生模块复制一份再加载（main/native-cache.ts）。
 *
 * 在 mac 上跑：平台写成 win32，读文件、复制文件换成记账的假实现，dlopen 换成记下它收到的路径。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type NativeCacheIo, nativeLoadPath, redirectNativeLoads } from "../src/main/native-cache.ts";

const ROOTS = ["C:\\Users\\me\\.plume\\plugins", "D:\\dev\\my-plugins"];
const CACHE = "C:\\Users\\me\\.plume\\native-cache";

function fakeIo(existing: string[] = []) {
	const placed: { files: string[]; dir: string }[] = [];
	const hashed: string[] = [];
	const io: NativeCacheIo = {
		hash: (file) => {
			hashed.push(file);
			return file.includes("v2") ? "bbb" : "aaa";
		},
		exists: (path) => existing.includes(path) || placed.some(({ dir }) => path.startsWith(`${dir}\\`)),
		siblings: (file) => (file.endsWith("pty.node") ? [file.replace("pty.node", "winpty.dll"), file.replace("pty.node", "winpty-agent.exe")] : []),
		place: (files, dir) => void placed.push({ files, dir }),
	};
	return { io, placed, hashed };
}

const options = (io: NativeCacheIo, platform = "win32") => ({ platform, roots: ROOTS, cacheDir: CACHE, io, warn: () => {} });

test("用户插件里的 .node 连同旁边的 dll、exe 复制到按内容命名的目录，加载那一份", () => {
	const { io, placed } = fakeIo();
	const pty = "C:\\Users\\me\\.plume\\plugins\\terminal\\dist\\node_modules\\node-pty\\prebuilds\\win32-x64\\pty.node";
	assert.equal(nativeLoadPath(`\\\\?\\${pty}`, options(io)), `\\\\?\\${CACHE}\\aaa\\pty.node`);
	assert.deepEqual(placed, [{ dir: `${CACHE}\\aaa`, files: [pty, pty.replace("pty.node", "winpty.dll"), pty.replace("pty.node", "winpty-agent.exe")] }]);
});

test("已经复制过的不再复制；内容变了换一个目录", () => {
	const { io, placed } = fakeIo([`${CACHE}\\aaa\\koffi.node`]);
	const file = "D:\\dev\\my-plugins\\sandbox\\dist\\koffi.node";
	assert.equal(nativeLoadPath(file, options(io)), `\\\\?\\${CACHE}\\aaa\\koffi.node`);
	assert.equal(placed.length, 0);
	assert.equal(nativeLoadPath("D:\\dev\\my-plugins\\sandbox-v2\\dist\\koffi.node", options(io)), `\\\\?\\${CACHE}\\bbb\\koffi.node`);
	assert.equal(placed.length, 1);
});

test("内置插件、插件目录外的、不是 .node 的、不在 Windows 上的都原样加载", () => {
	const { io, hashed } = fakeIo();
	for (const file of [
		"C:\\Program Files\\Plume\\resources\\builtin\\sandbox\\dist\\node_modules\\koffi.node",
		"C:\\Users\\me\\.plume\\plugins-other\\x.node",
		"C:\\Users\\me\\.plume\\plugins\\terminal\\dist\\index.mjs",
	]) {
		assert.equal(nativeLoadPath(file, options(io)), file);
	}
	assert.equal(
		nativeLoadPath("/Users/me/.plume/plugins/terminal/pty.node", { ...options(io, "darwin"), roots: ["/Users/me/.plume/plugins"] }),
		"/Users/me/.plume/plugins/terminal/pty.node",
	);
	assert.deepEqual(hashed, []);
});

test("插件目录按 Windows 的规矩比较：大小写不同、带命名空间前缀的也认", () => {
	const { io } = fakeIo();
	assert.equal(nativeLoadPath("\\\\?\\c:\\users\\ME\\.plume\\PLUGINS\\lsp\\a.node", options(io)), `\\\\?\\${CACHE}\\aaa\\a.node`);
});

test("复制不了就加载原文件，并说一声", () => {
	const warnings: string[] = [];
	const io: NativeCacheIo = {
		...fakeIo().io,
		place: () => {
			throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		},
	};
	const file = "C:\\Users\\me\\.plume\\plugins\\knowledge\\dist\\lancedb.node";
	assert.equal(nativeLoadPath(file, { ...options(io), warn: (message) => warnings.push(message) }), file);
	assert.equal(warnings.length, 1);
});

test("redirectNativeLoads 只在 Windows 上换掉 dlopen，flags 原样转过去", () => {
	const calls: unknown[][] = [];
	const target = { dlopen: (...args: unknown[]) => void calls.push(args) };
	const { io } = fakeIo();
	redirectNativeLoads(target, options(io));
	const module = {};
	target.dlopen(module, "C:\\Users\\me\\.plume\\plugins\\terminal\\pty.node");
	target.dlopen(module, "C:\\Windows\\other.node", 1);
	assert.deepEqual(calls, [
		[module, `\\\\?\\${CACHE}\\aaa\\pty.node`],
		[module, "C:\\Windows\\other.node", 1],
	]);

	const mac = { dlopen: (..._args: unknown[]) => {} };
	const original = mac.dlopen;
	redirectNativeLoads(mac, options(io, "darwin"));
	assert.equal(mac.dlopen, original);
});
