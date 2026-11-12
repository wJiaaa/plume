/**
 * grep 收到一个不是正则的模式时怎么办。
 *
 * 模型常拿一段代码片段来搜（`onEvent(event`、`*.ts`），正则引擎直接拒绝。报错是最差的回答：文本就在文件里，
 * 一个工具错误只教会它再猜一次。所以编不过的模式按字面搜，并且在结果里说出来：元字符被悄悄解除的搜索，
 * 不说的话读起来就像照原样跑过。
 *
 * 两条路都要覆盖：装了 ripgrep 时的 `--fixed-strings` 重试，没装时内置扫描器的转义。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { grepTool } from "../../src/tools/grep.ts";
import type { ToolResult } from "../../src/tools/types.ts";
import { withFiles } from "../files.ts";

const SOURCE = ["const handler = onEvent(event) => run(event);", 'const pattern = "*.ts";', "function runAll() { return handler; }"].join("\n");

async function workspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-grep-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "sample.ts"), SOURCE);
	return dir;
}

/** 清空 PATH，`spawn("rg")` 找不到：就是没装 ripgrep 的机器上工具看到的样子。 */
function withoutRipgrep(): void {
	const path = process.env.PATH;
	process.env.PATH = "";
	onTestFinished(() => {
		process.env.PATH = path;
	});
}

const ctx = (cwd: string) => withFiles({ cwd, state: new Map<string, unknown>() });
const textOf = (res: ToolResult) => res.content.map((part) => part.text).join("");

for (const fallback of [false, true]) {
	it(`很长的命中行输出有上限，details 也是 (fallback=${fallback})`, async () => {
		const dir = await workspace();
		await writeFile(join(dir, "huge.json"), Array.from({ length: 20 }, () => `needle ${"😀".repeat(20_000)}`).join("\n"));
		if (fallback) withoutRipgrep();
		const res = await grepTool.execute({ pattern: "needle" }, ctx(dir));
		const text = textOf(res);
		expect(text.length < 16_000, `output was ${text.length} characters`).toBe(true);
		expect(text).toMatch(/huge.json:1:needle/);
		expect(text).toMatch(/omitted|truncated/);
		expect(text, "总输出截断后，原来省略的字数还在").toMatch(/\[38008 characters omitted;/);
		// 孤立的代理项经 UTF-8 往返会变成 U+FFFD，往返不变就是没切断字符（`isWellFormed` 在 ES2024 才有）。
		expect(Buffer.from(text, "utf8").toString("utf8"), "不切断 Unicode 字符").toBe(text);
		expect(JSON.stringify(res.details).length < 20_000, "details 不能把原输出夹带回来").toBe(true);
	});
}

it("没闭合的括号按文本搜，不报错", async () => {
	const dir = await workspace();
	const res = await grepTool.execute({ pattern: "onEvent(event" }, ctx(dir));
	expect(res.isError, "编不过的模式不是错误").toBeUndefined();
	expect(textOf(res), "它说的那一行找得到").toMatch(/onEvent\(event\) => run/);
	expect((res.details as { literal?: boolean }).literal).toBe(true);
});

it("光秃秃的量词（模型误打的 glob）找得到它自己的文本", async () => {
	const dir = await workspace();
	const res = await grepTool.execute({ pattern: "*.ts" }, ctx(dir));
	expect(res.isError).toBeUndefined();
	expect(textOf(res)).toMatch(/const pattern/);
	expect((res.details as { literal?: boolean }).literal).toBe(true);
});

it("退回字面搜索要说出来，免得被当成干净的没搜到", async () => {
	const dir = await workspace();
	const res = await grepTool.execute({ pattern: "nowhere(at all" }, ctx(dir));
	expect((res.details as { count: number }).count).toBe(0);
	expect(textOf(res)).toMatch(/not a valid regular expression/);
	expect(textOf(res)).toMatch(/searched for literally/);
});

it("编得过的模式仍是正则", async () => {
	const dir = await workspace();
	const res = await grepTool.execute({ pattern: "function\\s+run\\w+" }, ctx(dir));
	expect(textOf(res)).toMatch(/function runAll/);
	expect(!(res.details as { literal?: boolean }).literal, "没有解除什么，就什么都不说").toBe(true);
});

it("没装 ripgrep、由内置扫描器回答时也一样", async () => {
	const dir = await workspace();
	withoutRipgrep();
	const res = await grepTool.execute({ pattern: "onEvent(event" }, ctx(dir));
	expect(res.isError).toBeUndefined();
	expect(textOf(res)).toMatch(/onEvent\(event\) => run/);
	expect((res.details as { literal?: boolean }).literal).toBe(true);
});

it("命中在一行的前 2000 个字之后，结果里照样有", async () => {
	const dir = await workspace();
	const needle = "MID-LINE-NEEDLE-7K2M";
	await writeFile(join(dir, "catalog.json"), `${"a".repeat(80_000)}"id":"${needle}","name":"Keep this"${"b".repeat(80_000)}`);
	const res = await grepTool.execute({ pattern: needle }, ctx(dir));
	const text = textOf(res);
	expect(text.length < 16_000, `output was ${text.length} characters`).toBe(true);
	expect(text).toMatch(/catalog\.json:1:/);
	expect(text).toMatch(new RegExp(needle));
	expect(text).toMatch(/omitted/);
	expect(text).toMatch(/char_offset=/);
});

it("什么都没匹配到的正则，报的是它本身", async () => {
	const dir = await workspace();
	const res = await grepTool.execute({ pattern: "class\\s+Missing" }, ctx(dir));
	expect((res.details as { count: number }).count).toBe(0);
	expect(textOf(res)).toMatch(/No matches for \/class\\s\+Missing\/\./);
	expect(textOf(res)).not.toMatch(/literally/);
});

for (const fallback of [false, true]) {
	it(`撞到命中上限时说可能还有更多 (fallback=${fallback})`, async () => {
		// 内置扫描满 200 条就停，以前结果里一个字都没提，看上去就是全部。
		const dir = await workspace();
		await writeFile(join(dir, "many.txt"), Array.from({ length: 450 }, (_, i) => `hit ${i}`).join("\n"));
		if (fallback) withoutRipgrep();
		const res = await grepTool.execute({ pattern: "hit" }, ctx(dir));
		expect(textOf(res)).toMatch(/hit the 200-match limit; more matches may exist/);
		const few = await grepTool.execute({ pattern: "hit 44\\d" }, ctx(dir));
		expect(textOf(few)).not.toMatch(/truncated/);
	});
}

for (const fallback of [false, true]) {
	it(`不存在的路径说不存在，不是搜了但为空 (fallback=${fallback})`, async () => {
		// 模型把 ToolCard.tsx 猜成 ToolCall.tsx，拿回的是「No matches」，就以为文件里没有。
		const dir = await workspace();
		if (fallback) withoutRipgrep();
		const res = await grepTool.execute({ pattern: "onEvent", path: "Sample.tsx" }, ctx(dir));
		expect(res.isError).toBe(true);
		expect(textOf(res)).toMatch(/^Path not found: Sample\.tsx\./);
		expect(textOf(res)).not.toMatch(/No matches/);
	});
}
