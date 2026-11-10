import assert from "node:assert/strict";
import { test } from "node:test";
import { explainGitFailure } from "../src/git/errors.ts";
import { parseNumstat, parseStatusZ, statusBranch } from "../src/git/parse.ts";
import { classifyRemote, defaultRemote, remoteOfUpstream } from "../src/git/remote-state.ts";

test("parseStatusZ：头一行单独返回，重命名的来处不算另一行", () => {
	const out = "## main...origin/main [ahead 1]\0 M a.ts\0R  new.ts\0old.ts\0?? fresh.txt\0";
	const { header, entries } = parseStatusZ(out);
	assert.equal(header, "main...origin/main [ahead 1]");
	assert.deepEqual(entries, [
		{ code: " M", path: "a.ts", source: "a.ts" },
		{ code: "R ", path: "new.ts", source: "old.ts" },
		{ code: "??", path: "fresh.txt", source: "fresh.txt" },
	]);
});

test("parseNumstat：重命名按目标路径记，二进制标出来", () => {
	const out = "3\t1\ta.ts\0" + "2\t0\t\0old.ts\0new.ts\0" + "-\t-\tlogo.png\0";
	const counts = parseNumstat(out);
	assert.deepEqual(counts.get("a.ts"), { added: 3, removed: 1, binary: false });
	assert.deepEqual(counts.get("new.ts"), { added: 2, removed: 0, binary: false });
	assert.equal(counts.has("old.ts"), false);
	assert.deepEqual(counts.get("logo.png"), { added: 0, removed: 0, binary: true });
});

test("statusBranch：几种头的写法", () => {
	assert.deepEqual(statusBranch("main...origin/main [ahead 1]"), { branch: "main", born: true });
	assert.deepEqual(statusBranch("feat/x"), { branch: "feat/x", born: true });
	assert.deepEqual(statusBranch("No commits yet on main"), { branch: "main", born: false });
	assert.deepEqual(statusBranch("Initial commit on dev"), { branch: "dev", born: false });
	assert.deepEqual(statusBranch("HEAD (no branch)"), { branch: null, born: true });
});

test("explainGitFailure：认得的翻成原因，认不出的给前三行", () => {
	assert.equal(explainGitFailure(" ! [rejected] main -> main (non-fast-forward)"), "远端有新的提交，先拉取再推送。");
	assert.equal(
		explainGitFailure("fatal: could not read Username for 'https://x': terminal prompts disabled"),
		"远端需要登录，这里无法输入。请先在终端里配置一次凭据。",
	);
	assert.equal(explainGitFailure("fatal: Not possible to fast-forward, aborting."), "远端已分叉，无法快进。先手动合并或变基。");
	assert.equal(explainGitFailure(""), "操作失败");
	assert.equal(explainGitFailure("a\nb\nc\nd"), "a\nb\nc");
});

test("classifyRemote：顺序决定答案", () => {
	const base = { header: "main", branch: "main", upstream: null, operation: null, remotes: ["origin"] };
	// 变基时 HEAD 也是游离的，先认半路的操作。
	assert.equal(classifyRemote({ ...base, branch: null, operation: "rebase" }).state, "in-progress");
	assert.equal(classifyRemote({ ...base, branch: null }).state, "detached");
	assert.equal(classifyRemote({ ...base, header: "No commits yet on main" }).state, "no-commits");
	assert.deepEqual(classifyRemote({ ...base, upstream: "origin/main" }), { state: "tracking", remote: "origin" });
	assert.deepEqual(classifyRemote({ ...base, remotes: [] }), { state: "none", remote: null });
	assert.deepEqual(classifyRemote({ ...base, remotes: ["a", "b"] }), { state: "no-upstream", remote: null });
	assert.deepEqual(classifyRemote(base), { state: "no-upstream", remote: "origin" });
});

test("remoteOfUpstream 取最长的配置远端；defaultRemote 不猜", () => {
	assert.equal(remoteOfUpstream("origin/feature/x", ["origin", "origin/feature"]), "origin/feature");
	assert.equal(defaultRemote(["upstream", "fork"]), null);
	assert.equal(defaultRemote(["upstream", "origin"]), "origin");
});
