/**
 * 终端里哪些字是能点开的文件路径。认多了，一句话里的 `index.ts` 也成了链接；认少了，编译器报的 `src/a.ts:12:3` 点不开。
 */

import type { ILink, Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";

vi.mock("@plume/ui", () => ({ macKeyboard: (platform: string) => /^Mac/i.test(platform) }));

const { fileLinks, opensLink, pathsIn } = await import("../src/links.ts");

const paths = (text: string) => pathsIn(text).map(({ path, line }) => (line ? `${path}@${line}` : path));

it("编译器、测试、调用栈印的路径都认得，连同行号", () => {
	expect(paths("src/app.ts:42:7 - error TS2322")).toEqual(["src/app.ts@42"]);
	expect(paths("  at run (/Users/me/p/lib/run.js:10:5)")).toEqual(["/Users/me/p/lib/run.js@10"]);
	expect(paths("./scripts/build.mjs")).toEqual(["./scripts/build.mjs"]);
	expect(paths("../shared/a.ts")).toEqual(["../shared/a.ts"]);
	expect(paths("C:\\proj\\src\\Program.cs(12,3): error")).toEqual(["C:\\proj\\src\\Program.cs@12"]);
	expect(paths("main.go:9: undefined: x")).toEqual(["main.go@9"]);
	expect(paths("M  src/a.ts\n?? docs/b.md")).toEqual(["src/a.ts", "docs/b.md"]);
});

it("句子里的名字、文件夹、网址不算文件链接", () => {
	expect(paths("edit index.ts and run it")).toEqual([]);
	expect(paths("cd src/components")).toEqual([]);
	expect(paths("open https://example.com/a/b.html now")).toEqual([]);
	expect(paths("v1.2.3")).toEqual([]);
});

it("下划线从路径开头画起", () => {
	const [match] = pathsIn("error: src/a.ts:3");
	expect(match?.start).toBe(7);
	expect(match?.text).toBe("src/a.ts:3");
});

it("Mac 上 ⌘ 点、别处 Ctrl 点才打开；单点是选字", () => {
	const click = (init: Partial<MouseEvent>) => ({ metaKey: false, ctrlKey: false, ...init }) as MouseEvent;
	expect(opensLink(click({ metaKey: true }), "MacIntel")).toBe(true);
	expect(opensLink(click({ ctrlKey: true }), "MacIntel")).toBe(false);
	expect(opensLink(click({ ctrlKey: true }), "Win32")).toBe(true);
	expect(opensLink(click({}), "Win32")).toBe(false);
});

/** 一行字的终端：链接提供者只读 `buffer.active.getLine`。 */
function oneLine(text: string, wide = new Set<number>()): Terminal {
	const cells = [...text].flatMap((char, i) =>
		wide.has(i)
			? [
					{ w: 2, c: char },
					{ w: 0, c: "" },
				]
			: [{ w: 1, c: char }],
	);
	const cell = (x: number) => ({ getWidth: () => cells[x]?.w ?? 1, getChars: () => cells[x]?.c ?? "" });
	return { buffer: { active: { getLine: () => ({ length: cells.length, getCell: cell }) } } } as unknown as Terminal;
}

it("只有宿主认得的路径画成链接，⌘ 点在文件面板里打开它找到的那个文件", async () => {
	const opened: string[] = [];
	const asked: string[] = [];
	const provider = fileLinks(oneLine("src/a.ts:3:1 error  scripts/x.mjs  util.ts:9"), {
		find: async (path) => {
			asked.push(path);
			return path === "src/a.ts" ? "/repo/packages/desktop/src/a.ts" : null;
		},
		openUrl: () => {},
		openFile: (path) => opened.push(path),
	});
	const links = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
	expect(asked).toEqual(["src/a.ts", "scripts/x.mjs", "util.ts"]);
	expect(links?.map((link) => link.text)).toEqual(["src/a.ts:3:1"]);
	links?.[0]?.activate({ metaKey: true, ctrlKey: true } as MouseEvent, "src/a.ts:3:1");
	expect(opened).toEqual(["/repo/packages/desktop/src/a.ts"]);
});

it("汉字占两格，后面路径的下划线不往左偏", async () => {
	const provider = fileLinks(oneLine("错误 a/b.ts", new Set([0, 1])), { find: async (path) => `/r/${path}`, openUrl: () => {}, openFile: () => {} });
	const links = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
	expect(links?.[0]?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 11, y: 1 } });
});
