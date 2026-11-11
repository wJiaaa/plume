/**
 * 沙箱里的命令写得到 `.git/config`、`.gitattributes`、`.git/hooks`；面板自动跑的读（status、diff、numstat、log、
 * 工作树卡片的计数）和悄悄的获取在宿主进程里跑，不能替它们执行程序（见 `src/git/view.ts`）。
 * 先用真实的 git 证明这些配置确实会让程序跑起来，再看插件的读：标记文件不出现，结果照样对。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { collectCommitPatch } from "../src/git/commit-message.ts";
import { collectWorkspaceDiff } from "../src/git/diff.ts";
import { commitDiff, commitDiffSummary, diffRefs, fetchRemotes, gitLog } from "../src/git/history.ts";
import { gitStatus, upstreamDistance, workspaceStat } from "../src/git/status.ts";
import { setViewsDir } from "../src/git/view.ts";
import { uncommittedFiles } from "../src/worktree/lifecycle.ts";

const skip = process.platform === "win32" ? "用 sh 脚本当仓库配置里的程序" : false;

let dir: string;
let repo: string;
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
	dir = await realpath(await mkdtemp(join(tmpdir(), "plume-git-view-")));
	repo = join(dir, "repo");
	marker = join(dir, "marker");
	setViewsDir(join(dir, "data"));
	await mkdir(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("自动跑的读不执行仓库配置里的程序，结果照样对", { skip }, async () => {
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
	assert.ok(existsSync(marker), "真实的 git 应该执行了仓库配置里的程序");
	await rm(marker);

	const status = await gitStatus(repo);
	assert.equal(status.branch, "main");
	assert.deepEqual(
		status.unstaged.map((file) => [file.path, file.status, file.added, file.removed]),
		[
			["a.txt", "modified", 1, 1],
			["b.txt", "modified", 2, 1],
			["c.txt", "untracked", 1, 0],
		],
	);
	assert.deepEqual(await workspaceStat(repo), { branch: "main", added: 4, removed: 2, files: 3 });

	const workspace = await collectWorkspaceDiff(repo);
	assert.deepEqual([workspace.added, workspace.removed], [4, 2]);
	assert.deepEqual(
		(await collectWorkspaceDiff(repo, "index")).files.map((file) => file.path),
		["a.txt", "b.txt", "c.txt"],
	);

	git(repo, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "filter.x.clean=cat", "add", "a.txt");
	await rm(marker, { force: true });
	const staged = await diffRefs(repo, "HEAD", null);
	assert.deepEqual(
		staged.files.map((file) => [file.path, file.added, file.removed]),
		[["a.txt", 1, 1]],
	);
	assert.equal((await collectCommitPatch(repo))?.source, "staged");

	const log = await gitLog(repo, 10);
	assert.deepEqual(
		log.map((commit) => [commit.subject, commit.refs]),
		[["first", ["main"]]],
	);
	const sha = log[0]?.sha ?? "";
	assert.deepEqual((await commitDiff(repo, sha)).files.map((file) => file.path).sort(), [".gitattributes", "a.txt", "b.txt"]);
	assert.equal((await commitDiffSummary(repo, sha)).files.length, 3);
	assert.equal(await upstreamDistance(repo), null);
	assert.deepEqual((await uncommittedFiles(repo)).sort(), ["a.txt", "b.txt", "c.txt"]);

	assert.equal(existsSync(marker), false, existsSync(marker) ? await readFile(marker, "utf8") : "");
	// 用完的视图都删掉了。
	assert.deepEqual(await readdir(join(dir, "data", "views")), []);
});

test("悄悄的获取：在视图里取，引用搬回真实仓库（含 --prune），不跑仓库的钩子和 fsmonitor", { skip }, async () => {
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

	assert.deepEqual(await fetchRemotes(repo, { quiet: true }), { ok: true });
	assert.equal(existsSync(marker), false, existsSync(marker) ? await readFile(marker, "utf8") : "");
	assert.equal(git(repo, "rev-parse", "refs/remotes/origin/main"), git(other, "rev-parse", "HEAD"));
	assert.equal(git(repo, "for-each-ref", "refs/remotes/origin/gone"), "");
	assert.deepEqual(await upstreamDistance(repo), { upstream: "origin/main", ahead: 0, behind: 1 });
	assert.equal((await gitStatus(repo)).behind, 1);
	assert.equal(existsSync(marker), false);
});
