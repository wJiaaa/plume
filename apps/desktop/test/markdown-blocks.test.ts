/**
 * 块的解析——主要是块不在顶层的那些地方。
 *
 * 起因：写在圆点下面的表格被当成字符串接在那一项的文字后面，于是交给了行内渲染，竖线和短横线原样画了出来。
 * 模型的回复里这种写法很常见。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Block, parseMarkdown } from "../src/renderer/markdown/blocks.ts";

function only(blocks: Block[], kind: Block["kind"]): Block {
	const found = blocks.find((block) => block.kind === kind);
	assert.ok(found, `expected a ${kind} block, got ${blocks.map((b) => b.kind).join(", ")}`);
	return found;
}

test("缩进在圆点下面的表格是表格，不是文字", () => {
	const blocks = parseMarkdown(
		[
			"- **自适应节奏**：以是否有更新在执行中为准。",
			"  | 状态 | 轮询 | SSE 重连 |",
			"  |------|------|----------|",
			"  | 运行中 | 2s | 300ms → 3s |",
			"  | 空闲 | 30s | 3s → 30s |",
		].join("\n"),
	);

	const list = only(blocks, "list");
	assert.equal(list.kind, "list");
	const table = only(list.items[0].children, "table");
	assert.equal(table.kind, "table");
	assert.deepEqual(table.header, ["状态", "轮询", "SSE 重连"]);
	assert.equal(table.rows.length, 2);
	assert.deepEqual(table.rows[1], ["空闲", "30s", "3s → 30s"]);

	// 圆点自己的那句话不受影响，没有竖线并进去。
	assert.ok(!list.items[0].text.includes("|"));
});

test("那张表后面的话是同一项里的一段", () => {
	const blocks = parseMarkdown(["- 节奏：", "  | a | b |", "  |---|---|", "  | 1 | 2 |", "  更新过程中的行为与原来完全一致。", "- 下一条"].join("\n"));

	const list = only(blocks, "list");
	assert.equal(list.kind, "list");
	assert.equal(list.items.length, 2, "第二个圆点仍是并列的一项，不能被吞掉");
	assert.equal(list.items[1].text, "下一条");

	const kinds = list.items[0].children.map((child) => child.kind);
	assert.deepEqual(kinds, ["table", "paragraph"]);
});

test("圆点下面的围栏代码保留自己的各行", () => {
	const blocks = parseMarkdown(["- 运行：", "  ```sh", "  pnpm dev", "  ```"].join("\n"));

	const list = only(blocks, "list");
	assert.equal(list.kind, "list");
	const code = only(list.items[0].children, "code");
	assert.equal(code.kind, "code");
	assert.equal(code.lang, "sh");
	assert.equal(code.code, "pnpm dev");
});

test("圆点下面的围栏保留里面的相对缩进", () => {
	const blocks = parseMarkdown(["- 配置：", "  ```json", "  {", '    "a": 1', "  }", "  ```"].join("\n"));

	const list = only(blocks, "list");
	assert.equal(list.kind, "list");
	const code = only(list.items[0].children, "code");
	assert.equal(code.kind, "code");
	assert.equal(code.code, '{\n  "a": 1\n}', "去掉的是圆点的两格缩进，JSON 自己的缩进不动");
});

test("圆点下面折行的句子仍并进那一项", () => {
	const blocks = parseMarkdown(["- 第一行", "  第二行", "- 下一条"].join("\n"));

	const list = only(blocks, "list");
	assert.equal(list.kind, "list");
	assert.equal(list.items[0].text, "第一行\n第二行");
	assert.equal(list.items[0].children.length, 0, "正文不能变成一个段落块");
});

test("圆点下面的嵌套列表仍是嵌套列表", () => {
	const blocks = parseMarkdown(["- 外层", "  - 内层 A", "  - 内层 B", "- 外层二"].join("\n"));

	const list = only(blocks, "list");
	assert.equal(list.kind, "list");
	assert.equal(list.items.length, 2);
	const inner = only(list.items[0].children, "list");
	assert.equal(inner.kind, "list");
	assert.equal(inner.items.length, 2);
});

test("紧跟在一句话下一行的表格是表格", () => {
	// GitHub 允许表格打断段落，大家也就这样写。
	const blocks = parseMarkdown(["改动如下：", "| 状态 | 轮询 |", "|---|---|", "| 空闲 | 30s |"].join("\n"));

	assert.deepEqual(
		blocks.map((block) => block.kind),
		["paragraph", "table"],
	);
});

test("单独一行竖线是一句话，不是表格", () => {
	const blocks = parseMarkdown("用 | 分隔字段。");
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["paragraph"],
	);
});

test("代码跨度里的竖线不拆单元格", () => {
	const blocks = parseMarkdown(["| 类型 | 说明 |", "|---|---|", "| `a \\| b` | 联合 |"].join("\n"));

	const table = only(blocks, "table");
	assert.equal(table.kind, "table");
	assert.deepEqual(table.rows[0], ["`a | b`", "联合"], "one cell, with a literal pipe in it");
});

test("转义的竖线是字面内容", () => {
	const blocks = parseMarkdown(["| a | b |", "|---|---|", "| x \\| y | z |"].join("\n"));

	const table = only(blocks, "table");
	assert.equal(table.kind, "table");
	assert.deepEqual(table.rows[0], ["x | y", "z"]);
});

test("缺单元格的行保留已有的单元格", () => {
	// 手写的表格常常少一个单元格；整行丢掉会丢掉真实内容。
	const blocks = parseMarkdown(["| a | b | c |", "|---|---|---|", "| 1 | 2 |"].join("\n"));

	const table = only(blocks, "table");
	assert.equal(table.kind, "table");
	assert.deepEqual(table.rows[0], ["1", "2"]);
});

test("清单是复选框，不是以方括号开头的圆点", () => {
	const blocks = parseMarkdown("- [x] 已完成\n- [ ] 未完成\n- 普通条目");

	const list = only(blocks, "list");
	assert.equal(list.kind, "list");
	assert.deepEqual(
		list.items.map((item) => [item.checked, item.text]),
		[
			[true, "已完成"],
			[false, "未完成"],
			[undefined, "普通条目"],
		],
		"a bullet that is not a task carries no checked state at all",
	);
});

test("不是复选框的方括号保持文字", () => {
	const list = only(parseMarkdown("- [见附录] 说明"), "list");
	assert.equal(list.kind, "list");
	assert.equal(list.items[0].checked, undefined);
	assert.equal(list.items[0].text, "[见附录] 说明");
});

test("波浪线围栏也是围栏", () => {
	const code = only(parseMarkdown("~~~js\nconst a = 1;\n~~~"), "code");
	assert.equal(code.kind, "code");
	assert.equal(code.lang, "js");
	assert.equal(code.code, "const a = 1;");
});

test("波浪线围栏里的反引号是内容", () => {
	const code = only(parseMarkdown("~~~\n```\n~~~"), "code");
	assert.equal(code.kind, "code");
	assert.equal(code.code, "```", "另一种围栏字符不能让这一块收口");
});

test("独占几行的公式", () => {
	const math = only(parseMarkdown("$$\n\\frac{a}{b}\n$$"), "math");
	assert.equal(math.kind, "math");
	assert.equal(math.tex, "\\frac{a}{b}");
});

test("写在一行里的独立公式", () => {
	const math = only(parseMarkdown("$$x^2 + y^2 = z^2$$"), "math");
	assert.equal(math.kind, "math");
	assert.equal(math.tex, "x^2 + y^2 = z^2");
});

test("列的对齐来自冒号", () => {
	const table = only(parseMarkdown("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |"), "table");
	assert.equal(table.kind, "table");
	assert.deepEqual(table.align, ["left", "center", "right"]);
});

test("details 保留摘要，里面按块解析", () => {
	const blocks = parseMarkdown("<details>\n<summary>展开日志</summary>\n\n段落\n\n- 一\n- 二\n\n</details>");

	const details = only(blocks, "details");
	assert.equal(details.kind, "details");
	assert.equal(details.summary, "展开日志");
	assert.deepEqual(
		details.children.map((child) => child.kind),
		["paragraph", "list"],
	);
});

test("没有摘要的 details 照样折叠", () => {
	const details = only(parseMarkdown("<details>\n正文\n</details>"), "details");
	assert.equal(details.kind, "details");
	assert.equal(details.summary, undefined, "没写摘要时不带，由画的地方给默认标题");
});

test("嵌套的 details 不会让外面那个提前结束", () => {
	const blocks = parseMarkdown("<details>\n<summary>外</summary>\n\n<details>\n<summary>内</summary>\n\n里\n\n</details>\n\n</details>\n\n之后");

	assert.deepEqual(
		blocks.map((block) => block.kind),
		["details", "paragraph"],
		"后面那段必须在折叠外面",
	);
	const outer = only(blocks, "details");
	assert.equal(outer.kind, "details");
	assert.equal(outer.summary, "外");
	assert.ok(
		outer.children.some((child) => child.kind === "details"),
		"里面的折叠仍是折叠",
	);
});

/* ---------------------------------------------------------------------------
 * 块级 HTML——文档开头常见的样子。
 *
 * 包着 logo 的 `<p align="center">` 如果当成透明的：标签没了、内容留着，对齐也跟着没了。里面的换行
 * 还会按 Markdown 的换行读，一行一个链接写的徽章行会摞起来。两者都是把容器的语义用在了正文上，
 * 下面这些守的就是这个。
 * ------------------------------------------------------------------------- */

