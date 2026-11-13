/**
 * 隔离视图（`host-git.ts` 的 `withPluginView`）：宿主在「沙箱可写的仓库」上跑 git，不执行仓库能控制的程序。
 *
 * 沙箱里的命令写得到 `.git/config`、`.gitattributes`、`.git/hooks`；面板、插件在宿主进程里跑的读不能替它们执行程序。
 * 先用真实的 git 证明这些配置确实会让程序跑起来，再看视图里的读：标记文件不出现，引用、上游、获取的结果照样对。
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withPluginView } from "../src/host-git.ts";

/** 用 sh 脚本当仓库配置里的程序，Windows 上没有。 */
const skip = process.platform === "win32";

let dir: string;
let repo: string;
let dataDir: string;
let marker: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** 被执行时往标记文件里记一笔；当过滤器时原样吐出 stdin，当 textconv 时吐出那个文件。 */
async function plantProgram(): Promise<string> {
	const program = join(dir, "evil.sh");
	await writeFile(program, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nif [ $# -eq 0 ]; then cat; elif [ -f "$1" ]; then cat "$1"; fi\nexit 0\n`);
	await chmod(program, 0o755);
	return program;
}

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "plume-host-git-")));
	repo = join(dir, "repo");
	dataDir = join(dir, "data");
	marker = join(dir, "marker");
	await mkdir(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

it.skipIf(skip)("视图里的读不执行仓库配置里的程序，结果照样对；用完的视图都删掉", async () => {
	await writeFile(join(repo, "a.txt"), "one\ntwo\n");
	await writeFile(join(repo, "b.txt"), "b1\nb2\n");
	await writeFile(join(repo, ".gitattributes"), "b.txt filter=x diff=x\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "first");

	const program = await plantProgram();
	git(repo, "config", "core.fsmonitor", program);
	git(repo, "config", "filter.x.clean", program);
	git(repo, "config", "diff.x.textconv", program);
	git(repo, "config", "diff.external", program);
	await writeFile(join(repo, ".git", "hooks", "post-index-change"), `#!/bin/sh\n'${program}' hook\n`);
	await chmod(join(repo, ".git", "hooks", "post-index-change"), 0o755);

	await writeFile(join(repo, "a.txt"), "one\nTWO\n");
	await writeFile(join(repo, "b.txt"), "b1\nB2\nb3\n");
	await writeFile(join(repo, "c.txt"), "new\n");

	// 前提：真实的 git 读这个仓库确实会执行它们。
	git(repo, "status", "--porcelain");
	git(repo, "diff", "--numstat");
	expect(existsSync(marker), "真实的 git 应该执行了仓库配置里的程序").toBe(true);
	await rm(marker);

	const status = await withPluginView(repo, dataDir, (view) => view.git(["status", "--porcelain=v1", "--untracked-files=all"]));
	// 不 `trim` 整串：第一行的前导空格是「工作区改了、index 没改」的那一格。
	expect(status?.split("\n").filter(Boolean).sort()).toEqual([" M a.txt", " M b.txt", "?? c.txt"]);
	// 属性里写了 `filter=x`，视图里没有这个驱动：按没转换的原样比。
	const numstat = await withPluginView(repo, dataDir, (view) => view.git(["diff", "--numstat"]));
	expect(numstat?.trim()).toBe("1\t1\ta.txt\n2\t1\tb.txt");
	expect(existsSync(marker), existsSync(marker) ? await readFile(marker, "utf8") : "").toBe(false);
	// 用完的视图都删掉了。
	expect(await readdir(join(dataDir, "git-views"))).toEqual([]);
});

it("分支、上游、引用照着真实仓库抄过去；二进制照样读得出", async () => {
	const upstream = join(dir, "upstream.git");
	git(dir, "init", "-q", "--bare", "-b", "main", upstream);
	await writeFile(join(repo, "a.txt"), "one\n");
	await writeFile(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 255]));
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "first");
	git(repo, "remote", "add", "origin", upstream);
	git(repo, "push", "-q", "-u", "origin", "main");

	// 别处往远端推了一个提交。
	const other = join(dir, "other");
	git(dir, "clone", "-q", upstream, other);
	git(other, "config", "user.name", "test");
	git(other, "config", "user.email", "test@example.com");
	await writeFile(join(other, "a.txt"), "one\ntwo\n");
	git(other, "commit", "-q", "-am", "second");
	git(other, "push", "-q", "origin", "main");
	git(repo, "fetch", "-q");

	const seen = await withPluginView(repo, dataDir, async (view) => ({
		branch: (await view.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
		upstream: (await view.git(["rev-parse", "--abbrev-ref", "@{upstream}"])).trim(),
		behind: (await view.git(["rev-list", "--count", "HEAD..@{upstream}"])).trim(),
		// HEAD 落在 `origin/main` 前一个提交；装饰要看远端那个提交，不是 HEAD 这个。
		decorated: (await view.git(["log", "-1", "--format=%D", "origin/main"])).trim(),
		binary: await view.gitBuffer(["show", "HEAD:logo.bin"]),
	}));
	expect(seen).not.toBeNull();
	if (!seen) return;
	expect(seen.branch).toBe("main");
	expect(seen.upstream).toBe("origin/main");
	expect(seen.behind).toBe("1");
	expect(seen.decorated).toContain("origin/main");
	expect([...(seen.binary as Uint8Array)]).toEqual([0, 1, 2, 255]);
});

