/**
 * glob 结果的截断和分组：遍历整棵树再排序截断，按目录分组后每条路径都还原得回来。
 */

import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { byDirectory, globTool } from "../../src/tools/glob.ts";

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-glob-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

it("glob 遍历整棵树，所以「最新在前」和剩余个数是真的", async () => {
	// 以前找到 2000 个就停止遍历：最新的文件在后面的目录里就排不进来，「还有 N 个」也偏小。
	const dir = await scratch();
	const old = new Date("2020-01-01");
	for (const group of ["a", "b"]) {
		await mkdir(join(dir, group));
		for (let i = 0; i < 1500; i++) {
			const file = join(dir, group, `f${i}.ts`);
			await writeFile(file, "");
			await utimes(file, old, old);
		}
	}
	await writeFile(join(dir, "b", "newest.ts"), "");
	const res = await globTool.execute({ pattern: "**/*.ts", limit: 10 }, { cwd: dir, state: new Map() });
	const text = res.content.map((part) => part.text).join("");
	expect(text.split("\n")[0]).toBe("b/newest.ts");
	expect(text).toMatch(/\[2991 more matches not shown\]/);
	expect((res.details as { count: number }).count).toBe(3001);
});

it("同一目录下的文件在目录名下列一次，保持最新在前", () => {
	// 目录排在它最新那个文件的位置；只有一个命中的目录保留完整路径。
	expect(byDirectory(["a/x.ts", "b/y.ts", "a/z.ts", "README.md", "c/d/one.ts", "a/w.ts"])).toBe(
		["a/", "  x.ts", "  z.ts", "  w.ts", "b/y.ts", "README.md", "c/d/one.ts"].join("\n"),
	);
});

it("分组后的列表能还原出每一条路径", async () => {
	const dir = await scratch();
	const files = ["src/a.ts", "src/b.ts", "src/deep/c.ts", "src/deep/d.ts", "lone/e.ts", "top.ts"];
	for (const [index, file] of files.entries()) {
		await mkdir(join(dir, file, ".."), { recursive: true });
		await writeFile(join(dir, file), "");
		const when = new Date(2020, 0, 1 + index);
		await utimes(join(dir, file), when, when);
	}
	const res = await globTool.execute({ pattern: "**/*.ts" }, { cwd: dir, state: new Map() });
	const text = res.content.map((part) => part.text).join("");
	expect(text).toBe(["top.ts", "lone/e.ts", "src/deep/", "  d.ts", "  c.ts", "src/", "  b.ts", "  a.ts"].join("\n"));
	// 按工具描述教模型的方式读回来。
	let header = "";
	const rebuilt = text
		.split("\n")
		.map((line) => {
			if (line.endsWith("/")) {
				header = line;
				return null;
			}
			return line.startsWith("  ") ? header + line.slice(2) : line;
		})
		.filter((path) => path !== null);
	expect(rebuilt).toEqual((res.details as { files: string[] }).files);
});
