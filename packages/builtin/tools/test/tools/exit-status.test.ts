/**
 * 哪些非零退出码是答案，哪些是失败：轮询 CI、搜不到、问题答「否」都是答案；长得像、却必须仍算失败的同样要测。
 */

import { expect, test } from "vitest";
import { describeStatus, readExit } from "../../src/tools/exit-status.ts";

const PENDING = [
	"build\tpending\t0\thttps://github.com/acme/app/actions/runs/1/job/2\t",
	"vulncheck\tpass\t41s\thttps://github.com/acme/app/actions/runs/1/job/3\t",
].join("\n");
const FAILED = "build\tfail\t1m21s\thttps://github.com/acme/app/actions/runs/1/job/2\t";

const answer = (command: string, code: number, output = "", meaning?: RegExp) => {
	const reading = readExit(command, code, output);
	expect(reading.failed, `应视为回答: ${command} → ${code}`).toBe(false);
	if (meaning) expect(reading.meaning ?? "").toMatch(meaning);
};
const failure = (command: string, code: number | null, output = "") =>
	expect(readExit(command, code, output).failed, `应视为失败: ${command} → ${code}`).toBe(true);

test("轮询 CI 不是一串失败", () => {
	answer("gh pr checks 1072 -R acme/app", 8, PENDING, /pending/);
	answer('sleep 30\necho "=== PR 1072 ==="\ngh pr checks 1072 -R acme/app\necho "=== PR 1073 ==="\ngh pr checks 1073 -R acme/app', 8, PENDING);
	answer("gh pr checks 1073 -R acme/app", 1, FAILED, /failed/);
	// 没有那张表，退出码说的是别的事：没有这个 PR、没登录。
	failure("gh pr checks 9999 -R acme/app", 1, "no pull requests found for branch");
	failure("gh pr checks 1072 -R acme/app", 8, "");
	// 报告运行失败的 watcher 报的就是失败。
	failure("gh run watch 123 --exit-status", 1, "X build failed");
});

test("搜不到也是回答", () => {
	answer("grep -rn TODO src", 1, "", /no matches/);
	answer("git config -l --show-origin | grep mailmap", 1);
	answer('git diff main -- a.tsx | grep -E "^\\+[ ]*<Row"', 1);
	answer("rg --files -g '*.snap'", 1);
	answer("FOO=1 timeout 5 grep -q needle haystack.txt", 1);
	// 2 是搜索本身坏了。
	failure("grep -rn TODO missing-dir", 2, "grep: missing-dir: No such file or directory");
});

test("答「否」的问题不是出错", () => {
	answer("[ -f dist/index.js ] && echo built", 1, "", /false/);
	answer("test -d node_modules", 1);
	answer("[[ -n $CI ]]", 1);
	answer("which git-filter-repo", 1, "", /not found/);
	answer("command -v pnpm", 1, "", /not found/);
	answer("diff -u a.txt b.txt", 1, "--- a.txt\n+++ b.txt", /differ/);
	answer("git diff --quiet", 1, "", /differences/);
	answer("git merge-base --is-ancestor main HEAD", 1);
	answer("git -C ../other rev-parse --verify --quiet refs/heads/x", 1);
	answer("lsof -i :3000", 1, "");
	answer("pgrep -f vite", 1);
	answer("kill -0 4242", 1);
	answer("pnpm outdated", 1, "Package  Current  Latest\nreact    18.0.0   19.0.0");
	answer("find / -name id_rsa.pub 2>/dev/null", 1, "/Users/me/.ssh/id_rsa.pub");
	failure("find /nope -name x", 1, "find: /nope: No such file or directory");
});

test("`a && b` 的退出码可能是 a 的，那时算 a 的", () => {
	// 失败的 `cd` 会说出来，那就是失败。
	failure("cd packages/nope && grep -rn x .", 1, "cd: no such file or directory: packages/nope");
	answer("cd packages/core && grep -rn needle .", 1, "");
	// grep 之前就失败的构建不是「没匹配」。
	failure("pnpm build && grep -q ok dist/log.txt", 1, "ERR_PNPM build failed");
	// `||` 之后只有右边能是退出码。
	failure("grep -q needle file || false", 1);
	// 管道只看最后一条，除非开了 pipefail。
	failure("pnpm test 2>&1 | tail -20", 1);
	failure("set -o pipefail; cat log.txt | grep needle", 1);
});

test("读不懂的仍算失败", () => {
	failure("for pr in 1 2; do gh pr diff $pr --stat; done", 1);
	failure("if grep -q x f; then echo yes; fi", 1);
	failure("(cd sub && grep -q x f)", 1);
	failure("set -e; grep -q x f; echo done", 1);
	failure("! grep -q x f", 1);
	failure("npm test", 1, "1 failing");
	failure("git push origin main", 1, "error: failed to push some refs");
	failure("node verify.cjs", null);
});

test("PowerShell 的一行不按 bash 的语法读，非零就是失败", () => {
	// `grep` 在 PowerShell 里是 Select-String 的别名，退出码也是 PowerShell 那一套，按 bash 读会把失败当成「没匹配」。
	expect(readExit("grep -q needle haystack.txt", 1, "", "posix").failed).toBe(false);
	expect(readExit("grep -q needle haystack.txt", 1, "", "powershell").failed).toBe(true);
	expect(readExit("Get-ChildItem", 0, "", "powershell").failed).toBe(false);
});

test("shell 自己的退出码用字说出来", () => {
	expect(describeStatus(1)).toBe("exit code 1");
	expect(describeStatus(127)).toMatch(/command not found/);
	expect(describeStatus(126)).toMatch(/not executable/);
	expect(describeStatus(137)).toMatch(/SIGKILL/);
	expect(describeStatus(null, "SIGTERM")).toMatch(/terminated by SIGTERM/);
	expect(describeStatus(null)).toMatch(/terminated without an exit code/);
});
