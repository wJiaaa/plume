/**
 * 历史上两点之间的 diff（`diffRefs`、`commitDiff`）：改名读来处、复制不打乱分帧、二进制不当文字比；
 * 和只列文件的 `commitDiffSummary`（行数来自 `--numstat`）说的一致。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { commitDiff, commitDiffSummary, diffRefs } from "../src/git/history.ts";
import { usePlainView } from "./plain-view.ts";

let dir: string;
let repo: string;

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("");

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "plume-git-refdiff-")));
	repo = join(dir, "repo");
	usePlainView();
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	git("config", "user.name", "test");
	git("config", "user.email", "test@example.com");
	git("config", "commit.gpgsign", "false");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function counted(sha: string) {
	const [loaded, listed] = await Promise.all([commitDiff(repo, sha), commitDiffSummary(repo, sha)]);
	return {
		loaded: loaded.files.map((file) => [file.path, file.status, file.added, file.removed]),
		listed: listed.files.map((file) => [file.path, file.status, file.added, file.removed]),
	};
}

test("改名又改了内容：之前那一边读来处，行数和列表一致", async () => {
	await writeFile(join(repo, "old.txt"), lines(10));
	git("add", ".");
	git("commit", "-q", "-m", "first");
	git("mv", "old.txt", "new.txt");
	await writeFile(join(repo, "new.txt"), lines(10).replace("line 5\n", "line five\n"));
	git("add", ".");

	// 暂存着的改名。
	const staged = await diffRefs(repo, "HEAD", null);
	assert.deepEqual(
		staged.files.map((file) => [file.path, file.status, file.added, file.removed]),
		[["new.txt", "renamed", 1, 1]],
	);

	git("commit", "-q", "-m", "rename");
	const { loaded, listed } = await counted(git("rev-parse", "HEAD"));
	assert.deepEqual(loaded, [["new.txt", "renamed", 1, 1]]);
	assert.deepEqual(listed, loaded);
});

test("diff.renames=copies 时的复制：两个路径都读掉，后面的文件不错位", async () => {
	git("config", "diff.renames", "copies");
	await writeFile(join(repo, "Src.txt"), lines(20));
	await writeFile(join(repo, "Z.txt"), "x\n");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	await writeFile(join(repo, "Copy.txt"), `${lines(20)}extra\n`);
	await writeFile(join(repo, "Src.txt"), `${lines(20)}changed\n`);
	await writeFile(join(repo, "Z.txt"), "y\n");
	git("add", ".");
	git("commit", "-q", "-m", "copy");

	const { loaded, listed } = await counted(git("rev-parse", "HEAD"));
	assert.deepEqual(loaded, [
		["Copy.txt", "added", 1, 0],
		["Src.txt", "modified", 1, 0],
		["Z.txt", "modified", 1, 1],
	]);
	assert.deepEqual(listed, loaded);
});

test("二进制文件：列出来、标上，不按行比", async () => {
	await writeFile(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x0a, 1]));
	git("add", ".");
	git("commit", "-q", "-m", "first");
	await writeFile(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x0a, 2, 3]));
	git("add", ".");
	git("commit", "-q", "-m", "second");

	const diff = await commitDiff(repo, git("rev-parse", "HEAD"));
	assert.deepEqual(diff.files, [{ path: "logo.png", status: "modified", added: 0, removed: 0, hunks: [], binary: true, bytes: 15 }]);
	assert.deepEqual([diff.added, diff.removed], [0, 0]);
	assert.equal((await commitDiffSummary(repo, git("rev-parse", "HEAD"))).files[0]?.binary, true);
});
