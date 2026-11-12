/**
 * 没有 ripgrep 时，内置扫描器给出的结果要和 ripgrep 是同一回事：上下文不重复、被忽略的不出现。
 * 以及 `PLUME_RIPGREP` 指定的那份 ripgrep 真的被用上，搜单个文件时路径不带整条前缀。
 *
 * 兜底靠把 `PLUME_RIPGREP` 指向一个不存在的文件来逼出：留着 `PATH`，git 才找得到。
 */

import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { grepTool } from "../../src/tools/grep.ts";
import type { ToolResult } from "../../src/tools/types.ts";
import { withFiles } from "../files.ts";

const ctx = (cwd: string) => withFiles({ cwd, state: new Map<string, unknown>() });
const textOf = (res: ToolResult) => res.content.map((part) => part.text).join("");

async function sandbox(ripgrep: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-grep-fb-"));
	const saved = process.env.PLUME_RIPGREP;
	process.env.PLUME_RIPGREP = ripgrep;
	onTestFinished(async () => {
		if (saved === undefined) delete process.env.PLUME_RIPGREP;
		else process.env.PLUME_RIPGREP = saved;
		await rm(dir, { recursive: true, force: true });
	});
	return dir;
}

const NO_RG = join(tmpdir(), "plume-no-such-ripgrep");

it("兜底：相邻命中的上下文重叠时，每行只出一次", async () => {
	const dir = await sandbox(NO_RG);
	await writeFile(join(dir, "tokens.css"), ["a", "b", "--radius-menu: 8px;", "--menu-inset: 4px;", "--radius-item: 6px;", "c", "d"].join("\n"));

	const lines = textOf(await grepTool.execute({ pattern: "radius|inset", context: 2 }, ctx(dir))).split("\n");

	expect(lines).toEqual([
		"tokens.css:1:a",
		"tokens.css:2:b",
		"tokens.css:3:--radius-menu: 8px;",
		"tokens.css:4:--menu-inset: 4px;",
		"tokens.css:5:--radius-item: 6px;",
		"tokens.css:6:c",
		"tokens.css:7:d",
	]);
});

it("兜底：git 仓库里被忽略的目录不搜，隐藏文件和未跟踪的照搜", async () => {
	const dir = await sandbox(NO_RG);
	execFileSync("git", ["init", "-q"], { cwd: dir });
	await writeFile(join(dir, ".gitignore"), "ios/\n");
	await mkdir(join(dir, "ios"));
	await mkdir(join(dir, "src"));
	await writeFile(join(dir, "ios", "Pods.txt"), "needle in ignored\n");
	await writeFile(join(dir, "src", "app.ts"), "needle in source\n");
	await writeFile(join(dir, ".rc"), "needle in dotfile\n");

	const found = textOf(await grepTool.execute({ pattern: "needle" }, ctx(dir)));

	expect(found).toMatch(/src\/app\.ts:1:needle in source/);
	expect(found).toMatch(/\.rc:1:needle in dotfile/);
	expect(found, "被 .gitignore 忽略的目录不该出现在结果里").not.toMatch(/Pods/);
});

it("兜底：不在 git 仓库里时照旧按目录名单走", async () => {
	const dir = await sandbox(NO_RG);
	await mkdir(join(dir, "node_modules"));
	await writeFile(join(dir, "node_modules", "dep.js"), "needle\n");
	await writeFile(join(dir, "main.js"), "needle\n");

	const found = textOf(await grepTool.execute({ pattern: "needle" }, ctx(dir)));

	expect(found).toMatch(/main\.js:1:needle/);
	expect(found).not.toMatch(/node_modules/);
});

// Windows 上 shell 脚本替代不了 rg.exe（不经 shell 起不来）。
it.skipIf(process.platform === "win32")("PLUME_RIPGREP 指定的 ripgrep 被用上；搜单个文件时只留文件名", async () => {
	const bin = await mkdtemp(join(tmpdir(), "plume-grep-bin-"));
	onTestFinished(() => rm(bin, { recursive: true, force: true }));
	// 只认 --json：照真 ripgrep 的样子，报的是传进来的那条路径本身。
	const fake = join(bin, "bundled-rg");
	await writeFile(
		fake,
		`#!/bin/sh
for arg in "$@"; do root="$arg"; done
printf '{"type":"match","data":{"path":{"text":"%s"},"lines":{"text":"from-bundled\\\\n"},"line_number":1,"submatches":[{"match":{"text":"from"},"start":0,"end":4}]}}\\n' "$root"
printf '{"type":"summary","data":{}}\\n'
`,
	);
	await chmod(fake, 0o755);
	const dir = await sandbox(fake);
	await writeFile(join(dir, "sample.txt"), "from-fallback\n");

	const found = textOf(await grepTool.execute({ pattern: "from", path: "sample.txt" }, ctx(dir)));

	expect(found).toBe("sample.txt:1:from-bundled");
});
