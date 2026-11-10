/**
 * 裸的 `cat a.txt` 改道，`cat a.txt | wc -l` 放行：判据本身，以及 bash 真的会去查、tool-run 真的会当场改用本体工具。
 */

import { expect, it } from "vitest";
import { bashTool } from "../../src/tools/bash.ts";
import { rerouteShellCommand, translatedShellCommand } from "../../src/tools/reroute.ts";

const ALL = new Set(["read", "grep", "glob", "ls", "bash"]);

it("裸的 cat/head/tail 改道到 read", () => {
	expect(rerouteShellCommand("cat src/a.ts", ALL)?.tool).toBe("read");
	expect(rerouteShellCommand("head -20 README.md", ALL)?.tool).toBe("read");
	expect(rerouteShellCommand("  tail -n 50 log.txt", ALL)?.tool).toBe("read");
});

it("裸的 grep/rg、find/fd、ls 各改道到对应工具", () => {
	expect(rerouteShellCommand("grep -rn foo src", ALL)?.tool).toBe("grep");
	expect(rerouteShellCommand("rg 'TODO' .", ALL)?.tool).toBe("grep");
	expect(rerouteShellCommand("find . -name '*.ts'", ALL)?.tool).toBe("glob");
	expect(rerouteShellCommand("ls -la src", ALL)?.tool).toBe("ls");
});

it("有管道、重定向、串联就放行——那是真的在组合", () => {
	/*
	 * `cat a | wc -l` 在算行数，`cat a > b` 在复制，`cat a && echo` 在串联。每一种都有 `read`
	 * 给不了的东西。拦了它们，模型下一步就是把同一件事拆成三次调用。
	 */
	for (const composed of [
		"cat a.txt | wc -l",
		"cat a.txt > b.txt",
		"cat a.txt >> b.txt",
		"cat a.txt && echo done",
		"cat a.txt; echo done",
		"grep foo src | head",
		"find . -name x | xargs rm",
		"ls -la | grep ts",
		"cat $(ls | head -1)",
		"cat `ls | head -1`",
		"sort < a.txt",
	]) {
		expect(rerouteShellCommand(composed, ALL), composed).toBeNull();
	}
});

it("不在表里的命令不管", () => {
	for (const other of ["echo hi", "pnpm test", "git status", "node x.js", "cat"]) {
		expect(rerouteShellCommand(other, ALL), other).toBeNull();
	}
});

it("多行脚本放行", () => {
	// 第一行是 cat 的多行脚本，后面多半跟着别的东西；那是脚本，不是「一次 cat」。
	expect(rerouteShellCommand("cat a.txt\necho done", ALL)).toBeNull();
});

it("建议的工具不在这个会话里就放行", () => {
	/*
	 * 一个 `allowed-tools: [bash]` 的技能会话里说「用 read」，是把模型推向一个不存在的门。
	 * 它会照着做、被拒、再试 cat、再被拦——直到轮次用完。
	 */
	const bashOnly = new Set(["bash"]);
	expect(rerouteShellCommand("cat a.txt", bashOnly)).toBeNull();
	expect(rerouteShellCommand("grep x .", new Set(["bash", "read"])), "有 read 没 grep").toBeNull();
});

it("没有工具名集合就一律放行——那是开关关了", () => {
	expect(rerouteShellCommand("cat a.txt", undefined)).toBeNull();
});

it("改道的话里说的是建议的那个工具", () => {
	// 消息就是工具结果，模型靠它决定下一步。说错工具名等于指错路。
	expect(rerouteShellCommand("cat a.txt", ALL)?.message ?? "").toMatch(/`read`/);
	expect(rerouteShellCommand("find . -name x", ALL)?.message ?? "").toMatch(/`glob`/);
});

it("bash 工具真的会查有哪些工具：改道是错误，但 details 说清它是一次改道", async () => {
	const result = await bashTool.execute({ command: "ls -la src" }, { cwd: process.cwd(), state: new Map(), toolNames: ALL });
	expect(result.isError).toBe(true);
	expect(result.content.map((part) => part.text).join("")).toMatch(/`ls`/);
	expect(result.details).toEqual({ kind: "reroute", tool: "ls" });
});

it("无歧义的 cat、ls、rg 翻译成本体工具的参数，组合和不认识的旗标不翻译", () => {
	expect(translatedShellCommand("cat src/a.ts")).toEqual({ name: "read", args: { path: "src/a.ts" } });
	expect(translatedShellCommand("ls -la src")).toEqual({ name: "ls", args: { path: "src", all: true } });
	expect(translatedShellCommand("rg -n needle src")).toEqual({ name: "grep", args: { pattern: "needle", path: "src" } });
	for (const command of ["cat a.txt | wc -l", "cat -n a.txt", "ls -R src", "rg 'a.b' src", "cat ~/x", "head a.txt"])
		expect(translatedShellCommand(command), command).toBeNull();
});
