/**
 * 裸的 `cat a.txt` 改道，`cat a.txt | wc -l` 放行：判据本身，以及 bash 真的会去查、tool-run 真的会当场改用本体工具。
 */

import { expect, it } from "vitest";
import { bashTool } from "../../src/tools/bash.ts";
import { rerouteShellCommand, translatedShellCommand } from "../../src/tools/reroute.ts";
import { withFiles } from "../files.ts";

const ALL = new Set(["read", "grep", "glob", "ls", "bash"]);

it("裸的 cat/head、读一段的 sed -n 改道到 read", () => {
	expect(rerouteShellCommand("cat src/a.ts", ALL)?.tool).toBe("read");
	expect(rerouteShellCommand("head -20 README.md", ALL)?.tool).toBe("read");
	expect(rerouteShellCommand("head -n 20 README.md", ALL)?.tool).toBe("read");
	expect(rerouteShellCommand("sed -n '120,180p' src/a.ts", ALL)?.tool).toBe("read");
	// head 说的是 limit，sed 说的是 offset：照着话做就是对的调用。
	expect(rerouteShellCommand("head -20 README.md", ALL)?.message).toMatch(/`limit`/);
	expect(rerouteShellCommand("sed -n '120,180p' src/a.ts", ALL)?.message).toMatch(/`offset`/);
});

it("开头 cd 进目录再读也改道，并说工具不认 cd", () => {
	// 以前 `&&` 一律当成组合放行，`cd x && sed -n …` 这种最常见的读法一次都没拦住。
	const reroute = rerouteShellCommand("cd packages/app && sed -n '1,80p' src/main.ts", ALL);
	expect(reroute?.tool).toBe("read");
	expect(reroute?.message).toMatch(/不认 `cd`/);
	expect(rerouteShellCommand("cd /repo && grep -rn foo src", ALL)?.tool).toBe("grep");
	expect(rerouteShellCommand("cd a && cat x && echo done", ALL)).toBeNull();
	expect(rerouteShellCommand("cat src/a.ts", ALL)?.message).not.toMatch(/cd/);
});

it("工具做不到的放行：tail、数行、反选、递归列目录、按时间排", () => {
	for (const beyond of [
		"tail -n 50 log.txt",
		"tail log.txt",
		"grep -c foo src/a.ts",
		"grep -v foo a.txt",
		"grep -rno foo src",
		"rg -c TODO src",
		"rg -t ts foo",
		"ls -R src",
		"ls -lt src",
		"cat -A a.txt",
		"head -c 100 a.bin",
		"sed -n '/start/,/end/p' a.txt",
		"sed -i 's/a/b/' a.txt",
	]) {
		expect(rerouteShellCommand(beyond, ALL), beyond).toBeNull();
	}
	for (const same of ["grep -rni foo src", "grep -C 3 foo a.ts", "grep -rn --include=*.ts foo .", "rg -n -g '*.ts' foo", "ls -lah src", "cat -n a.ts"]) {
		expect(rerouteShellCommand(same, ALL), same).not.toBeNull();
	}
});

it("跟着文件看的 tail 放行：read 跟不了", () => {
	for (const follow of ["tail -f app.log", "tail -F app.log", "tail -fn 100 app.log", "tail -n 20 -f app.log", "tail --follow=name app.log"]) {
		expect(rerouteShellCommand(follow, ALL), follow).toBeNull();
	}
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

it("find/fd 只在 glob 做得到时改道：带删除、执行、大小、时间这类条件的放行", () => {
	// glob 只会按名字模式找文件；叫模型去用 glob，它就得丢掉 `-delete`、`-size` 这些。
	for (const same of ["find src", "find . -name '*.ts'", "find src lib -type f -name x", "fd foo src", "fd -e ts", "fd -t f -g '*.md' docs"]) {
		expect(rerouteShellCommand(same, ALL)?.tool, same).toBe("glob");
	}
	for (const more of [
		"find . -name '*.pyc' -delete",
		"find . -name '*.log' -exec rm {} +",
		"find . -size +1M",
		"find . -mtime -1",
		"find . -newer package.json",
		"find . -type d -name node_modules",
		"find . -maxdepth 1 -name x",
		"find . \\( -name a -o -name b \\)",
		"find . ! -name x",
		"find . -name",
		"fd -x rm",
		"fd -H foo",
		"fd --changed-within 1d",
		"fd -t d foo",
		"fd a b c",
	]) {
		expect(rerouteShellCommand(more, ALL), more).toBeNull();
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
	 * 一个只有 bash 的会话里说「用 read」，是把模型推向一个不存在的门。
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
	const result = await bashTool.execute({ command: "ls -la src" }, withFiles({ cwd: process.cwd(), state: new Map(), toolNames: ALL }));
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
