/**
 * 把文件拖进终端，打出来的是 shell 认得的路径。引号是这件事的全部风险：带空格的路径没加引号，命令拿到两个参数；
 * 带 `$` 的文件名进了双引号，shell 会把它当变量展开掉。
 */

import { expect, it, vi } from "vitest";

vi.mock("@plume/ui", () => ({}));

const { dropText, shellWord } = await import("../src/drop.ts");

it("普通路径原样，别的加上里面什么都不解释的单引号", () => {
	expect(shellWord("/Users/me/src/app.ts", "posix")).toBe("/Users/me/src/app.ts");
	expect(shellWord("/Users/me/My Files/a.txt", "posix")).toBe("'/Users/me/My Files/a.txt'");
	expect(shellWord("/tmp/$HOME`x`", "posix")).toBe("'/tmp/$HOME`x`'");
	expect(shellWord("/tmp/it's", "posix")).toBe("'/tmp/it'\\''s'");
	expect(shellWord("/Users/me/中文.txt", "posix")).toBe("'/Users/me/中文.txt'");
});

it("PowerShell 用单引号，里面的 `$`、反引号不展开；cmd 用双引号", () => {
	expect(shellWord("C:\\Users\\me\\a.txt", "powershell")).toBe("C:\\Users\\me\\a.txt");
	expect(shellWord("C:\\Program Files\\Git", "powershell")).toBe("'C:\\Program Files\\Git'");
	expect(shellWord("C:\\$Recycle.Bin", "powershell")).toBe("'C:\\$Recycle.Bin'");
	expect(shellWord("C:\\it's `x`", "powershell")).toBe("'C:\\it''s `x`'");
	expect(shellWord("C:\\Program Files\\Git", "cmd")).toBe('"C:\\Program Files\\Git"');
	// Git Bash 按 POSIX：单引号里反斜杠原样。
	expect(shellWord("C:\\a b", "posix")).toBe("'C:\\a b'");
});

it("几条路径用空格隔开，末尾留一个空格好接着打", () => {
	expect(dropText(["/a", "/b c"], "posix")).toBe("/a '/b c' ");
	expect(dropText([], "posix")).toBe("");
});
