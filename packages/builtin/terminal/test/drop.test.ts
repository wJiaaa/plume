/**
 * 把文件拖进终端，打出来的是 shell 认得的路径。引号是这件事的全部风险：带空格的路径没加引号，命令拿到两个参数；
 * 带 `$` 的文件名进了双引号，shell 会把它当变量展开掉。
 */

import { expect, it, vi } from "vitest";

vi.mock("@plume/ui", () => ({}));

const { dropText, shellWord } = await import("../src/drop.ts");

it("普通路径原样，别的加上里面什么都不解释的单引号", () => {
	expect(shellWord("/Users/me/src/app.ts", "MacIntel")).toBe("/Users/me/src/app.ts");
	expect(shellWord("/Users/me/My Files/a.txt", "MacIntel")).toBe("'/Users/me/My Files/a.txt'");
	expect(shellWord("/tmp/$HOME`x`", "Linux x86_64")).toBe("'/tmp/$HOME`x`'");
	expect(shellWord("/tmp/it's", "MacIntel")).toBe("'/tmp/it'\\''s'");
	expect(shellWord("/Users/me/中文.txt", "MacIntel")).toBe("'/Users/me/中文.txt'");
});

it("Windows 上带空格的路径加双引号，cmd 和 PowerShell 都读成一个词", () => {
	expect(shellWord("C:\\Users\\me\\a.txt", "Win32")).toBe("C:\\Users\\me\\a.txt");
	expect(shellWord("C:\\Program Files\\Git", "Win32")).toBe('"C:\\Program Files\\Git"');
});

it("几条路径用空格隔开，末尾留一个空格好接着打", () => {
	expect(dropText(["/a", "/b c"], "MacIntel")).toBe("/a '/b c' ");
	expect(dropText([], "MacIntel")).toBe("");
});
