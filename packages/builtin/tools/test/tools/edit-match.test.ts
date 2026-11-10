/**
 * `old_string` 和文件不是逐字节相同时的 edit：几种近似读法。
 *
 * 每种读法都对应模型真会犯的抄错。对所有读法都要成立的：只有一处近似时替换它，有几处时拒绝而不是猜，
 * `new_string` 按文件自己的样子落地——它的引号，不带行号前缀，不带写出来的转义。
 */

import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { findEditMatch } from "../../src/tools/edit-match.ts";
import { editTool } from "../../src/tools/edit.ts";
import { readTool } from "../../src/tools/read.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";

const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("");

async function edited(content: string, oldString: string, newString: string) {
	const dir = await mkdtemp(join(tmpdir(), "plume-edit-match-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "sample.txt");
	await writeFile(file, content, "utf8");
	const ctx: ToolContext = { cwd: dir, state: new Map() };
	await readTool.execute({ path: file } as never, ctx);
	const result = await editTool.execute({ path: file, old_string: oldString, new_string: newString }, ctx);
	return { result, text: await readFile(file, "utf8"), file, ctx };
}

it("从 read 抄来的行号前缀，两边都去掉", async () => {
	const { result, text } = await edited("alpha\nbravo\ncharlie\n", "2→bravo\n3→charlie", "2→BRAVO\n3→CHARLIE");
	expect(result.isError, textOf(result)).toBeUndefined();
	expect(text).toBe("alpha\nBRAVO\nCHARLIE\n");
});

it("直引号找得到弯引号，替换后保留文件里的弯引号", async () => {
	const { result, text } = await edited("She said “hello” and left.\n", 'said "hello"', 'said "goodbye"');
	expect(result.isError, textOf(result)).toBeUndefined();
	expect(text).toBe("She said “goodbye” and left.\n");
});

it("old_string 里写出来的转义匹配真实字符", async () => {
	const { result, text } = await edited("a\tb\n", "a\\tb", "a\\tc");
	expect(result.isError, textOf(result)).toBeUndefined();
	expect(text).toBe("a\tc\n");
});

it("行尾空格不挡匹配，换行被替换而不是重复", async () => {
	const { result, text } = await edited("one  \ntwo\nthree\n", "one\ntwo\n", "ONE\nTWO\n");
	expect(result.isError, textOf(result)).toBeUndefined();
	expect(text).toBe("ONE\nTWO\nthree\n");
});

it("缩进不同的一块找得到", () => {
	const match = findEditMatch("\tif (x) {\n\t\ty();\n\t}\n", "if (x) {\n\ty();\n}", false);
	expect(match).toEqual({ status: "matched", actual: "\tif (x) {\n\t\ty();\n\t}", strategy: "line_trimmed" });
});

it("首尾行对得上、中间相近的一块找得到", () => {
	const content = "function f() {\n\tconst total = a + b;\n\treturn total;\n}\n";
	const match = findEditMatch(content, "function f() {\n\tconst total = a+b;\n\treturn total;\n}", false);
	expect(match.status).toBe("matched");
	expect(match.status === "matched" && match.strategy).toBe("block_anchor");
});

it("两处不同的近似文本：拒绝，不去猜", async () => {
	const { result, text } = await edited("x = 1  \ny = 2\n\nx = 1\t\ny = 2\n", "x = 1\ny = 2", "z");
	expect(result.isError).toBe(true);
	expect(textOf(result)).toMatch(/come close/);
	expect(text).toBe("x = 1  \ny = 2\n\nx = 1\t\ny = 2\n");
});

it("replace_all 不用按行形状的读法", () => {
	expect(findEditMatch("one  \ntwo\n", "one\ntwo", true)).toEqual({ status: "not_found" });
});

it("差得远的文本仍是找不到", () => {
	expect(findEditMatch("alpha\nbravo\n", "charlie", false)).toEqual({ status: "not_found" });
});

it("大小不变、修改时间更晚，也算改过", async () => {
	const { file, ctx } = await edited("alpha\n", "alpha", "bravo");
	await writeFile(file, "ALPHA\n", "utf8");
	const later = new Date(Date.now() + 5_000);
	await utimes(file, later, later);
	const result = await editTool.execute({ path: file, old_string: "ALPHA", new_string: "x" }, ctx);
	expect(result.isError).toBe(true);
	expect(textOf(result)).toMatch(/changed since you read it/);
});
