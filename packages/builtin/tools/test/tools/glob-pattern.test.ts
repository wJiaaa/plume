/**
 * glob 的字符类 `[...]`：成员、范围、取反，以及几种边界写法；`./` 开头和带绝对路径的模式。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { globToRegExp, globTool, locatePattern } from "../../src/tools/glob.ts";
import { withFiles } from "../files.ts";

it("字符类匹配其中一个成员、一个范围，或除它们以外的任意字符", () => {
	const cases: [pattern: string, path: string, matches: boolean][] = [
		["*[Pp]review*", "PreviewCard.tsx", true],
		["*[Pp]review*", "ReviewCard.tsx", false],
		["f[0-9].ts", "f7.ts", true],
		["f[0-9].ts", "fa.ts", false],
		["f[!0-9].ts", "fa.ts", true],
		["f[!0-9].ts", "f7.ts", false],
		["f[^0-9].ts", "fa.ts", true],
		// 取反也不跨目录，和 `?` 一样。
		["a[!x]b", "a/b", false],
		// 紧跟 `[` 或 `[!` 的 `]` 是成员，不是收尾。
		["[]x].md", "].md", true],
		["[!]x].md", "].md", false],
		// 没有收尾的 `[` 只是一个字符。
		["a[b.ts", "a[b.ts", true],
		["{a,b}[12].ts", "b2.ts", true],
		// 花括号里的每一项也是 glob。
		["**/{*.test.ts,*.spec.ts}", "a/b.test.ts", true],
		["**/{*.test.ts,*.spec.ts}", "a/b.ts", false],
		["{src,lib}/v1.2/*.ts", "lib/v1.2/x.ts", true],
		["{src,lib}/v1.2/*.ts", "lib/v1x2/x.ts", false],
	];
	for (const [pattern, path, matches] of cases) {
		expect(globToRegExp(pattern).test(path), `${pattern} against ${path}`).toBe(matches);
	}
});

it("glob 经字符类找到文件", async () => {
	// 以前 `[` 被转义成字面字符，这条答了「No files match」，PreviewCard.tsx 明明就在。
	const dir = await mkdtemp(join(tmpdir(), "plume-glob-class-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "src", "files"), { recursive: true });
	await writeFile(join(dir, "src", "files", "PreviewCard.tsx"), "");
	await writeFile(join(dir, "src", "files", "Other.tsx"), "");

	const res = await globTool.execute({ pattern: "src/**/*[Pp]review*" }, withFiles({ cwd: dir, state: new Map() }));
	const text = res.content.map((part) => part.text).join("");
	expect(text).toBe("src/files/PreviewCard.tsx");
});

it("不存在的目录说不存在，不是搜了但为空", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-glob-missing-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const res = await globTool.execute({ pattern: "**/*.ts", path: "nope" }, withFiles({ cwd: dir, state: new Map() }));
	expect(res.isError).toBe(true);
	expect(res.content.map((part) => part.text).join("")).toMatch(/^Path not found: nope\./);
});

it("`./` 开头和绝对路径的模式找得到：以前按相对搜索目录的路径比，一个都匹配不上", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-glob-located-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "src", "deep"), { recursive: true });
	await writeFile(join(dir, "src", "a.ts"), "");
	await writeFile(join(dir, "src", "deep", "b.ts"), "");
	const ctx = withFiles({ cwd: dir, state: new Map() });
	const text = async (pattern: string) => (await globTool.execute({ pattern }, ctx)).content.map((part) => part.text).join("");
	expect(await text("./src/*.ts")).toBe("src/a.ts");
	expect(await text(`${dir}/src/**/*.ts`)).toMatch(/src\/deep\/b\.ts/);
	expect(await text(`${dir}/src/a.ts`)).toBe("src/a.ts");

	expect(locatePattern("./././x/*.md")).toEqual({ pattern: "x/*.md" });
	expect(locatePattern("/repo/src/**/*.ts")).toEqual({ dir: "/repo/src", pattern: "**/*.ts" });
	expect(locatePattern("/*.ts")).toEqual({ dir: "/", pattern: "*.ts" });
});
