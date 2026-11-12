import { expect, it } from "vitest";
import { bashOutputTool, bashTool } from "../../src/tools/bash.ts";
import { editTool } from "../../src/tools/edit.ts";
import { globTool } from "../../src/tools/glob.ts";
import { grepTool } from "../../src/tools/grep.ts";
import { lsTool } from "../../src/tools/ls.ts";
import { monitorTool } from "../../src/tools/monitor.ts";
import { readTool } from "../../src/tools/read.ts";
import { writeTool } from "../../src/tools/write.ts";

/** 本体不认工具名：导出会话的那一行、重复检测按改文件清零，都只看工具定义上的声明。 */
it("导出会话时每个工具写成的那一行由工具自己给", () => {
	expect(readTool.describe!({ path: "src/a.ts" })).toBe("Read src/a.ts");
	expect(readTool.describe!({})).toBe("Read file");
	expect(writeTool.describe!({ path: "a.ts" })).toBe("Write a.ts");
	expect(editTool.describe!({ path: "a.ts" })).toBe("Edit a.ts");
	expect(lsTool.describe!({})).toBe("List .");
	expect(globTool.describe!({ pattern: "**/*.ts" })).toBe("Find **/*.ts");
	expect(grepTool.describe!({ pattern: "foo" })).toBe('Search "foo"');
	expect(grepTool.describe!({})).toBe("Search");
	expect(bashTool.describe!({ command: "pnpm test\necho done" })).toBe("pnpm test");
	expect(bashTool.describe!({ command: "ls", description: "列文件" })).toBe("列文件");
	expect(bashTool.describe!({})).toBe("bash");
	expect(bashTool.describe!({ command: "" })).toBe("Run bash command");
	expect(monitorTool.describe!({ command: "tail -f log" })).toBe("tail -f log");
	expect(bashOutputTool.describe!({ id: "j" })).toBe("Check job");
	expect(bashOutputTool.describe!({ id: "j", kill: true })).toBe("Stop job");
});
