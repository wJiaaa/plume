/**
 * 流式输出写到一半时画什么——见 `stream-tail.ts`。
 *
 * 每一条都是「先错一下再跳对」的一种：半截的标记原样露出来，写完才变成它该是的样子。这里钉住的是
 * 补完之后 `inline.ts` / `blocks.ts` 认出来的东西，而不是补出来的字符串长什么样。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown, parseMarkdownChunks } from "../src/renderer/markdown/blocks.ts";
import { parseInline } from "../src/renderer/markdown/inline.ts";
import { completeTail, completeTailHeld } from "../src/renderer/markdown/stream-tail.ts";

const kinds = (text: string) => parseInline(completeTail(text)).map((token) => token.kind);

test("没收口的加粗先画成加粗，不露出星号", () => {
	assert.deepEqual(parseInline(completeTail("这是 **加粗")), [
		{ kind: "text", text: "这是 " },
		{ kind: "strong", children: [{ kind: "text", text: "加粗" }] },
	]);
	assert.equal(completeTail("这是 **加粗*"), "这是 **加粗**", "半个收口也补齐");
	assert.deepEqual(kinds("~~删除"), ["del"]);
});

test("只敲出开头标记、后面还没有字的，先不画", () => {
	assert.equal(completeTail("这是 **"), "这是 ");
	assert.equal(completeTail("看 `"), "看 ");
	assert.equal(completeTail("**a `"), "**a** ", "收口补在字后面，空格留在原处");
});

test("没收口的代码跨度写完之前不画，里面的星号不算强调", () => {
	// 补上收口的话，路径每进一个字就在代码和文件卡片之间切一次——实测就是一直在闪。
	assert.equal(completeTail("用 `a*b"), "用 ");
	assert.equal(completeTail("看 `src/features/a.ts:"), "看 ");
	assert.equal(completeTail("**看 `x"), "**看** ");
	assert.equal(completeTail("落单的 ` 后面是一整段很长的话".padEnd(200, "字")), "落单的 ` 后面是一整段很长的话".padEnd(200, "字"), "太长的不是代码，照原样");
});

test("方括号还没收口时先不画，免得它露出来再消失", () => {
	assert.equal(completeTail("看 [React 文"), "看 ");
	assert.equal(completeTail("看 [React 文档]"), "看 ");
	assert.equal(completeTail("见 [1] 的说法"), "见 [1] 的说法", "后面不跟地址的就是方括号");
});

test("地址还在写的链接整个先不画，写完一次出来", () => {
	assert.equal(completeTail("看 [文档](https://exa"), "看 ");
	assert.equal(completeTail("图 ![logo](assets/lo"), "图 ");
	assert.equal(completeTail("看 [文档](https://example.com) 和 **这"), "看 [文档](https://example.com) 和 **这**");
	// 文件链接先露出一段字、再换成只剩文件名的卡片，就是那一下闪。
	assert.equal(completeTail("承载（[router.tsx:242](/Users/x/apps/web/src/app/rou"), "承载（");
	// 绝对路径动辄上百字，也照样藏到写完。
	assert.equal(completeTail(`看 [listTestCases](/Users/${"deep/".repeat(40)}test-case.serv`), "看 ");
});

test("跨了行或超过地址上限的不是链接，退回只留它的字，后面的话不一直藏着", () => {
	assert.equal(completeTail("看 [文档](https://exa\n下一行"), "看 文档");
	assert.equal(completeTail(`看 [文档](https://example.com/${"a".repeat(2048)}`), "看 文档");
});

test("乘号、下划线名字、货币不被当成没收口的强调或公式", () => {
	assert.equal(completeTail("算 a*b 的值"), "算 a*b 的值");
	assert.equal(completeTail("调 snake_case 函数"), "调 snake_case 函数");
	assert.equal(completeTail("花了 $5 买"), "花了 $5 买");
	assert.equal(completeTail("2 * 3 = 6"), "2 * 3 = 6");
});

test("中文后面紧跟的单个星号是斜体的开头，和 inline.ts 一样", () => {
	assert.equal(completeTail("每帧都会*整条"), "每帧都会*整条*");
});

test("写完的段落不动，只看最后一段", () => {
	const text = "第一段 **没收口\n\n第二段 **加粗";
	assert.equal(completeTail(text), "第一段 **没收口\n\n第二段 **加粗**");
});

test("停在代码围栏或公式块里时什么都不做", () => {
	assert.equal(completeTail("```ts\nconst a = **b"), "```ts\nconst a = **b");
	assert.equal(completeTail("$$\nx^"), "$$\nx^");
	assert.equal(completeTail("```\ncode\n```\n**粗"), "```\ncode\n```\n**粗**");
});

test("围栏的开头行写完之前不画，收尾行写到一半不露出来", () => {
	assert.equal(completeTail("看：\n\n```t"), "看：\n\n", "语言名写到一半，标题会从 t 变成 ts");
	assert.deepEqual(parseMarkdown(completeTail("```ts\nx\n")), [{ kind: "code", lang: "ts", code: "x", open: true }], "刚进来的换行不先画成空行");
	assert.equal(completeTail("```ts\nx\n``"), "```ts\nx");
});

test("列表项之间不互相补：只补正在写的那一项", () => {
	assert.equal(completeTail("- **一\n- 二 **粗"), "- **一\n- 二 **粗**");
});

test("分隔行写完之前，表头先不画", () => {
	assert.deepEqual(
		parseMarkdown(completeTail("介绍一下：\n| A | B |")).map((b) => b.kind),
		["paragraph"],
	);
	assert.equal(completeTail("介绍一下：\n| A | B |\n| --"), "介绍一下：");
	assert.deepEqual(
		parseMarkdown(completeTail("| A | B |\n| --- | --- |\n| 1 | **2")).map((b) => b.kind),
		["table"],
	);
	assert.equal(completeTail("| A | B |\n| --- | --- |\n| 1 | **2"), "| A | B |\n| --- | --- |\n| 1 | **2**");
});

test("只写出块标记的最后一行先不画", () => {
	assert.deepEqual(parseMarkdown(completeTail("段落\n\n##")), [{ kind: "paragraph", text: "段落" }]);
	assert.deepEqual(
		parseMarkdown(completeTail("- 一\n-")).map((b) => b.kind),
		["list"],
	);
});

test("每个顶层块带着自己的原文，拼回去就是全文", () => {
	const source = "# 标题\n\n段落 **一**\n\n- a\n- b\n\n```ts\nx\n\ny\n```\n\n| A |\n| - |\n| 1 |";
	const chunks = parseMarkdownChunks(source);
	assert.deepEqual(
		chunks.map((chunk) => chunk.block),
		parseMarkdown(source),
	);
	assert.equal(chunks.map((chunk) => chunk.raw).join("\n"), source);
	assert.equal(chunks[3].raw, "```ts\nx\n\ny\n```\n");
});

test("往后写不改变前面块的原文——按原文记忆的块不会重画", () => {
	const before = parseMarkdownChunks("段落一\n\n段落二");
	const after = parseMarkdownChunks("段落一\n\n段落二继续\n\n- 新列表");
	assert.equal(after[0].raw, before[0].raw);
});

test("图的地址还在写：先藏起来，并说明藏的是图，好先放一块占位", () => {
	const path = "/Users/me/.plume/workspaces/chats/2026-10-19/badaf2f3/feishu-auth-qr.png";
	assert.deepEqual(completeTailHeld("也可以使用下面的二维码：\n\n![飞书授权二维码](/Users/me/.bar"), { text: "也可以使用下面的二维码：\n\n", heldImage: true });
	assert.deepEqual(completeTailHeld("二维码：![飞书授"), { text: "二维码：", heldImage: true }, "说明文字还没写完也算");
	assert.deepEqual(completeTailHeld(`![飞书授权二维码](${path})`), { text: `![飞书授权二维码](${path})`, heldImage: false }, "写完了就是图本身");
	assert.equal(completeTailHeld("[文档](/Users/me/a.m").heldImage, false, "普通链接不是图");
	assert.equal(completeTailHeld("```md\n![图](/a/b").heldImage, false, "代码块里的不算");
});
