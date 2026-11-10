/**
 * grep 对付真实磁盘上的两样东西：读不了的路径，和 CRLF 文件。
 *
 * ripgrep 用一个替身驱动：放在 `PATH` 最前面的 shell 脚本。这些失败出在进程上而不是搜索上——没人读的
 * stderr、读得太严的退出码——真 ripgrep 只在 `/proc`、`C:\Windows` 这样的树上才出得来。替身报一个
 * 不存在的文件（`rg-only.txt`），结果里有它就只能来自 ripgrep，有 `sample.txt` 就是内置扫描器又搜了一遍。
 *
 * CRLF 的几条走装着的 ripgrep，也走内置扫描器。
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { grepTool } from "../../src/tools/grep.ts";
import type { ToolResult } from "../../src/tools/types.ts";

const FAKE_RG = `#!/bin/sh
printf '%s\\n' "$@" >> "$FAKE_RG_ARGV"
root=""
for arg in "$@"; do root="$arg"; done
i=0
while [ "$i" -lt "\${FAKE_RG_ERRORS:-0}" ]; do
	echo "rg: $root/denied-$i: Permission denied (os error 13)" >&2
	i=$((i + 1))
done
if [ -n "$FAKE_RG_STDERR" ]; then echo "$FAKE_RG_STDERR" >&2; fi
case " $* " in
	*" --json "*)
		# 一直吐命中、永不退出：只有被结束掉，这次搜索才会有结果。
		if [ "$FAKE_RG_FLOOD" = 1 ]; then
			while :; do
				printf '{"type":"match","data":{"path":{"text":"%s/rg-only.txt"},"lines":{"text":"from-ripgrep\\\\n"},"line_number":1,"submatches":[{"match":{"text":"from"},"start":0,"end":4}]}}\\n' "$root"
			done
		fi
		if [ "$FAKE_RG_MATCH" = 1 ]; then
			printf '{"type":"match","data":{"path":{"text":"%s/rg-only.txt"},"lines":{"text":"from-ripgrep\\\\n"},"line_number":1,"submatches":[{"match":{"text":"from"},"start":0,"end":4}]}}\\n' "$root"
		fi
		if [ "$FAKE_RG_SUMMARY" = 1 ]; then printf '{"type":"summary","data":{}}\\n'; fi
		;;
	*" --files-with-matches "*)
		if [ "$FAKE_RG_MATCH" = 1 ]; then printf '%s/rg-only.txt\\n' "$root"; fi
		;;
	*)
		if [ "$FAKE_RG_MATCH" = 1 ]; then printf '%s/rg-only.txt:1:from-ripgrep\\n' "$root"; fi
		;;
esac
exit "\${FAKE_RG_EXIT:-0}"
`;

interface FakeRg {
	errors?: number;
	stderr?: string;
	match: boolean;
	summary: boolean;
	exit: number;
	/** 一直报命中，自己不退出。 */
	flood?: boolean;
}

// Windows 上 shell 脚本替代不了 rg.exe（不经 shell 起不来）。
const NO_SHELL_SPAWN = process.platform === "win32";

/** 一个工作区，内置扫描器只找得到其中唯一的文件；替身 rg 放在 PATH 最前面。 */
async function withFakeRg(behaviour: FakeRg): Promise<{ dir: string; argv: () => Promise<string[]> }> {
	const dir = await mkdtemp(join(tmpdir(), "plume-grep-rg-"));
	const bin = await mkdtemp(join(tmpdir(), "plume-grep-bin-"));
	await writeFile(join(dir, "sample.txt"), "from-fallback\n");
	await writeFile(join(bin, "rg"), FAKE_RG);
	await chmod(join(bin, "rg"), 0o755);
	const argvLog = join(bin, "argv.log");
	await writeFile(argvLog, "");

	const saved = { ...process.env };
	// 指定了 PLUME_RIPGREP 就不看 PATH，替身就用不上。
	delete process.env.PLUME_RIPGREP;
	process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
	process.env.FAKE_RG_ARGV = argvLog;
	process.env.FAKE_RG_ERRORS = String(behaviour.errors ?? 0);
	process.env.FAKE_RG_STDERR = behaviour.stderr ?? "";
	process.env.FAKE_RG_MATCH = behaviour.match ? "1" : "0";
	process.env.FAKE_RG_SUMMARY = behaviour.summary ? "1" : "0";
	process.env.FAKE_RG_EXIT = String(behaviour.exit);
	process.env.FAKE_RG_FLOOD = behaviour.flood ? "1" : "0";
	onTestFinished(async () => {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		await rm(dir, { recursive: true, force: true });
		await rm(bin, { recursive: true, force: true });
	});
	return { dir, argv: async () => (await readFile(argvLog, "utf8")).split("\n").filter(Boolean) };
}

const ctx = (cwd: string, signal?: AbortSignal) => ({ cwd, state: new Map<string, unknown>(), signal });
const textOf = (res: ToolResult) => res.content.map((part) => part.text).join("");

it.skipIf(NO_SHELL_SPAWN)("stderr 写满管道也不会把 rg 卡住", async () => {
	// 约 200KB 的权限错误，远超管道缓冲。不读走的话替身卡在写上永不退出；超时把卡住变成失败而不是挂起。
	const { dir } = await withFakeRg({ errors: 3000, match: true, summary: true, exit: 0 });
	const started = Date.now();
	const res = await grepTool.execute({ pattern: "from" }, ctx(dir, AbortSignal.timeout(5_000)));
	expect(textOf(res), "ripgrep 找到的结果要原样交回来").toMatch(/rg-only\.txt:1:from-ripgrep/);
	expect(Date.now() - started < 4_000, `不该等到超时才结束，实际 ${Date.now() - started}ms`).toBe(true);
});

