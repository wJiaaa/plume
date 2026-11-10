import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { SessionWorktree } from "../src/worktree/api.ts";
import { cleanOldWorktrees, createSessionWorktree, reclaimWorktree, restoreWorktree, worktreeState } from "../src/worktree/lifecycle.ts";
import { abortSync, mergeIntoBase, syncFromBase } from "../src/worktree/merge.ts";
import { normalizeSettings } from "../src/worktree/store.ts";

let dir: string;
let repo: string;
let root: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function commit(cwd: string, file: string, content: string, message = `改 ${file}`): Promise<void> {
	await writeFile(join(cwd, file), content);
	git(cwd, "add", "--", file);
	git(cwd, "commit", "-q", "-m", message);
}

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "plume-worktree-")));
	repo = join(dir, "repo");
	root = join(dir, "worktrees");
	await mkdir(join(repo, "pkg"), { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
	await writeFile(join(repo, "pkg", "index.ts"), "export {};\n");
	git(repo, "add", "pkg");
	await commit(repo, "a.txt", "one\n", "第一个提交");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function made(project = repo, sessionId = "12345678-aaaa"): Promise<SessionWorktree> {
	const result = await createSessionWorktree(project, sessionId, { root, fetchFirst: false });
	assert.ok("worktree" in result, "error" in result ? result.error : "");
	return result.worktree;
}

test("建：plume/session- 分支、记下基分支；项目是子目录时落在副本里的同一个子目录", async () => {
	const tree = await made();
	assert.equal(tree.branch, "plume/session-12345678");
	assert.equal(tree.base, "main");
	assert.equal(tree.root, join(root, "repo-12345678"));
	assert.equal(tree.cwd, tree.root);
	assert.equal(git(tree.root, "symbolic-ref", "--short", "HEAD"), "plume/session-12345678");

	const nested = await made(join(repo, "pkg"), "abcdef01-bbbb");
	assert.equal(nested.cwd, join(nested.root, "pkg"));
	assert.equal(nested.project, join(repo, "pkg"));

	// 没提交过的子目录副本里没有：落在工作树根。
	await mkdir(join(repo, "fresh"));
	const fresh = await made(join(repo, "fresh"), "fedcba98-cccc");
	assert.equal(fresh.cwd, fresh.root);
});

test("建：不是仓库时给出原因", async () => {
	const plain = join(dir, "plain");
	await mkdir(plain);
	const result = await createSessionWorktree(plain, "12345678", { root, fetchFirst: false });
	assert.ok("error" in result);
});

test("状态：领先、落后不计合并提交；没提交的文件", async () => {
	const tree = await made();
	await commit(tree.root, "b.txt", "two\n");
	await commit(repo, "c.txt", "three\n");
	await writeFile(join(tree.root, "draft.txt"), "x\n");
	const state = await worktreeState(tree);
	assert.deepEqual(state, { branch: tree.branch, base: "main", present: true, ahead: 1, behind: 1, uncommitted: 1, merging: false, conflicted: [] });
});

test("合并：基分支检出在项目里时在那里合；有没提交的改动先拒绝；合完没东西可合", async () => {
	const tree = await made();
	await commit(tree.root, "b.txt", "two\n");
	await writeFile(join(tree.root, "draft.txt"), "x\n");
	assert.deepEqual(await mergeIntoBase(tree), { kind: "uncommitted", files: 1 });
	await rm(join(tree.root, "draft.txt"));
	assert.deepEqual(await mergeIntoBase(tree), { kind: "merged", commits: 1, base: "main" });
	assert.ok(existsSync(join(repo, "b.txt")));
	assert.deepEqual(await mergeIntoBase(tree), { kind: "nothing", base: "main" });
	assert.equal((await worktreeState(tree))?.ahead, 0);
});

test("合并：基分支哪里都没检出时不动任何目录，直接挪分支", async () => {
	const tree = await made();
	git(repo, "switch", "-q", "-c", "dev");
	await commit(tree.root, "b.txt", "two\n");
	assert.deepEqual(await mergeIntoBase(tree), { kind: "merged", commits: 1, base: "main" });
	assert.equal(git(repo, "show", "main:b.txt"), "two");
	// 项目目录还在 dev 上，文件没被写进来。
	assert.equal(existsSync(join(repo, "b.txt")), false);
});

test("合并：冲突时退回，项目目录里不留半截合并", async () => {
	const tree = await made();
	await commit(tree.root, "a.txt", "worktree\n");
	await commit(repo, "a.txt", "main\n");
	assert.deepEqual(await mergeIntoBase(tree), { kind: "conflict", files: ["a.txt"], base: "main" });
	assert.equal(git(repo, "status", "--porcelain"), "");
});

test("同步：带进基分支的新提交；冲突留在工作树里，放弃后回到原样", async () => {
	const tree = await made();
	await commit(repo, "c.txt", "three\n");
	assert.deepEqual(await syncFromBase(tree), { kind: "synced", commits: 1, base: "main" });
	assert.deepEqual(await syncFromBase(tree), { kind: "up-to-date", base: "main" });

	await commit(tree.root, "a.txt", "worktree\n");
	await commit(repo, "a.txt", "main\n");
	assert.deepEqual(await syncFromBase(tree), { kind: "conflict", files: ["a.txt"], base: "main" });
	const state = await worktreeState(tree);
	assert.equal(state?.merging, true);
	assert.deepEqual(state?.conflicted, ["a.txt"]);
	assert.deepEqual(await mergeIntoBase(tree), { kind: "uncommitted", files: 1 });
	assert.equal(await abortSync(tree), true);
	assert.equal((await worktreeState(tree))?.merging, false);
});

test("收回：有没提交的改动就留着；干净的收走目录，合进基分支的分支一起删；检出回来", async () => {
	const tree = await made();
	await writeFile(join(tree.root, "draft.txt"), "x\n");
	assert.deepEqual(await reclaimWorktree(tree, { dropMergedBranch: true }), { removed: false, kept: "uncommitted" });
	await rm(join(tree.root, "draft.txt"));

	await commit(tree.root, "b.txt", "two\n");
	// 分支上有基分支没有的提交：目录收走，分支留着。
	assert.deepEqual(await reclaimWorktree(tree, { dropMergedBranch: true }), { removed: true, branchDropped: false });
	assert.equal(existsSync(tree.root), false);
	assert.equal((await worktreeState(tree))?.present, false);
	assert.deepEqual(await restoreWorktree(tree), { ok: true, fresh: false });
	assert.ok(existsSync(join(tree.root, "b.txt")));

	assert.equal((await mergeIntoBase(tree)).kind, "merged");
	assert.deepEqual(await reclaimWorktree(tree, { dropMergedBranch: true }), { removed: true, branchDropped: true });
	// 分支不在了：从基分支新切一条同名的，提交都已在基分支里。
	assert.deepEqual(await restoreWorktree(tree), { ok: true, fresh: true });
	assert.ok(existsSync(join(tree.root, "b.txt")));
});

test("自动清理：只收插件建的、没人在用的、干净的，旧的先走", async () => {
	const first = await made(repo, "11111111");
	const second = await made(repo, "22222222");
	const third = await made(repo, "33333333");
	// 人自己建的工作树不算。
	git(repo, "worktree", "add", "-q", "-b", "mine", join(dir, "mine"));
	await writeFile(join(second.root, "draft.txt"), "x\n");
	assert.equal(await cleanOldWorktrees(repo, 1, [third.cwd]), 1);
	assert.equal(existsSync(first.root), false);
	assert.ok(existsSync(second.root));
	assert.ok(existsSync(third.root));
	assert.ok(existsSync(join(dir, "mine")));
});

test("设置：认不出的值回到默认，保留数量收在 1 到 100", () => {
	assert.deepEqual(normalizeSettings(undefined), { rootDir: "", fetchFirst: false, autoClean: false, keepLimit: 15 });
	assert.deepEqual(normalizeSettings({ rootDir: "~/trees", keepLimit: 500, autoClean: "yes" }), {
		rootDir: "~/trees",
		fetchFirst: false,
		autoClean: false,
		keepLimit: 100,
	});
});
