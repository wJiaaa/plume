/**
 * read 读一份文档，读到的是里面的字。
 *
 * 守的是接线，不是抽取本身：扩展名在不在清单里、抽取失败要不要退回二进制那条路，这些判断都在工具里，
 * 断过——同一份文件，人拖进输入框能抽出字，模型自己去读却被当成二进制拒绝。所以这里走工具本身。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, expect, it } from "vitest";
import { readTool } from "../../src/tools/read.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";

const dir = mkdtempSync(join(tmpdir(), "plume-read-docs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const context = (): ToolContext => ({ cwd: dir, state: new Map() });

const textOf = (result: ToolResult) => result.content[0]?.text ?? "";

/** 一份真的 docx：zip 加 OOXML，和 Word 写出来的是同一种东西。 */
function writeDocx(name: string, paragraphs: string[]): string {
	const body = paragraphs.map((line) => `<w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`).join("");
	const path = join(dir, name);
	writeFileSync(
		path,
		Buffer.from(
			zipSync({
				"[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
				"word/document.xml": strToU8(
					`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
				),
			}),
		),
	);
	return path;
}

it("模型自己去读一份 docx，读到的是正文", async () => {
	writeDocx("交接说明.docx", ["交接说明", "这一段是正文，模型该读得到。"]);
	const result = await readTool.execute({ path: "交接说明.docx" }, context());

	expect(Boolean(result.isError), "不能是「看起来是二进制文件」").toBe(false);
	const text = textOf(result);
	expect(text).toMatch(/交接说明/);
	expect(text).toMatch(/这一段是正文/);
	expect((result.details as { kind?: string } | undefined)?.kind).toBe("document");
});

it("表格按工作表出，一张表一块", async () => {
	// SheetJS 写出来的那种共享字符串表，和手写的 XML 片段不是一回事——所以用它自己写。
	const { utils, write } = await import("xlsx");
	const book = utils.book_new();
	utils.book_append_sheet(
		book,
		utils.aoa_to_sheet([
			["门店", "数量"],
			["花园里店", 12],
		]),
		"陈列",
	);
	utils.book_append_sheet(
		book,
		utils.aoa_to_sheet([
			["月份", "金额"],
			["九月", 3400],
		]),
		"对账",
	);
	writeFileSync(join(dir, "台账.xlsx"), write(book, { type: "buffer", bookType: "xlsx" }));

	const text = textOf(await readTool.execute({ path: "台账.xlsx" }, context()));
	expect(text).toMatch(/## 陈列/);
	expect(text).toMatch(/花园里店,12/);
	expect(text, "第二张表也要在——只读第一张是这类实现最常见的漏法").toMatch(/## 对账/);
	expect(text).toMatch(/九月,3400/);
});

it("不在清单里的二进制，照旧拒绝", async () => {
	// 抽取在二进制判定之前试，要确认它没把所有二进制都放进来：可执行文件仍该挡在外面。
	writeFileSync(join(dir, "a.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
	const result = await readTool.execute({ path: "a.bin" }, context());
	expect(Boolean(result.isError)).toBe(true);
});

it("一份坏掉的 docx 不会把工具带崩", async () => {
	// 扩展名在清单里、内容却不是 zip。抽取失败要退回原来那条路，而不是抛出去。
	writeFileSync(join(dir, "坏的.docx"), Buffer.from([0, 1, 2, 3, 0, 255]));
	const result = await readTool.execute({ path: "坏的.docx" }, context());
	expect(Boolean(result.isError), "读不成就说读不成，不该是一次崩溃").toBe(true);
});

it("纯文本照旧按行读，没被这条新路抢走", async () => {
	writeFileSync(join(dir, "readme.md"), "# 标题\n正文\n");
	const result = await readTool.execute({ path: "readme.md" }, context());
	expect(Boolean(result.isError)).toBe(false);
	expect(textOf(result)).toMatch(/标题/);
	expect((result.details as { kind?: string } | undefined)?.kind).not.toBe("document");
});
