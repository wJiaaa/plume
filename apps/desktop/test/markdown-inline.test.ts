/**
 * 行内 token——主要是看着像语法、其实不是的情况。
 *
 * 美元符号通常是钱，`<T>` 通常是类型参数，标识符中间的下划线通常是标识符的一部分。这些弄错比根本不支持
 * 这个功能更糟，因为它把本来好好的文字弄坏了。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Inline, parseInline } from "../src/renderer/markdown/inline.ts";
import { stripEmoji } from "../src/renderer/markdown/strip-emoji.ts";

/** 把 token 写成紧凑的形状，断言读起来就像它说的那句话。 */
function shape(tokens: Inline[]): string {
	return tokens
		.map((t) => {
			if (t.kind === "text") return JSON.stringify(t.text);
			if (t.kind === "code") return `code(${JSON.stringify(t.text)})`;
			if (t.kind === "math") return `${t.display ? "display" : "math"}(${JSON.stringify(t.tex)})`;
			if (t.kind === "break") return "br";
			if (t.kind === "image") return `img(${t.src})`;
			if (t.kind === "link") return `link[${t.href}](${shape(t.children)})`;
			if (t.kind === "tag") return `${t.name}(${shape(t.children)})`;
			return `${t.kind}(${shape(t.children)})`;
		})
		.join(" ");
}

test("HTML 注释什么都不留下", () => {
	assert.equal(shape(parseInline("<!-- 请勿删除 -->正文")), '"正文"');
	assert.equal(shape(parseInline("前<!-- x -->后")), '"前" "后"'.replace('" "', '" "'));
});

test("没收口的注释不会悄悄把剩下的全当注释吃掉", () => {
	// 它确实吃到结尾——但必须结束，不能死循环。
	assert.equal(shape(parseInline("a<!-- b")), '"a"');
});

test("类型参数不是标签", () => {
	assert.equal(shape(parseInline("Vec<T> 和 Map<K, V>")), '"Vec<T> 和 Map<K, V>"');
});

test("比较不是标签", () => {
	assert.equal(shape(parseInline("if a < b and b > c")), '"if a < b and b > c"');
});

test("br 变成换行", () => {
	assert.equal(shape(parseInline("第一行<br>第二行")), '"第一行" br "第二行"');
	assert.equal(shape(parseInline("第一行<br/>第二行")), '"第一行" br "第二行"');
});

test("kbd 保留，span 不保留", () => {
	assert.equal(shape(parseInline("按 <kbd>Cmd</kbd>")), '"按 " kbd("Cmd")');
	assert.equal(shape(parseInline('<span style="color:red">红</span>')), '"红"');
});

test("b 和 i 对应到已有的 token", () => {
	assert.equal(shape(parseInline("<b>粗</b><i>斜</i>")), 'strong("粗") em("斜")');
});

test("a 标签保留 href", () => {
	assert.equal(shape(parseInline('<a href="https://x.com">去</a>')), 'link[https://x.com]("去")');
});

test("钱不是公式", () => {
	assert.equal(shape(parseInline("从 $5 涨到 $10")), '"从 $5 涨到 $10"');
	assert.equal(shape(parseInline("成本 $100。")), '"成本 $100。"');
});

test("公式是公式", () => {
	assert.equal(shape(parseInline("复杂度 $O(n \\log n)$。")), '"复杂度 " math("O(n \\\\log n)") "。"');
});

test("公式里的强调不动", () => {
	const tokens = parseInline("$a_*b*_c$");
	assert.equal(tokens.length, 1);
	assert.equal(tokens[0].kind, "math");
	assert.equal(tokens[0].tex, "a_*b*_c", "扫描器不能再扫进公式里");
});

test("一行里的独立公式", () => {
	assert.equal(shape(parseInline("$$x^2$$")), 'display("x^2")');
});

test("行内公式不跨行", () => {
	assert.equal(shape(parseInline("价格 $5\n还有 $6")), '"价格 $5" br "还有 $6"');
});

test("代码跨度里的 Markdown 保持原样", () => {
	assert.equal(shape(parseInline("`**not bold**`")), 'code("**not bold**")');
	assert.equal(shape(parseInline("`$x$`")), 'code("$x$")');
});

test("垫了空格的代码跨度能装反引号", () => {
	assert.equal(shape(parseInline("`` ` ``")), 'code("`")');
});

test("词中间的下划线不是强调", () => {
	assert.equal(shape(parseInline("identity_admin.result_denied")), '"identity_admin.result_denied"');
});

test("强调可以嵌套", () => {
	assert.equal(shape(parseInline("**粗 `代码` 粗**")), 'strong("粗 " code("代码") " 粗")');
});

test("裸网址变成链接", () => {
	assert.equal(shape(parseInline("见 https://github.com/a/b/pull/904")), '"见 " link[https://github.com/a/b/pull/904]("https://github.com/a/b/pull/904")');
});

test("网址后面的句号是正文", () => {
	const tokens = parseInline("见 https://x.com/a。");
	const link = tokens.find((t) => t.kind === "link");
	assert.equal(link?.kind, "link");
	assert.equal(link.href, "https://x.com/a");
});

test("已经在链接语法里的网址不重复", () => {
	assert.equal(shape(parseInline("[看这里](https://x.com)")), 'link[https://x.com]("看这里")');
});

test("链接标题不进 href", () => {
	const tokens = parseInline('[x](https://a.com "标题")');
	assert.equal(tokens[0].kind, "link");
	assert.equal(tokens[0].href, "https://a.com");
});

test("图是图", () => {
	assert.equal(shape(parseInline("![图](https://x.com/a.png)")), "img(https://x.com/a.png)");
	assert.equal(shape(parseInline('<img src="https://x.com/b.png" width="400">')), "img(https://x.com/b.png)");
});

test("转义表示这个字符不是语法", () => {
	assert.equal(shape(parseInline("\\*不是斜体\\*")), '"*不是斜体*"');
	assert.equal(shape(parseInline("\\$5")), '"$5"');
});

test("details、summary 标签消失，里面的字不消失", () => {
	assert.equal(shape(parseInline("<summary>展开日志</summary>")), '"展开日志"');
});

test("写明的宽度会带过来，只在它是像素数时", () => {
	// `width="200"` 是文档在说这是个 logo。`50%` 是另一种指令，按它得出的数字（50）不是被忽略，而是错的。
	const sized = parseInline('<img src="a.png" alt="A" width="200" height="80">')[0];
	assert.equal(sized.kind === "image" && sized.width, 200);
	assert.equal(sized.kind === "image" && sized.height, 80);

	for (const attrs of ['width="50%"', 'width="auto"', 'width="0"', 'width="99999"', 'data-width="200"']) {
		const token = parseInline(`<img src="a.png" ${attrs}>`)[0];
		assert.equal(token.kind === "image" && token.width, undefined, attrs);
	}
});

test("表情只从普通文字里拿掉：行内代码、链接地址原样，文字末尾接着行内代码的空格留着", () => {
	const tokens = parseInline("🤖 跑 `echo 🎉` 看 [文档](https://example.com/🎉)");
	assert.deepEqual(
		tokens.flatMap((token) => (token.kind === "text" ? [stripEmoji(token.text)] : [])),
		["跑 ", " 看 "],
	);
	assert.ok(tokens.some((token) => token.kind === "code" && token.text === "echo 🎉"));
	assert.equal(stripEmoji("完成 🎉\n下一步"), "完成\n下一步");
});
