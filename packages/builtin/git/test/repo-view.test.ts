/**
 * 仓库读出来的结果：分支、改动、行数、历史、未提交的文件，和真实的 git 在同一个仓库上说的对得上。
 *
 * 隔离本身（读不到仓库的配置、引用和浅克隆边界照着抄、悄悄获取搬引用）在宿主里，测在 `@plume/workspace` 的
 * `test/host-git.test.ts`；这里用的是直接跑 git 的替身（`plain-view.ts`），看的是插件自己怎么读、怎么解析。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { collectCommitPatch } from "../src/git/commit-message.ts";
import { collectWorkspaceDiff } from "../src/git/diff.ts";
import { commitDiff, commitDiffSummary, diffRefs, gitLog } from "../src/git/history.ts";
import { gitStatus, upstreamDistance, workspaceStat } from "../src/git/status.ts";
import { uncommittedFiles } from "../src/worktree/lifecycle.ts";
import { usePlainView } from "./plain-view.ts";

let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "plume-git-view-")));
	repo = join(dir, "repo");
	usePlainView();
	await mkdir(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("分支、改动、行数、历史都对；没提交的文件也在", async () => {
	await writeFile(join(repo, "a.txt"), "one\ntwo\n");
	await writeFile(join(repo, "b.txt"), "b1\nb2\n");
	await writeFile(join(repo, ".gitattributes"), "b.txt diff=x\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "first");

	await writeFile(join(repo, "a.txt"), "one\nTWO\n");
	await writeFile(join(repo, "b.txt"), "b1\nB2\nb3\n");
	await writeFile(join(repo, "c.txt"), "new\n");

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

	git(repo, "add", "a.txt");
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
});

test("不在仓库里时读不出来：状态里没有分支，也没有没提交的文件", async () => {
	const plain = join(dir, "plain");
	await mkdir(plain);
	assert.equal(await gitStatus(plain).then((status) => status.branch), null);
	assert.deepEqual(await uncommittedFiles(plain), []);
});
