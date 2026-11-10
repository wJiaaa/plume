/**
 * 在真文件上看 read 的结构视图：长源文件读回来的是声明和注释，函数体折成一行。
 *
 *   node --experimental-transform-types test/tool-eval/demo.ts [文件]
 *
 * 跑的是随应用发的代码——plume.tools 的 read 用的同一个 `outline`，不是演示用的另一份。不调模型。
 */

import { readFile } from "node:fs/promises";
import { outline } from "../../packages/builtin/tools/src/tools/outline.ts";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const OFF = "\x1b[0m";

function heading(n: number, title: string): void {
	console.log(`\n${BOLD}${"─".repeat(74)}${OFF}`);
	console.log(`${BOLD} ${n}. ${title}${OFF}`);
	console.log(`${BOLD}${"─".repeat(74)}${OFF}\n`);
}

// ---------------------------------------------------------------------------
// 1 · read 交回的是形状，不是一堵字节墙
// ---------------------------------------------------------------------------

async function demoOutline(target: string): Promise<void> {
	heading(1, "read：长文件返回结构，不是一堵字节墙");

	const content = await readFile(target, "utf8");
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();

	const shape = outline(target, content, lines);
	if (!shape) {
		console.log(`${DIM}${target}（${lines.length} 行）不出结构视图：太短、不是认得的源码，或者折不掉多少。换一个长一点的源文件。${OFF}`);
		return;
	}
	console.log(`${DIM}文件${OFF} ${target}  ${DIM}${lines.length} 行${OFF}\n`);

	// 从第一处折叠前后开一扇窗，看得见折叠的样子。
	const rows = shape.text.split("\n");
	const firstFold = Math.max(
		0,
		rows.findIndex((row) => row.includes("⋯")),
	);
	for (const row of rows.slice(Math.max(0, firstFold - 4), firstFold + 9)) {
		console.log(row.includes("⋯") ? `  ${YELLOW}${row}${OFF}` : `  ${DIM}${row}${OFF}`);
	}

	console.log(
		`\n  ${DIM}原文${OFF}  ${lines.length} 行全部进上下文\n` +
			`  ${GREEN}结构视图${OFF}  ${shape.shownLines} 行 ${DIM}(声明与注释)${OFF} + ${shape.foldedLines} 行折叠  ` +
			`${GREEN}省 ${((shape.foldedLines / lines.length) * 100).toFixed(0)}%${OFF}`,
	);
}

async function main(): Promise<void> {
	const target = process.argv[2] ?? "packages/core/agent/src/host.ts";
	console.log(`\n${BOLD}Plume · read 的结构视图${OFF}`);
	await demoOutline(target);
	console.log(`\n${DIM}${"─".repeat(74)}${OFF}\n`);
}

await main();