test("居中的容器保留对齐和内容", () => {
	const blocks = parseMarkdown('<p align="center">\n  <img src="assets/plume.png" alt="Plume" width="200">\n</p>');

	const html = only(blocks, "html");
	assert.equal(html.kind, "html");
	assert.equal(html.align, "center");
	assert.equal(html.children.length, 1);
	assert.equal(html.children[0].kind, "paragraph");
});

test("容器里的换行是空白，不是换行", () => {
	const html = only(
		parseMarkdown('<p align="center">\n  <a href="a"><img src="1.svg" alt="CI"></a>\n  <a href="b"><img src="2.svg" alt="MIT"></a>\n</p>'),
		"html",
	);

	assert.equal(html.kind, "html");
	// 一段，折成一行：三枚徽章摞成三行正是这里要防的。
	assert.equal(html.children.length, 1);
	const first = html.children[0];
	assert.equal(first.kind, "paragraph");
	assert.ok(first.kind === "paragraph" && !first.text.includes("\n"), first.kind === "paragraph" ? first.text : "");
});

test("带对齐的标题是标题，不是装着字的盒子", () => {
	const heading = only(parseMarkdown('<h1 align="center">标题</h1>'), "heading");

	assert.equal(heading.kind, "heading");
	assert.equal(heading.kind === "heading" && heading.level, 1);
	assert.equal(heading.kind === "heading" && heading.text, "标题");
	assert.equal(heading.kind === "heading" && heading.align, "center");
});

