/**
 * 编辑预览和审批卡背后的行级 diff。
 *
 * 不设上限时，算的量随（改动的旧行数）×（改动的新行数）增长：一个 6000 行、每行都不同的文件（比如 CRLF 检出
 * 对着 LF 的版本）要花将近一秒、几百 MB 才报出「每行都改了」。超过上限就把中间整块替换：仍然是正确的 diff，
 * 只是不是最小的。
 */

import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { computeDiff } from "../src/diff.ts";

const lines = (n: number, line: (i: number) => string) => `${Array.from({ length: n }, (_, i) => line(i)).join("\n")}\n`;

test("上限以内仍是最小改动：两边共有的行对齐成上下文", () => {
	const before = `${lines(100, (i) => `old ${i}`)}common\n`;
	const after = `common\n${lines(100, (i) => `new ${i}`)}`;
	const diff = computeDiff(before, after);
	expect([diff.removed, diff.added]).toEqual([100, 100]);
	expect(diff.hunks.some((hunk) => hunk.lines.some((line) => line.type === "context" && line.text === "common"))).toBe(true);
});

test("改动区超过上限：整块替换，不再为对齐一行去建几百万格的表", () => {
	// 中间 2002 × 2002 行，刚过上限：唯一共有的那一行不再对齐。
	const before = `${lines(2001, (i) => `old ${i}`)}common\n`;
	const after = `common\n${lines(2001, (i) => `new ${i}`)}`;
	const diff = computeDiff(before, after);
	expect([diff.removed, diff.added]).toEqual([2002, 2002]);
});

test("6000 行每行都不同：很快给出答案", () => {
	const before = lines(6000, (i) => `line ${i}`);
	const after = lines(6000, (i) => `line ${i}\r`);
	const started = performance.now();
	const diff = computeDiff(before, after);
	const elapsed = performance.now() - started;
	expect([diff.removed, diff.added]).toEqual([6000, 6000]);
	// 不设上限时要九百多毫秒，设了上限只要几毫秒。
	expect(elapsed, `用了 ${elapsed.toFixed(0)}ms`).toBeLessThan(400);
});

test("整块替换时，前后公共部分的行号照旧连续", () => {
	const before = `head\n${lines(2001, (i) => `old ${i}`)}tail\n`;
	const after = `head\n${lines(2001, (i) => `new ${i}`)}tail\n`;
	const { hunks } = computeDiff(before, after, 1);
	const first = hunks[0]?.lines ?? [];
	const last = hunks[hunks.length - 1]?.lines ?? [];
	expect(first[0]).toEqual({ type: "context", text: "head", oldLine: 1, newLine: 1 });
	expect(last[last.length - 1]).toEqual({ type: "context", text: "tail", oldLine: 2003, newLine: 2003 });
});

test("插入、删除、重复行混在一起时，diff 能还原两边的文件，行号准确", () => {
	const samples = ["", "a", "b", "a\nb", "b\na", "a\na\nb", "b\na\na", "a\nb\nc\na"];
	for (const before of samples)
		for (const after of samples) {
			const diff = computeDiff(before, after, 100);
			if (before === after) {
				expect(diff).toEqual({ added: 0, removed: 0, hunks: [] });
				continue;
			}
			const lines = diff.hunks.flatMap((hunk) => hunk.lines);
			const old = lines.filter((line) => line.type !== "add"),
				next = lines.filter((line) => line.type !== "remove");
			expect(old.map((line) => line.text).join("\n")).toBe(before);
			expect(next.map((line) => line.text).join("\n")).toBe(after);
			expect(old.map((line) => line.oldLine)).toEqual(old.map((_, i) => i + 1));
			expect(next.map((line) => line.newLine)).toEqual(next.map((_, i) => i + 1));
			expect(diff.added).toBe(next.length - lines.filter((line) => line.type === "context").length);
			expect(diff.removed).toBe(old.length - lines.filter((line) => line.type === "context").length);
		}
});

test("小 diff 用最少的编辑次数，重复行也一样", () => {
	const samples = Array.from({ length: 63 }, (_, n) =>
		(n + 1)
			.toString(2)
			.slice(1)
			.split("")
			.map((bit) => (bit === "0" ? "a" : "b")),
	);
	for (const a of samples)
		for (const b of samples) {
			// 用最长公共子序列算出最少编辑次数，和 computeDiff 的结果对照。
			const lengths = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
			for (let i = 1; i <= a.length; i++)
				for (let j = 1; j <= b.length; j++) {
					lengths[i]![j] = a[i - 1] === b[j - 1] ? lengths[i - 1]![j - 1]! + 1 : Math.max(lengths[i - 1]![j]!, lengths[i]![j - 1]!);
				}
			const result = computeDiff(a.join("\n"), b.join("\n"));
			expect(result.added + result.removed).toBe(a.length + b.length - 2 * lengths[a.length]![b.length]!);
		}
});

test("大文件里相隔很远的两处改动在有限的堆里算得出来，仍是两处改动", () => {
	const module = new URL("../src/diff.ts", import.meta.url).href;
	const output = execFileSync(
		process.execPath,
		[
			"--max-old-space-size=128",
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			`
		import { computeDiff } from ${JSON.stringify(module)};
		const lines = Array.from({length: 20000}, (_, i) => "line " + i);
		const before = lines.join("\\n"); lines[0] = "first"; lines[19999] = "last";
		const result = computeDiff(before, lines.join("\\n"));
		process.stdout.write(JSON.stringify({added:result.added, removed:result.removed, hunks:result.hunks.length}));
	`,
		],
		{ timeout: 10000, encoding: "utf8", maxBuffer: 10000 },
	);
	expect(JSON.parse(output)).toEqual({ added: 2, removed: 2, hunks: 2 });
});

test("搜索预算用完时，大段重写仍给出完整的 diff", () => {
	const before = Array.from({ length: 1200 }, (_, i) => `old ${i}`),
		after = before.map((_, i) => `new ${i}`);
	const result = computeDiff(before.join("\n"), after.join("\n"));
	expect(result.removed).toBe(before.length);
	expect(result.added).toBe(after.length);
	const lines = result.hunks.flatMap((h) => h.lines);
	expect(lines.filter((l) => l.type !== "add").map((l) => l.text)).toEqual(before);
	expect(lines.filter((l) => l.type !== "remove").map((l) => l.text)).toEqual(after);
});
