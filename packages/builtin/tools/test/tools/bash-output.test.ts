import { expect, test } from "vitest";
import { clipOutput, OutputBuffer } from "../../src/tools/bash-output.ts";

const MAX = 60_000;

/** 一个像真实构建那样滚动输出的命令：大量普通行，中间零星几条错误。 */
function build(lines: number): string[] {
	const out: string[] = [];
	for (let i = 1; i <= lines; i++) out.push(i % 2500 === 0 ? `Error: failure number ${i / 2500}` : `compiling module ${i} ok`);
	return out;
}

function omittedOf(text: string): { chars: number; from: number; to: number }[] {
	return [...text.matchAll(/\[(\d+) characters omitted, lines? (\d+)(?:-(\d+))?/g)].map((m) => ({
		chars: Number(m[1]),
		from: Number(m[2]),
		to: Number(m[3] ?? m[2]),
	}));
}

test("分段到来的输出只截一次：一个省略标记，每条错误最多出现一次", () => {
	const lines = build(20_000);
	const raw = `${lines.join("\n")}\n`;
	const buffer = new OutputBuffer();
	// 每段 64 字符，模拟一行一行吐出来——以前每段都对上一次的结果再截一次。
	for (let at = 0; at < raw.length; at += 64) {
		buffer.append(raw.slice(at, at + 64));
		if (at % 6400 === 0) buffer.render(MAX);
	}
	const text = buffer.render(MAX);
	expect(text.length <= MAX, `${text.length}`).toBeTruthy();
	const markers = omittedOf(text);
	expect(markers.length, "只截一次，只有一个省略标记").toBe(1);
	for (let n = 1; n <= 8; n++) {
		const count = text.split(`failure number ${n}\n`).length - 1 + (text.endsWith(`failure number ${n}`) ? 1 : 0);
		expect(count <= 1, `错误 ${n} 出现了 ${count} 次`).toBeTruthy();
	}
	expect(text).toMatch(/failure number 1\b/);
	expect(text, "后面的错误不能被第一条挤掉").toMatch(/failure number 5\b/);
	// 省略的字符数是真实数目：显示出来的原文行 + 省略数 = 原始总长。
	const { chars, from, to } = markers[0]!;
	const shownLines = text.split("\n").filter((line) => /^compiling module \d+ ok$|^Error: failure number \d+$/.test(line));
	expect(chars > 400_000, `省略了 ${chars}`).toBeTruthy();
	expect(lines[from - 1] !== undefined && lines[to - 1] !== undefined).toBe(true);
	const head = lines.slice(0, from - 1);
	const tail = lines.slice(to);
	// 头部每行带着它后面的换行；尾部是「\n」+ 这些行 + 末尾那个换行。
	const shown = head.join("\n").length + 1 + tail.join("\n").length + 2;
	expect(chars, "省略数与原文对得上").toBe(raw.length - shown);
	expect(shownLines.length > 0).toBeTruthy();
});

test("没超过内存上限时，分段截和一次截结果一样", () => {
	const raw = build(3_000).join("\n");
	const buffer = new OutputBuffer();
	for (let at = 0; at < raw.length; at += 100) buffer.append(raw.slice(at, at + 100));
	expect(buffer.render(MAX)).toBe(clipOutput(raw, MAX));
	const small = new OutputBuffer();
	small.append("a\n");
	small.append("b");
	expect(small.render(MAX), "放得下就原样").toBe("a\nb");
	expect(small.clipped(MAX)).toBe(false);
});

test("省略范围是完整日志里的真实行号，从上次读到的地方接着数", () => {
	const buffer = new OutputBuffer({ line: 101, column: 0 });
	const lines = Array.from({ length: 5_000 }, (_, i) => `row ${i + 101}`);
	buffer.append(lines.join("\n"));
	const marker = omittedOf(buffer.render(2_000))[0]!;
	const text = buffer.render(2_000);
	// 省略范围前一行和后一行都显示着。
	expect(text).toMatch(new RegExp(`row ${marker.from - 1}\\n`));
	expect(text).toMatch(new RegExp(`\\nrow ${marker.to + 1}\\n`));
	expect(!text.includes(`row ${marker.from}\n`)).toBeTruthy();
	expect(buffer.end.line).toBe(101 + 4_999);
});

test("超长的一行留头留尾，标出行号和 char_offset", () => {
	const buffer = new OutputBuffer();
	buffer.append("x".repeat(500_000));
	buffer.append("TAIL");
	const text = buffer.render(MAX);
	expect(text.length < 10_000, `${text.length}`).toBeTruthy();
	expect(text).toMatch(/line 1 char_offset=\d+/);
	expect(text).toMatch(/TAIL$/);
	expect(buffer.clipped(MAX)).toBeTruthy();
});
