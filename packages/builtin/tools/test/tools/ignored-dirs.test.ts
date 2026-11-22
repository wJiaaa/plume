/**
 * 点名搜一个被 `.gitignore` 忽略的目录（`dist`、`node_modules/foo`）时，glob 和 grep 的兜底照样搜。
 *
 * 两者在仓库里都照 git 的清单搜，而 git 对被忽略的目录一个文件都不列：以前答的是「没有匹配」，模型就以为那里真没有，
 * `find` 又正被改道到 glob。
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { globTool } from "../../src/tools/glob.ts";
import { grepTool } from "../../src/tools/grep.ts";
import type { ToolResult } from "../../src/tools/types.ts";
import { withFiles } from "../files.ts";

const textOf = (res: ToolResult) => res.content.map((part) => part.text).join("");

async function repo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-ignored-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", dir]);
	await writeFile(join(dir, ".gitignore"), "dist/\n");
	await writeFile(join(dir, "index.ts"), "export const a = 1;\n");
	await mkdir(join(dir, "dist", "chunks"), { recursive: true });
	await writeFile(join(dir, "dist", "chunks", "main.js"), "console.log('BUILT_MARKER');\n");
	return dir;
}

/** 清空 PATH，`spawn("rg")` 找不到，grep 走兜底。 */
function withoutRipgrep(): void {
	const path = process.env.PATH;
	const pinned = process.env.PLUME_RIPGREP;
	process.env.PATH = "";
	delete process.env.PLUME_RIPGREP;
	onTestFinished(() => {
		process.env.PATH = path;
		if (pinned !== undefined) process.env.PLUME_RIPGREP = pinned;
	});
}

it("glob 点名被忽略的目录时在里面找；没点名时没找到要说被忽略的没搜", async () => {
	const dir = await repo();
	const ctx = withFiles({ cwd: dir, state: new Map<string, unknown>() });
	const inside = await globTool.execute({ pattern: "**/*.js", path: "dist" }, ctx);
	expect(textOf(inside)).toMatch(/dist\/chunks\/main\.js/);

	const outside = await globTool.execute({ pattern: "dist/**/*.js" }, ctx);
	expect(textOf(outside)).toMatch(/^No files match dist\/\*\*\/\*\.js\. Files git ignores were not searched; .*pass it as `path`/);
});

it("grep 的兜底点名被忽略的目录时在里面搜", async () => {
	const dir = await repo();
	withoutRipgrep();
	const res = await grepTool.execute({ pattern: "BUILT_MARKER", path: "dist" }, withFiles({ cwd: dir, state: new Map<string, unknown>() }));
	expect(textOf(res)).toMatch(/dist\/chunks\/main\.js:1:/);
});
