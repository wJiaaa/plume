/**
 * ls 先按目录在前、名字排好截到 400 条，大小只给显示出来的文件取：截断前后的顺序、计数和大小都不能变。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { lsTool } from "../../src/tools/ls.ts";
import { withFiles } from "../files.ts";

const dir = await mkdtemp(join(tmpdir(), "plume-ls-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

it("目录在前、按名字排，截到 400 条，显示的文件带大小，其余只报个数", async () => {
	await mkdir(join(dir, "zz-dir"));
	await writeFile(join(dir, ".hidden"), "x");
	for (let index = 0; index < 401; index++) await writeFile(join(dir, `f${String(index).padStart(3, "0")}.txt`), "a".repeat(index));

	const result = await lsTool.execute({ path: dir }, withFiles({ cwd: dir, state: new Map() }));
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

it("指向目录的软链列成目录，指向文件的和坏掉的照文件列", async () => {
	// pnpm 的 `node_modules/<包>` 全是软链：以前照文件列，模型去 read 它，拿回「是目录」再改 ls。
	const root = await mkdtemp(join(tmpdir(), "plume-ls-links-"));
	try {
		await mkdir(join(root, "real"));
		await writeFile(join(root, "real", "a.txt"), "abc");
		await symlink(join(root, "real"), join(root, "linked"));
		await symlink(join(root, "real", "a.txt"), join(root, "file-link"));
		await symlink(join(root, "gone"), join(root, "broken"));
		const text = (await lsTool.execute({ path: root }, withFiles({ cwd: root, state: new Map() }))).content.map((part) => part.text).join("");
		expect(text.split("\n")).toEqual(["linked/", "real/", "broken  (0 B)", "file-link  (3 B)"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