test("style 里的 text-align 和 align 是一个意思", () => {
	const html = only(parseMarkdown('<div style="text-align: center">中间</div>'), "html");
	assert.equal(html.kind === "html" && html.align, "center");
});

test("没有对齐的容器仍是容器", () => {
	const html = only(parseMarkdown("<div>\n\n里面的一段\n\n</div>"), "html");
	assert.equal(html.kind === "html" && html.align, null);
	assert.equal(html.kind === "html" && html.children.length, 1);
});

test("容器里的块仍是块", () => {
	const html = only(parseMarkdown('<div align="center">\n\n## 小标题\n\n- 一\n- 二\n\n</div>'), "html");

	assert.deepEqual(
		html.kind === "html" ? html.children.map((child) => child.kind) : [],
		["heading", "list"],
		"a heading and a list inside a div are a heading and a list",
	);
});

test("嵌套的容器不会让外面那个提前结束", () => {
	const blocks = parseMarkdown('<div align="center">\n<div>内层</div>\n</div>\n\n之后');

	assert.deepEqual(
		blocks.map((block) => block.kind),
		["html", "paragraph"],
		"后面那段必须在盒子外面",
	);
	const outer = only(blocks, "html");
	assert.ok(outer.kind === "html" && outer.children.some((child) => child.kind === "html"), "里面的盒子仍是盒子");
});

test("没收口的容器吃掉剩下的部分，和 GitHub 的读法一样", () => {
	const blocks = parseMarkdown('<div align="center">\n\n一段\n\n两段');

	assert.deepEqual(
		blocks.map((block) => block.kind),
		["html"],
	);
	assert.equal(blocks[0].kind === "html" && blocks[0].children.length, 2);
});

test("容器结束它上面的那段", () => {
	const blocks = parseMarkdown('一句话\n<p align="center">中间</p>\n另一句');

	assert.deepEqual(
		blocks.map((block) => block.kind),
		["paragraph", "html", "paragraph"],
	);
});

test("行内标签不是容器", () => {
	// `<span>`、`<kbd>` 归行内那一遍，提到块级会把一句话从它那里断成两截；`<picture>` 也不能被读成带属性的 `<p>`。
	for (const line of ["<span>一句</span>话", "<kbd>Esc</kbd> 退出", "<picture><img src='a.png'></picture>"]) {
		assert.deepEqual(
			parseMarkdown(line).map((block) => block.kind),
			["paragraph"],
			line,
		);
	}
});

test("围栏后面的信息串取第一个词作语言：空格隔开、带属性都认", () => {
	for (const [opening, lang] of [
		["``` bash", "bash"],
		["```ts title=x", "ts"],
		["~~~ py {.line-numbers}", "py"],
	] as const) {
		const code = only(parseMarkdown([opening, "x", opening.slice(0, 3)].join("\n")), "code");
		assert.equal(code.kind, "code");
		assert.equal(code.lang, lang);
		assert.equal(code.code, "x");
		assert.equal("open" in code, false);
	}
});

test("反引号围栏的信息串里有反引号时不是围栏，是行内代码", () => {
	const blocks = parseMarkdown("```a`b\nx");
	assert.equal(
		blocks.some((block) => block.kind === "code"),
		false,
	);
});

test("收口要和开头同一种字符、至少一样长", () => {
	const code = only(parseMarkdown(["````md", "```", "~~~", "````"].join("\n")), "code");
	assert.equal(code.kind, "code");
	assert.equal(code.code, "```\n~~~");
});
