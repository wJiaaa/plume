/**
 * 在临时目录里真跑 git：从 init 到切分支走一遍面板会用到的读写。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { listBranches, switchBranch } from "../src/git/branches.ts";
import { collectWorkspaceDiff, readDiffBlob } from "../src/git/diff.ts";
import { commitDiff, commitStaged, createBranch, gitLog } from "../src/git/history.ts";
import { probeRepo } from "../src/git/probe.ts";
import { initRepo } from "../src/git/repos.ts";
import { gitStatus, stagePaths, workspaceStat } from "../src/git/status.ts";
import { usePlainView } from "./plain-view.ts";

let dir = "";

before(async () => {
	usePlainView();
	dir = await mkdtemp(join(tmpdir(), "plume-git-"));
});

after(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("init → 改动 → 暂存 → 提交 → 历史 → 分支", async () => {
	assert.deepEqual(await probeRepo(dir), { repo: false });
	assert.deepEqual(await initRepo(dir), { ok: true });
	// 提交要有作者；不依赖跑测试的机器配没配。
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: dir });

	await writeFile(join(dir, "a.txt"), "one\ntwo\n");
	let status = await gitStatus(dir);
	assert.equal(status.branch, "main");
	assert.equal(status.remoteState, "no-commits");
	assert.deepEqual(
		status.unstaged.map((file) => [file.path, file.status, file.added]),
		[["a.txt", "untracked", 2]],
	);
	assert.deepEqual(await workspaceStat(dir), { branch: "main", added: 2, removed: 0, files: 1 });

	assert.equal((await commitStaged(dir, "first")).ok, false);
	assert.deepEqual(await stagePaths(dir, ["a.txt"]), { ok: true });
	status = await gitStatus(dir);
	assert.deepEqual(
		status.staged.map((file) => [file.path, file.status]),
		[["a.txt", "added"]],
	);
	assert.deepEqual(await commitStaged(dir, "  first  "), { ok: true });

	const log = await gitLog(dir, 10);
	assert.equal(log.length, 1);
	assert.equal(log[0]?.subject, "first");
	assert.deepEqual(log[0]?.parents, []);
	assert.ok(log[0]?.refs.includes("main"));

	const first = await commitDiff(dir, log[0]?.sha ?? "");
	assert.deepEqual([first.added, first.removed, first.files.map((file) => file.path)], [2, 0, ["a.txt"]]);

	await writeFile(join(dir, "a.txt"), "one\nTWO\n");
	const diff = await collectWorkspaceDiff(dir);
	assert.deepEqual([diff.added, diff.removed, diff.branch], [1, 1, "main"]);
	status = await gitStatus(dir);
	assert.equal(status.remoteState, "none");

	assert.deepEqual(await createBranch(dir, "feat/x"), { ok: true });
	let branches = await listBranches(dir);
	assert.deepEqual([branches.current, branches.local], ["feat/x", ["feat/x", "main"]]);
	assert.deepEqual(await switchBranch(dir, "main"), { ok: true });
	branches = await listBranches(dir);
	assert.equal(branches.current, "main");
	assert.equal((await createBranch(dir, "   ")).ok, false);
});

test("blob：只认仓库里的图片", async () => {
	assert.equal(await readDiffBlob(dir, "../../etc/passwd.png", "work"), null);
	assert.equal(await readDiffBlob(dir, "a.txt", "work"), null);
	await writeFile(join(dir, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	const blob = await readDiffBlob(dir, "dot.png", "work");
	assert.equal(blob?.bytes, 4);
	assert.ok(blob?.dataUrl.startsWith("data:image/png;base64,"));
});
