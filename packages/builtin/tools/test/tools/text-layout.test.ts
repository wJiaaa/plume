/**
 * `decodeText` / `encodeText`：read、edit、write 共用的这一对。
 *
 * 一切都靠往返：解码再编码、不动内容，字节原样还原。做不到的话，改一行就会重写文件的其余部分。
 */

import { expect, it } from "vitest";
import { decodeInput, decodeText, encodeText } from "../../src/tools/text-layout.ts";

const BOM = "\uFEFF";

it("解码再编码，字节原样还原", () => {
	const samples = [
		"",
		BOM,
		"one line, no break",
		"a\nb\n",
		"a\r\nb\r\n",
		`${BOM}a\r\nb`,
		"a\r\nb\nc\r\n",
		"progress 10%\rprogress 20%\r\ndone\r\n",
		"lone \r in an LF file\n",
		`${BOM}${BOM}double`,
	];
	for (const raw of samples) {
		const { text, layout } = decodeText(raw);
		expect(encodeText(text, layout), JSON.stringify(raw)).toBe(raw);
	}
});

it("整篇 CRLF 才规范化；混用的、带孤立 \\r 的原样不动", () => {
	expect(decodeText("a\r\nb\r\n")).toEqual({ text: "a\nb\n", layout: { bom: false, eol: "\r\n" } });
	expect(decodeText("a\nb")).toEqual({ text: "a\nb", layout: { bom: false, eol: "\n" } });
	expect(decodeText("a\r\nb\nc")).toEqual({ text: "a\r\nb\nc", layout: { bom: false, eol: null } });
	expect(decodeText("a\rb\r\nc")).toEqual({ text: "a\rb\r\nc", layout: { bom: false, eol: null } });
	expect(decodeText("a\rb\nc")).toEqual({ text: "a\rb\nc", layout: { bom: false, eol: "\n" } });
});

it("BOM 单独记下，不算第一行的字", () => {
	expect(decodeText(`${BOM}head\r\n`)).toEqual({ text: "head\n", layout: { bom: true, eol: "\r\n" } });
	// 只有第一个是 BOM，第二个是正文里的字。
	expect(decodeText(`${BOM}${BOM}x`).text).toBe(`${BOM}x`);
});

it("编码时残留的 CRLF 不会变成 \\r\\r\\n", () => {
	expect(encodeText("a\r\nb\nc", { bom: false, eol: "\r\n" })).toBe("a\r\nb\r\nc");
});

it("模型给的文本：跟随文件的形式，混用的文件原样比对", () => {
	expect(decodeInput("a\r\nb", { bom: false, eol: "\r\n" })).toBe("a\nb");
	expect(decodeInput("a\r\nb", { bom: false, eol: "\n" })).toBe("a\nb");
	expect(decodeInput("a\r\nb", { bom: false, eol: null })).toBe("a\r\nb");
	expect(decodeInput(`${BOM}x`, { bom: true, eol: "\n" }), "片段开头的 U+FEFF 是一个字符，不是 BOM").toBe(`${BOM}x`);
});
