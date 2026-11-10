/**
 * read 的大纲视图。
 *
 * 最要紧的是最后一组：折叠不能放宽模型能编辑的范围。被当成整个文件的大纲比没有大纲更糟，所以出过大纲之后，
 * 文件里什么都不能编辑，直到一次指明了窗口的读。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { editTool } from "../../src/tools/edit.ts";
import { outline, outlineFooter } from "../../src/tools/outline.ts";
import { readTool } from "../../src/tools/read.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";

/** 有真实结构的文件：声明、文档注释、值得折叠的函数体。 */
function sourceFile(functions = 24): string {
	const head = `/**\n * Module header.\n * Explains why this exists.\n */\n\nimport { a } from "./a.ts";\nimport { b } from "./b.ts";\n\n`;
	const body = Array.from({ length: functions }, (_, i) => {
		const filler = Array.from({ length: 8 }, (_, j) => `\tconst step${j} = compute(${i}, ${j});`).join("\n");
		return `/** Does thing ${i}. */\nexport function thing${i}(input: string): number {\n${filler}\n\treturn ${i};\n}\n`;
	}).join("\n");
	return head + body;
}

async function fixture(name: string, content: string): Promise<{ file: string; ctx: ToolContext }> {
	const dir = await mkdtemp(join(tmpdir(), "plume-outline-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, name);
	await writeFile(file, content, "utf8");
	return { file, ctx: { cwd: dir, state: new Map() } };
}

const textOf = (res: ToolResult) => res.content[0]?.text ?? "";

function linesOf(content: string): string[] {
	const lines = content.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

// ---------------------------------------------------------------------------
// 什么时候折叠，什么时候不折
// ---------------------------------------------------------------------------

it("长源码文件读回来是大纲", async () => {
	const { file, ctx } = await fixture("mod.ts", sourceFile());
	const res = await readTool.execute({ path: file } as never, ctx);
	const text = textOf(res);
	expect(text, "函数体要折叠").toMatch(/⋯ \d+ lines/);
	expect(text, "声明要留下").toMatch(/export function thing0/);
	expect(text, "文档注释跟着它的声明").toMatch(/Does thing 0/);
	expect(text, "函数体里的行要拿掉").not.toMatch(/const step3 =/);
	expect((res.details as { outlined?: boolean }).outlined).toBe(true);
});

it("页脚说怎么拿回折起来的行，并且不许猜", async () => {
	const { file, ctx } = await fixture("mod.ts", sourceFile());
	const text = textOf(await readTool.execute({ path: file } as never, ctx));
	expect(text, "要说出取一段范围的方法").toMatch(/offset/);
	expect(text, "要禁止猜折起来的内容").toMatch(/绝不要猜测/);
});

it("大纲里很长的声明开窗口，并提到 char_offset", () => {
	const content = sourceFile().replace(
		`import { b } from "./b.ts";\n`,
		`import { b } from "./b.ts";\nexport const blob = "${"x".repeat(80_000)}NEEDLE-TAIL";\n`,
	);
	const result = outline("mod.ts", content, linesOf(content));
	expect(result, "这个样本必须出大纲").toBeTruthy();
	expect(result!.text).not.toMatch(/NEEDLE-TAIL/);
	expect(result!.longLines.length >= 1).toBe(true);
	expect(outlineFooter("mod.ts", result!, linesOf(content).length)).toMatch(/char_offset/);
});

it("短文件原样返回", async () => {
	const { file, ctx } = await fixture("small.ts", "export const a = 1;\nexport const b = 2;\n");
	const text = textOf(await readTool.execute({ path: file } as never, ctx));
	expect(text).not.toMatch(/⋯/);
	expect(text).toMatch(/1→export const a = 1;/);
});

it("明确给了窗口的从不折叠", async () => {
	const { file, ctx } = await fixture("mod.ts", sourceFile());
	const text = textOf(await readTool.execute({ path: file, offset: 10, limit: 20 } as never, ctx));
	expect(text, "调用方已经说了看哪里").not.toMatch(/⋯ \d+ lines/);
	expect(text, "窗口读要有函数体里的行").toMatch(/const step0/);
});

it("不到 300 行的源码整个返回：折叠它多出的请求比省下的多", async () => {
	const content = sourceFile(20);
	expect(linesOf(content).length < 300).toBe(true);
	const { file, ctx } = await fixture("mod.ts", content);
	expect(textOf(await readTool.execute({ path: file } as never, ctx))).not.toMatch(/⋯ \d+ lines/);
});

it("解析不了的文件原样返回", async () => {
	// 很长，但不是声明模式认得的语言。
	const prose = Array.from({ length: 200 }, (_, i) => `line ${i} of ordinary prose`).join("\n") + "\n";
	const { file, ctx } = await fixture("notes.md", prose);
	const text = textOf(await readTool.execute({ path: file } as never, ctx));
	expect(text).not.toMatch(/⋯ \d+ lines/);
});

it("几乎全是声明的文件不折叠：没什么可省的", () => {
	const decls = Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i};`).join("\n") + "\n";
	expect(outline("types.ts", decls, linesOf(decls))).toBeNull();
});

it("声明之间很短的一段保持原样，不变成折叠标记", () => {
	const content = sourceFile(2) + Array.from({ length: 70 }, (_, i) => `export const tail${i} = ${i};`).join("\n") + "\n";
	const result = outline("mod.ts", content, linesOf(content));
	// 不管怎么决定，都不能为比标记本身还少的行出一个标记。
	if (result) {
		for (const match of result.text.matchAll(/⋯ (\d+) lines/g)) {
			expect(Number(match[1]) >= 4, `a ${match[1]}-line fold is not worth a marker`).toBe(true);
		}
	}
});

// ---------------------------------------------------------------------------
// 折叠不能放宽能编辑的范围
// ---------------------------------------------------------------------------

it("出过大纲之后，编辑折起来的函数体被拒", async () => {
	const content = sourceFile();
	const { file, ctx } = await fixture("mod.ts", content);
	const text = textOf(await readTool.execute({ path: file } as never, ctx));

	// 找第一个折叠里的一个行号。
	const fold = /⋯ \d+ lines \((\d+)-(\d+)\)/.exec(text);
	expect(fold, "样本至少要折出一处").toBeTruthy();
	const insideFold = Number(fold![1]);

	const folded = linesOf(content)[insideFold - 1]!;
	const edit = await editTool.execute({ path: file, old_string: folded, new_string: "\tconst tampered = 1;" }, ctx);
	expect(edit.isError).toBe(true);
	expect(textOf(edit)).toMatch(/did not show the whole file[\s\S]*offset and limit/);
	expect(await readFile(file, "utf8")).toBe(content);
});

it("出过大纲之后，就算是显示过的行也要等一次窗口读", async () => {
	const content = sourceFile();
	const { file, ctx } = await fixture("mod.ts", content);
	const text = textOf(await readTool.execute({ path: file } as never, ctx));

	const shown = /^\s*(\d+)→export function thing0/m.exec(text);
	expect(shown, "大纲必须显示这条声明").toBeTruthy();
	const line = Number(shown![1]);

	const edit = await editTool.execute(
		{ path: file, old_string: linesOf(content)[line - 1]!, new_string: "export function thing0(input: string, extra = 0): number {" },
		ctx,
	);
	expect(edit.isError).toBe(true);
	expect(await readFile(file, "utf8")).toBe(content);
});

it("大纲之后读一段范围，才放宽能编辑的范围", async () => {
	const content = sourceFile();
	const { file, ctx } = await fixture("mod.ts", content);
	const text = textOf(await readTool.execute({ path: file } as never, ctx));
	const fold = /⋯ \d+ lines \((\d+)-(\d+)\)/.exec(text);
	const from = Number(fold![1]);
	const to = Number(fold![2]);

	// 读这段之前拒绝……
	const target = linesOf(content)[from - 1]!;
	const before = await editTool.execute({ path: file, old_string: target, new_string: "\tconst ok = 1;" }, ctx);
	expect(before.isError).toBe(true);

	// ……读过之后放行。
	await readTool.execute({ path: file, offset: from, limit: to - from + 1 } as never, ctx);
	const after = await editTool.execute({ path: file, old_string: target, new_string: "\tconst ok = 1;" }, ctx);
	expect(after.isError, textOf(after)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 大纲本身
// ---------------------------------------------------------------------------

it("大纲里每一行不是显示了就是折起来了", () => {
	const content = sourceFile();
	const lines = linesOf(content);
	const result = outline("mod.ts", content, lines);
	expect(result).toBeTruthy();
	expect(result!.shownLines + result!.foldedLines).toBe(lines.length);
});
