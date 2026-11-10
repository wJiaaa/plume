/**
 * 在 git 仓库里，glob、grep（ripgrep 与兜底）、read 的同名提示看到的是同一份文件：认 `.gitignore`，
 * 不认目录名，隐藏的也算。
 *
 * 项目根经一个软链进来：git 报的是解析过的真实路径，结果里的路径仍要相对调用方给的那个目录。
 */

import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { globTool } from "../../src/tools/glob.ts";
import { grepTool } from "../../src/tools/grep.ts";
import { setDataDir } from "../../src/tools/home.ts";
import { readTool } from "../../src/tools/read.ts";
import type { ToolResult } from "../../src/tools/types.ts";

const ctx = (cwd: string) => ({ cwd, state: new Map<string, unknown>() });
const textOf = (res: ToolResult) => res.content.map((part) => part.text).join("");

/** 返回经软链指向仓库的那个路径。 */
async function repo(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-project-files-"));
	const saved = process.env.PLUME_RIPGREP;
	// 问 git 要经 `host-git.ts` 在 `appHome()` 下建临时视图，不能落到真实的 ~/.plume。
	setDataDir(join(dir, "home"));
	onTestFinished(async () => {
		if (saved === undefined) delete process.env.PLUME_RIPGREP;
		else process.env.PLUME_RIPGREP = saved;
		await rm(dir, { recursive: true, force: true });
	});
	const real = join(dir, "real");
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(real, path)), { recursive: true });
		await writeFile(join(real, path), content);
	}
	execFileSync("git", ["init", "-q"], { cwd: real });
	execFileSync("git", ["add", "-A"], { cwd: real });
	const linked = join(dir, "linked");
	await symlink(real, linked, "dir");
	return linked;
}

const FILES = {
	".gitignore": "release/\n",
	"build/entitlements.plist": "<plist/>",
	"release/Plume.app/Info.plist": "<plist/>",
	"gone.plist": "<plist/>",
	".github/ci.plist": "<plist/>",
};

it("glob：提交了的 build/ 和隐藏的 .github/ 照找，被忽略的 release/ 不出现，工作区删掉的不报", async () => {
	const cwd = await repo(FILES);
	await rm(join(cwd, "gone.plist"));

	const res = await globTool.execute({ pattern: "**/*.plist" }, ctx(cwd));

	expect((res.details as { files: string[] }).files.sort()).toEqual([".github/ci.plist", "build/entitlements.plist"]);
});

it("grep 兜底：软链下的项目，路径相对项目根而不是 ../../真实路径；隐藏目录照搜", async () => {
	const cwd = await repo({ "a.txt": "needle\n", ".github/ci.yml": "needle\n", "release/b.txt": "needle\n", ".gitignore": "release/\n" });
	process.env.PLUME_RIPGREP = join(tmpdir(), "plume-no-such-ripgrep");

	const res = await grepTool.execute({ pattern: "needle" }, ctx(cwd));

	expect(textOf(res).split("\n").sort()).toEqual([".github/ci.yml:1:needle", "a.txt:1:needle"]);
});

it("grep 兜底：不带 / 的 glob 和 ripgrep 一样比文件名，任意深度都算", async () => {
	const cwd = await repo({ "top.ts": "needle\n", "src/deep.ts": "needle\n", "src/deep.js": "needle\n" });
	process.env.PLUME_RIPGREP = join(tmpdir(), "plume-no-such-ripgrep");

	const res = await grepTool.execute({ pattern: "needle", glob: "*.ts" }, ctx(cwd));

	expect(textOf(res).split("\n").sort()).toEqual(["src/deep.ts:1:needle", "top.ts:1:needle"]);
});

// Windows 上 shell 脚本替代不了 rg.exe（不经 shell 起不来）。
it.skipIf(process.platform === "win32")("ripgrep：仓库里加 --hidden 并排除 .git，仓库外不加", async () => {
	const cwd = await repo({ "a.txt": "needle\n" });
	const outside = await mkdtemp(join(tmpdir(), "plume-not-a-repo-"));
	onTestFinished(() => rm(outside, { recursive: true, force: true }));
	// 只记下收到的参数，按「没有命中」退出。
	const log = join(outside, "argv.log");
	const fake = join(outside, "rg");
	await writeFile(fake, `#!/bin/sh\necho "$*" >> '${log}'\nexit 1\n`);
	await chmod(fake, 0o755);
	process.env.PLUME_RIPGREP = fake;

	await grepTool.execute({ pattern: "needle" }, ctx(cwd));
	await grepTool.execute({ pattern: "needle" }, ctx(outside));

	const [inRepo, outRepo] = (await readFile(log, "utf8")).trim().split("\n");
	expect(inRepo).toMatch(/--hidden --glob !\.git /);
	expect(outRepo).not.toMatch(/--hidden/);
});

it("read：找不到文件时列出项目里的同名文件，猜错模块名的那个排最前，被忽略的不列", async () => {
	const cwd = await repo({
		".gitignore": "release/\n",
		"eim-echat/src/main/java/handle/RequestDistributor.java": "class A {}",
		"eim-ecom/src/other/RequestDistributor.java": "class B {}",
		"release/RequestDistributor.java": "class C {}",
		"eim-echat/src/main/java/handle/Unrelated.java": "class D {}",
	});
	const text = async (path: string) => {
		const res = await readTool.execute({ path }, ctx(cwd));
		expect(res.isError).toBe(true);
		return textOf(res);
	};

	// 模块名猜错，后半截是对的。
	expect(await text("eim-eicq/src/main/java/handle/RequestDistributor.java")).toBe(
		"File not found: eim-eicq/src/main/java/handle/RequestDistributor.java. Files with that name in the project:\n" +
			"  eim-echat/src/main/java/handle/RequestDistributor.java\n" +
			"  eim-ecom/src/other/RequestDistributor.java",
	);
	// 只拿文件名去读（glob 分组以后容易这样）；对得上的一样多时按路径排，结果是确定的。
	expect(await text("RequestDistributor.java")).toBe(
		"File not found: RequestDistributor.java. Files with that name in the project:\n" +
			"  eim-echat/src/main/java/handle/RequestDistributor.java\n" +
			"  eim-ecom/src/other/RequestDistributor.java",
	);
	// 没有同名的：还是原来那一句，不猜「相近」的。
	expect(await text("src/Nope.java")).toBe("File not found: src/Nope.java");
});
