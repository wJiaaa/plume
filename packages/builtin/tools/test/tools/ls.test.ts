/**
 * ls 先按目录在前、名字排好截到 400 条，大小只给显示出来的文件取：截断前后的顺序、计数和大小都不能变。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { lsTool } from "../../src/tools/ls.ts";

const dir = await mkdtemp(join(tmpdir(), "plume-ls-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

it("目录在前、按名字排，截到 400 条，显示的文件带大小，其余只报个数", async () => {
	await mkdir(join(dir, "zz-dir"));
	await writeFile(join(dir, ".hidden"), "x");
	for (let index = 0; index < 401; index++) await writeFile(join(dir, `f${String(index).padStart(3, "0")}.txt`), "a".repeat(index));

	const result = await lsTool.execute({ path: dir }, { cwd: dir, state: new Map() });
	const lines = result.content
		.map((part) => part.text)
		.join("")
		.split("\n");
	expect(lines[0]).toBe("zz-dir/");
	expect(lines[1]).toBe("f000.txt  (0 B)");
	expect(lines[399]).toBe("f398.txt  (398 B)");
	expect(lines.at(-1)).toBe("[2 more entries]");
	expect(result.details).toMatchObject({ truncated: true });
	expect((result.details as { entries: unknown[] }).entries).toHaveLength(400);
	expect(lines.join("\n")).not.toMatch(/\.hidden/);
});
