/**
 * read 自己按字数截断大的输出；被截短的读不算读完，改之前要按窗口再读一次。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { readTool } from "../../src/tools/read.ts";
import { editTool } from "../../src/tools/edit.ts";
import { writeTool } from "../../src/tools/write.ts";
import type { ToolContext } from "../../src/tools/types.ts";

it("大的读由工具自己截断，编辑前要等一次窗口读", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-read-budget-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "data.txt");
	await writeFile(file, Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"x".repeat(100)}`).join("\n"), "utf8");
	const ctx: ToolContext = { cwd: dir, state: new Map() };
	const result = await readTool.execute({ path: file } as never, ctx);
	const text = result.content[0]?.text ?? "";
	const shown = Number(/showing lines 1-(\d+) of 2000 \(output capped/.exec(text)?.[1]);
	expect(shown > 100 && shown < 2000, `续读提示要说出输出停在哪里：${shown}`).toBe(true);
	expect(text).toMatch(new RegExp(`offset=${shown + 1}`));

	// 模型没要求窗口却只拿到一截，改之前得按窗口再读一次。
	const blocked = await editTool.execute({ path: file, old_string: "line 2000 ", new_string: "last " }, ctx);
	expect(blocked.isError).toBe(true);
	expect((await writeTool.execute({ path: file, content: "gone\n" }, ctx)).isError, "write 同样不认被截短的读").toBe(true);
	await readTool.execute({ path: file, offset: shown + 1 } as never, ctx);
	const edited = await editTool.execute({ path: file, old_string: "line 2000 ", new_string: "last " }, ctx);
	expect(edited.isError).toBeUndefined();
});