it.skipIf(NO_SHELL_SPAWN)("收满上限就结束 rg，不等它扫完整棵树", async () => {
	// `--max-count` 只管每个文件：替身在同一个「文件」里没完没了地报命中，不结束它就永远等不到 close。
	const { dir } = await withFakeRg({ match: false, summary: false, exit: 0, flood: true });
	const started = Date.now();
	const res = await grepTool.execute({ pattern: "from" }, ctx(dir, AbortSignal.timeout(5_000)));
	const text = textOf(res);
	expect(Date.now() - started < 4_000, `收满后应立刻结束，实际 ${Date.now() - started}ms`).toBe(true);
	expect(text).toMatch(/rg-only\.txt:1:from-ripgrep/);
	expect(text, "被我们结束的 rg 不算失败，不该交给内置扫描器重搜").not.toMatch(/from-fallback/);
	expect(text).toMatch(/hit the 200-match limit; more matches may exist/);
	expect((res.details as { count: number }).count).toBe(200);
	expect((res.details as { stopped?: boolean }).stopped).toBe(true);
});

it.skipIf(NO_SHELL_SPAWN)("rg 出过错（退出码 2）但找到了匹配：结果照用，错误附在后面", async () => {
	const { dir } = await withFakeRg({ errors: 5, match: true, summary: true, exit: 2 });
	const text = textOf(await grepTool.execute({ pattern: "from" }, ctx(dir)));
	expect(text, "退出码 2 时 ripgrep 的匹配不能被丢掉").toMatch(/rg-only\.txt:1:from-ripgrep/);
	expect(text, "不该再让内置扫描器重搜一遍").not.toMatch(/from-fallback/);
	expect(text, "要说清楚有多少处读不了").toMatch(/5 errors/);
	expect(text, "要给出错误原文，模型才知道缺的是哪里").toMatch(/denied-0: Permission denied/);
	expect(text, "只列前几条，其余给个数").toMatch(/2 more/);
});

it.skipIf(NO_SHELL_SPAWN)("只列文件时同样：退出码 2 带着匹配不算失败", async () => {
	const { dir } = await withFakeRg({ errors: 1, match: true, summary: false, exit: 2 });
	const text = textOf(await grepTool.execute({ pattern: "from", files_only: true }, ctx(dir)));
	expect(text).toMatch(/rg-only\.txt/);
	expect(text).not.toMatch(/sample\.txt/);
});

it.skipIf(NO_SHELL_SPAWN)("rg 搜完了（有 summary）但没找到、只是有路径读不了：直接回答没有，不再慢扫一遍", async () => {
	const { dir } = await withFakeRg({ errors: 2, match: false, summary: true, exit: 2 });
	const res = await grepTool.execute({ pattern: "from" }, ctx(dir));
	const text = textOf(res);
	expect(text, "ripgrep 已经搜完了，内置扫描器不该接手").not.toMatch(/from-fallback/);
	expect(text).toMatch(/No matches/);
	expect(text).toMatch(/2 errors/);
});

it.skipIf(NO_SHELL_SPAWN)("正则 rg 编不过（退出码 2、没有任何输出）：仍然交给内置扫描器", async () => {
	// ripgrep 的引擎没有环视，JavaScript 的有：这次交接要保住。
	const { dir } = await withFakeRg({ stderr: "rg: regex parse error:", match: false, summary: false, exit: 2 });
	const text = textOf(await grepTool.execute({ pattern: "(?<=from-)fallback" }, ctx(dir)));
	expect(text).toMatch(/sample\.txt:1:from-fallback/);
});

it.skipIf(NO_SHELL_SPAWN)("调用 rg 时带上 --crlf", async () => {
	const { dir, argv } = await withFakeRg({ match: false, summary: true, exit: 1 });
	await grepTool.execute({ pattern: "x$" }, ctx(dir));
	await grepTool.execute({ pattern: "x$", files_only: true }, ctx(dir));
	const log = await argv();
	expect(log.filter((arg) => arg === "--crlf").length, `两次调用都要带 --crlf，实际参数：${log.join(" ")}`).toBe(2);
});

for (const fallback of [false, true]) {
	it(`CRLF 与 BOM 文件：$ 与 ^ 照常锚定，输出里不带 \\r (fallback=${fallback})`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "plume-grep-crlf-"));
		onTestFinished(() => rm(dir, { recursive: true, force: true }));
		await writeFile(join(dir, "crlf.txt"), "\uFEFFhead foo\r\nbeta\r\nfoo\r\n");
		const path = process.env.PATH;
		if (fallback) process.env.PATH = "";
		onTestFinished(() => {
			process.env.PATH = path;
		});

		const tail = textOf(await grepTool.execute({ pattern: "foo$" }, ctx(dir)));
		expect(tail, "行尾是 \\r\\n 的行，foo$ 也要匹配").toMatch(/crlf\.txt:1:head foo$/m);
		expect(tail).toMatch(/crlf\.txt:3:foo$/m);
		expect(!tail.includes("\r"), "输出给模型的行不能带 \\r").toBe(true);

		const head = textOf(await grepTool.execute({ pattern: "^head" }, ctx(dir)));
		expect(head, "第一行前面的 BOM 不能挡住 ^").toMatch(/crlf\.txt:1:head foo$/m);
		expect(!head.includes("\uFEFF"), "输出里不能带 BOM").toBe(true);
	});
}