it.skipIf(skip)("悄悄获取：在视图里取，引用搬回真实仓库（含 --prune），不跑仓库的钩子", async () => {
	const upstream = join(dir, "upstream.git");
	git(dir, "init", "-q", "--bare", "-b", "main", upstream);
	await writeFile(join(repo, "a.txt"), "one\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "first");
	git(repo, "remote", "add", "origin", upstream);
	git(repo, "push", "-q", "-u", "origin", "main");
	git(repo, "push", "-q", "origin", "main:gone");
	git(repo, "fetch", "-q");

	// 别处往远端推了一个提交，删了一个分支。
	const other = join(dir, "other");
	git(dir, "clone", "-q", upstream, other);
	git(other, "config", "user.name", "test");
	git(other, "config", "user.email", "test@example.com");
	await writeFile(join(other, "a.txt"), "one\ntwo\n");
	git(other, "commit", "-q", "-am", "second");
	git(other, "push", "-q", "origin", "main", ":gone");

	const program = await plantProgram();
	git(repo, "config", "core.fsmonitor", program);
	for (const hook of ["reference-transaction", "post-index-change"]) {
		await writeFile(join(repo, ".git", "hooks", hook), `#!/bin/sh\n'${program}' ${hook}\ncat > /dev/null\n`);
		await chmod(join(repo, ".git", "hooks", hook), 0o755);
	}

	const result = await withPluginView(repo, dataDir, (view) => view.fetch({ timeoutMs: 20_000 }));
	expect(result).toEqual({ ok: true });
	expect(existsSync(marker), existsSync(marker) ? await readFile(marker, "utf8") : "").toBe(false);
	expect(git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(git(other, "rev-parse", "HEAD"));
	expect(git(repo, "for-each-ref", "refs/remotes/origin/gone")).toBe("");
	expect((await withPluginView(repo, dataDir, (view) => view.git(["rev-list", "--count", "HEAD..@{upstream}"])))?.trim()).toBe("1");
	expect(existsSync(marker)).toBe(false);
});

it("要写 stdin 的调用：一次问很多个对象", async () => {
	await writeFile(join(repo, "a.txt"), "hello\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "first");
	// 一批对象名：提交和其中一个 blob。路径要写成 `HEAD:a.txt`，`a.txt` 不是对象名。
	const out = await withPluginView(repo, dataDir, (view) => view.gitWithInput(["cat-file", "--batch-check"], "HEAD\nHEAD:a.txt\n"));
	expect(out?.toString().trim().split("\n")).toEqual([expect.stringContaining(" commit "), expect.stringContaining(" blob ")]);
});
