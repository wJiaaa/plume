/**
 * read 一个大到不该整个读进来的文件。
 *
 * 超过 `STREAM_ABOVE_BYTES` 的文件流式读，而不是 `readFile` 再 split；答案要和小文件那条路一样：同样的行、
 * 页脚里同样的行数、同样的续读 `offset`。先跨着流的分块边界直接和 `split` 比，再经工具端到端比。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { LINE_KEEP_BYTES, readLineWindow, STREAM_ABOVE_BYTES } from "../../src/tools/large-text.ts";
import { readTool } from "../../src/tools/read.ts";
import { decodeText } from "../../src/tools/text-layout.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";
import { withFiles } from "../files.ts";

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-read-large-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** 小文件那条路对同一段文本的切法。 */
function splitLines(text: string): string[] {
	const lines = decodeText(text).text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

const ctx = (cwd: string): ToolContext => withFiles({ cwd, state: new Map() });
const textOf = (res: ToolResult) => res.content.map((part) => part.text).join("");

it("流式读出的窗口就是 split 给的窗口", async () => {
	const dir = await scratch();
	const cases: Record<string, string> = {
		trailing: "a\nb\nc\n",
		bare: "a\nb\nc",
		empty: "",
		newline: "\n",
		blank: "a\n\n\nb\n",
		crlf: "one\r\ntwo\r\nthree\r\n",
		bom: "\uFEFFfirst\nsecond\n",
		unicode: "日本語\n😀 emoji\n",
	};
	for (const [name, text] of Object.entries(cases)) {
		const file = join(dir, `${name}.txt`);
		await writeFile(file, text);
		const expected = splitLines(text);
		const got = await readLineWindow(file, 1, 2000, 0, Number.MAX_SAFE_INTEGER);
		expect(got.totalLines, `${name}: line count`).toBe(expected.length);
		expect(got.lines, `${name}: lines`).toEqual(expected);
	}
});

it("跨流分块的行完整出来", async () => {
	const dir = await scratch();
	// 约 3 MB，行长不整除 1 MB 的分块，含多字节字符。
	const text = Array.from({ length: 30_000 }, (_, i) => `${i}:${"é".repeat(i % 97)}${"x".repeat(i % 13)}`).join("\n");
	const file = join(dir, "straddle.txt");
	await writeFile(file, text);
	const expected = splitLines(text);
	for (const offset of [1, 5_000, 11_111, 29_990]) {
		const got = await readLineWindow(file, offset, 50, 0, Number.MAX_SAFE_INTEGER);
		expect(got.totalLines).toBe(expected.length);
		expect(got.lines, `offset ${offset}`).toEqual(expected.slice(offset - 1, offset - 1 + 50));
	}
});

it("超过流式门槛的文件读起来和别的一样，但不整个读进来", async () => {
	const dir = await scratch();
	const file = join(dir, "big.log");
	const count = 120_000;
	await writeFile(file, Array.from({ length: count }, (_, i) => `entry ${i + 1} ${"z".repeat(70)}`).join("\n") + "\n");

	const bare = await readTool.execute({ path: file }, ctx(dir));
	const shown = Number(new RegExp(`showing lines 1-(\\d+) of ${count} \\(output capped`).exec(textOf(bare))?.[1]);
	expect(shown > 100 && shown < 2000, `不带窗口的读被输出上限截断，并说从哪里接着读：${shown}`).toBe(true);
	expect(textOf(bare)).toMatch(new RegExp(`offset=${shown + 1}`));

	const deep = await readTool.execute({ path: file, offset: 100_000, limit: 3 }, ctx(dir));
	const deepText = textOf(deep);
	expect(deepText).toMatch(/100000→entry 100000 z+\n100001→entry 100001 z+\n100002→entry 100002 z+/);
	expect(deepText).toMatch(new RegExp(`showing lines 100000-100002 of ${count};`));
	expect((deep.details as { totalLines: number }).totalLines).toBe(count);

	const past = await readTool.execute({ path: file, offset: count + 1 }, ctx(dir));
	expect(past.isError).toBe(true);
	expect(textOf(past)).toMatch(new RegExp(`past the end of the file \\(${count} lines\\)`));
	expect(STREAM_ABOVE_BYTES < 120_000 * 80, "样本要大到走流式那条路").toBe(true);
});

it("很大的二进制照样拒绝；长到留不下的行要说出来", async () => {
	const dir = await scratch();
	const binary = join(dir, "blob.bin");
	await writeFile(binary, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(STREAM_ABOVE_BYTES + 1, 65)]));
	const refused = await readTool.execute({ path: binary }, ctx(dir));
	expect(refused.isError).toBe(true);
	expect(textOf(refused)).toMatch(/looks like a binary file/);

	// 整个文件一行：压缩过的 bundle 的样子。
	const minified = join(dir, "bundle.min.js");
	await writeFile(minified, `${"q".repeat(5000)}NEEDLE${"w".repeat(STREAM_ABOVE_BYTES)}`);
	const head = textOf(await readTool.execute({ path: minified }, ctx(dir)));
	expect(head).toMatch(/line 1 is longer than 1 MB; only the first 1 MB can be read/);
	const further = textOf(await readTool.execute({ path: minified, char_offset: 5001 }, ctx(dir)));
	expect(further, "char_offset 仍能读到这一行留下的部分").toMatch(/1→… \[5000 characters omitted\] NEEDLE/);
	expect(LINE_KEEP_BYTES < STREAM_ABOVE_BYTES).toBe(true);
});
