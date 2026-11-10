/**
 * 回复里写的相对地址拼成这台机器上的路径。
 *
 * 单独成文件：这是不用 `node:path`（渲染进程没有）的路径字符串运算，正是在 macOS 上通过、在 Windows 上
 * 悄悄出错的那种代码。两种分隔符都在这里试，不只试跑测试那台机器用的那一种。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { directoryOf, isAbsolutePath, relativeTo, resolveAsset } from "../src/renderer/markdown/assets.ts";

test("相对路径落在目录里", () => {
	assert.equal(resolveAsset("/home/me/repo", "assets/logo.png"), "/home/me/repo/assets/logo.png");
	assert.equal(resolveAsset("/home/me/repo", "./assets/logo.png"), "/home/me/repo/assets/logo.png");
});

test("`..` 往上走，结果里不留 `..`", () => {
	// 不是边界，读文件的一侧还会再查；但一条路径在这里和那里读出两种意思，检查就是这样被绕过去的。
	assert.equal(resolveAsset("/home/me/repo/docs", "../assets/logo.png"), "/home/me/repo/assets/logo.png");
	assert.equal(resolveAsset("/home/me/repo/docs", "../../x.png"), "/home/me/x.png");
});

test("绝对路径原样取用", () => {
	assert.equal(resolveAsset("/home/me/repo", "/etc/hosts.png"), "/etc/hosts.png");
});

test("Windows 路径保留自己的分隔符", () => {
	assert.equal(resolveAsset("C:\\Users\\me\\repo", "assets/logo.png"), "C:\\Users\\me\\repo\\assets\\logo.png");
	assert.equal(resolveAsset("C:\\Users\\me\\repo\\docs", "../logo.png"), "C:\\Users\\me\\repo\\logo.png");
	assert.equal(resolveAsset("C:\\Users\\me", "C:\\other\\a.png"), "C:\\other\\a.png");
});

test("UNC 共享保留开头的两个分隔符", () => {
	assert.equal(resolveAsset("\\\\server\\share", "a.png"), "\\\\server\\share\\a.png");
});

test("别的机器上的文件拒掉，除非目录本身就在那个共享上", () => {
	// 在 Windows 上光是解析一下这种路径，就会连上那台机器、递上 NTLM 凭据。
	assert.equal(resolveAsset("C:\\proj", "\\\\attacker.example\\share\\a.png"), null);
	assert.equal(resolveAsset("/repo", "\\\\evil\\s\\a.png"), null);
	assert.equal(resolveAsset("/", "\\\\evil\\s\\a.png"), null);
	assert.equal(resolveAsset("C:\\proj", "\\\\?\\C:\\a.png"), null);
	assert.equal(resolveAsset("C:\\proj", "\\\\.\\pipe\\x"), null);
	// 相对 `/` 时，一个 `\evil` 成了 `/\evil`——开头又是两个分隔符。
	assert.equal(resolveAsset("/", "\\evil\\s\\a.png"), null);
	// 同一个共享是自己的地方；走到隔壁的共享不是。
	assert.equal(resolveAsset("\\\\Server\\Share\\docs", "\\\\server\\share\\img\\a.png"), "\\\\server\\share\\img\\a.png");
	assert.equal(resolveAsset("\\\\server\\share\\docs", "../../other/a.png"), null);
});

test("写给 GitHub 的部分去掉，磁盘不读它", () => {
	assert.equal(resolveAsset("/repo", "assets/logo.png?raw=true"), "/repo/assets/logo.png");
	assert.equal(resolveAsset("/repo", "assets/logo.png#gh-dark-mode-only"), "/repo/assets/logo.png");
	assert.equal(resolveAsset("/repo", "assets/my%20logo.png"), "/repo/assets/my logo.png");
});

test("不是文件系统路径的一律拒掉", () => {
	for (const src of ["https://example.com/a.png", "http://x/a.png", "data:image/png;base64,AA", "//cdn/x.png", "#anchor", ""]) {
		assert.equal(resolveAsset("/repo", src), null, src);
	}
});

test("没有目录就没有拼的基准", () => {
	assert.equal(resolveAsset(undefined, "assets/logo.png"), null);
});

test("什么算绝对路径", () => {
	for (const path of ["/a", "C:\\a", "c:/a", "\\\\server\\share"]) assert.ok(isAbsolutePath(path), path);
	for (const path of ["a/b", "./a", "../a", "C:a"]) assert.ok(!isAbsolutePath(path), path);
});

test("文件所在的目录，两种平台", () => {
	assert.equal(directoryOf("/home/me/repo/README.md"), "/home/me/repo");
	assert.equal(directoryOf("C:\\Users\\me\\README.md"), "C:\\Users\\me");
	// 根是 `/`，不是空串——根下的文件也有目录。
	assert.equal(directoryOf("/README.md"), "/");
	assert.equal(directoryOf("README.md"), "");
});

test("写在目录下的那一段", () => {
	assert.equal(relativeTo("/repo", "/repo/src/a.ts"), "src/a.ts");
	assert.equal(relativeTo("/repo/", "/repo/src/a.ts"), "src/a.ts");
	assert.equal(relativeTo("C:\\repo", "C:\\repo\\src\\a.ts"), "src\\a.ts");
	// 名字以目录名开头的兄弟目录不在它下面；目录本身也不算。
	assert.equal(relativeTo("/repo", "/repo-other/a.ts"), null);
	assert.equal(relativeTo("/repo", "/repo"), null);
});
