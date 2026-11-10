/**
 * 超过上限的长行仍然取得到。弄爆过会话的模型目录是一行 1.7 MB，只截取行首，后面就再也够不着。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { editTool } from "../../src/tools/edit.ts";
import { readTool } from "../../src/tools/read.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";

const NAME = "Qwen3-LiveTranslate Flash Realtime";

const textOf = (res: ToolResult) => res.content[0]?.text ?? "";

async function workspace(content: string, name = "catalog.json"): Promise<{ file: string; ctx: ToolContext }> {
	const dir = await mkdtemp(join(tmpdir(), "plume-read-long-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, name);
	await writeFile(file, content, "utf8");
	return { file, ctx: { cwd: dir, state: new Map() } };
}

it("默认读一条长行，不假装后面没有了", async () => {
	const needle = "MID-LINE-NEEDLE-7K2M";
	const content = `${"a".repeat(80_000)}"id":"${needle}"${"b".repeat(80_000)}`;
	const { file, ctx } = await workspace(content);
	const first = textOf(await readTool.execute({ path: file } as never, ctx));
	expect(first).not.toMatch(new RegExp(needle));
	expect(first).toMatch(/char_offset=2001/);
	expect(first).toMatch(/is 160027 characters/);

	const at = content.indexOf(needle);
	const second = textOf(await readTool.execute({ path: file, char_offset: at + 1 } as never, ctx));
	expect(second).toMatch(new RegExp(needle));
	expect(second.length < 8_000, `window was ${second.length} characters`).toBe(true);
});

it("一行的模型目录中间的名字，经 char_offset 读得到", async () => {
	const entries = Array.from({ length: 12_000 }, (_, index) => `{"id":"model-${index}","name":"Model ${index}","limit":{"context":200000,"output":32000}}`);
	entries.splice(6_000, 0, `{"id":"qwen3-livetranslate-flash-realtime","name":"${NAME}"}`);
	const content = `{"schema":1,"providers":[{"id":"p","models":[${entries.join(",")}]}]}`;
	const { file, ctx } = await workspace(content, "model-catalog.json");
	const head = textOf(await readTool.execute({ path: file } as never, ctx));
	expect(head).not.toMatch(new RegExp(NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	expect(head).toMatch(/char_offset=/);

	const at = content.indexOf(NAME);
	expect(at > 2000, `name was at ${at}`).toBe(true);
	const window = textOf(await readTool.execute({ path: file, char_offset: Math.max(1, at - 80) } as never, ctx));
	expect(window.includes(NAME), "指定的窗口里要有这个名字").toBe(true);
	expect(window.includes("qwen3-livetranslate-flash-realtime")).toBe(true);
	expect(window.length < 8_000).toBe(true);
});

it("char_offset 的读是模型自己要的窗口，整行都能编辑", async () => {
	const needle = "SWAP-ME";
	const content = `HEAD-UNIQUE${"a".repeat(80_000)}${needle}${"b".repeat(80_000)}`;
	const { file, ctx } = await workspace(content, "blob.txt");
	const at = content.indexOf(needle);
	await readTool.execute({ path: file, char_offset: at + 1 } as never, ctx);
	const head = await editTool.execute({ path: file, old_string: "HEAD-UNIQUE", new_string: "xxx" }, ctx);
	expect(head.isError, textOf(head)).toBeUndefined();

	const seen = await editTool.execute({ path: file, old_string: needle, new_string: "SWAPPED" }, ctx);
	expect(seen.isError, textOf(seen)).toBeUndefined();
});
