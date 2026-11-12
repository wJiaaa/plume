import { expect, it } from "vitest";
import { TOOL_LINES } from "../src/tool-lines.ts";

/** 本体不认工具名：转录里的说法、归类、文件签都只看这张表，这里钉住每个工具声明了什么。 */
it("每个工具声明它做的是哪种活，读写的文件、命令、说明和后台任务从参数里取", () => {
	expect(Object.fromEntries(Object.entries(TOOL_LINES).map(([tool, line]) => [tool, line.kind]))).toEqual({
		read: "view",
		ls: "list",
		glob: "find",
		grep: "search",
		write: "create",
		edit: "modify",
		bash: "command",
		bash_output: undefined,
		monitor: "command",
	});
	const { read, ls, write, bash, bash_output: output, grep } = TOOL_LINES;
	expect(read!.file!({ path: "a.ts" })).toEqual({ path: "a.ts" });
	expect(read!.file!({ path: "a.ts", offset: 10, limit: 20 })).toEqual({ path: "a.ts", lines: { from: 10, to: 29 } });
	expect(read!.file!({ path: "a.ts", offset: 5 })).toEqual({ path: "a.ts", lines: { from: 5 } });
	expect(read!.file!({ path: "a.ts", limit: 3, offset: null })).toEqual({ path: "a.ts", lines: { from: 1, to: 3 } });
	expect(read!.file!({})).toBeUndefined();
	// 没给目录是工作目录。
	expect(ls!.file!({})).toEqual({ path: "" });
	expect(write!.file!({ path: "b.ts", content: "x" })).toEqual({ path: "b.ts" });
	expect(bash!.command!({ command: "ls" })).toBe("ls");
	expect(bash!.command!({})).toBeUndefined();
	expect(grep!.note!({ pattern: "x", description: "找 x" })).toBe("找 x");
	expect(output!.job!({ id: "j1" })).toEqual({ id: "j1", stop: false });
	expect(output!.job!({ id: "j1", kill: true })).toEqual({ id: "j1", stop: true });
	expect(output!.job!({ id: 3 })).toEqual({ stop: false });
});
