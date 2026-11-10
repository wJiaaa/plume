/**
 * 大家真会写进 Markdown 里的那些 HTML。
 *
 * 不是 HTML 解析器，只认模型输出和文档里常见的十几个标签。这里不产出任何标记：每个分支返回的都是 token，
 * 由渲染器据此建元素，所以作者写的属性一个也进不了 DOM。
 *
 * 要紧的是这几张名单。把每个 `<…>` 都当标签，`Vec<T>` 会丢掉类型参数，`a < b` 会变成一个没收口的元素；
 * 所以名单里没有的，原样保留。
 */

import type { Inline } from "./inline.ts";

/** 按本来样子画出来的 HTML：每一个都有能照办的含义。 */
export type InlineTag = "kbd" | "sub" | "sup" | "mark";
const RENDERED = new Set<string>(["kbd", "sub", "sup", "mark"]);

/** 能对应到已有 token 的 HTML。 */
const ALIASED: Record<string, "strong" | "em" | "del" | "code"> = {
	b: "strong",
	strong: "strong",
	i: "em",
	em: "em",
	s: "del",
	del: "del",
	strike: "del",
	code: "code",
};

/**
 * 认得、但不画任何东西的标签——标签拿掉，内容留着。
 *
 * 认得它们比画它们更要紧。另一种做法是把每个 `<…>` 都当标签，那么一句讲 Rust 的话里的 `Vec<T>` 就丢了
 * 类型参数。不在这几张名单上的，原样保留。
 */
const TRANSPARENT = new Set<string>([
	"span",
	"div",
	"p",
	"a",
	"font",
	"small",
	"big",
	"u",
	"ins",
	"abbr",
	"cite",
	"q",
	"samp",
	"var",
	"time",
	"picture",
	"summary",
	"details",
	"table",
	"thead",
	"tbody",
	"tr",
	"td",
	"th",
	"ul",
	"ol",
	"li",
	"blockquote",
	"pre",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"center",
	"figure",
	"figcaption",
]);

const VOID = new Set<string>(["br", "img", "hr", "wbr", "source", "input"]);

/**
 * 一个 HTML 标签，或者只是长得像的东西。
 *
 * 注释直接拿掉：从模板生成的文字一半是 `<!-- describe your change -->`，显示出来就是把脚手架给读的人看。
 */
export function matchHtml(
	source: string,
	start: number,
	/** 再扫一遍标签里的内容。由调用方传进来，这个文件就不必反过来引用喂给它的扫描器。 */
	parse: (text: string) => Inline[],
): { tokens: Inline[]; next: number } | null {
	if (source.startsWith("<!--", start)) {
		const close = source.indexOf("-->", start + 4);
		return { tokens: [], next: close === -1 ? source.length : close + 3 };
	}

	const open = /^<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\/?>/.exec(source.slice(start));
	if (!open) return null;
	const name = open[1]!.toLowerCase();
	const attrs = open[2] ?? "";
	const after = start + open[0].length;

	if (VOID.has(name)) {
		if (name === "br") return { tokens: [{ kind: "break" }], next: after };
		if (name === "img") {
			const src = attr(attrs, "src");
			if (!src) return { tokens: [], next: after };
			return {
				tokens: [{ kind: "image", src, alt: attr(attrs, "alt") ?? "", width: size(attrs, "width"), height: size(attrs, "height") }],
				next: after,
			};
		}
		return { tokens: [], next: after };
	}

	const rendered = RENDERED.has(name);
	const aliased = ALIASED[name];
	if (!rendered && !aliased && !TRANSPARENT.has(name)) return null;

	// 没有收尾的开标签不算标签，否则 `a < b > c` 会吃掉这一行剩下的部分。
	const close = findClose(source, name, after);
	if (close === -1) return null;
	const inner = source.slice(after, close);
	const next = close + name.length + 3;

	if (name === "a") {
		const href = attr(attrs, "href");
		if (href) return { tokens: [{ kind: "link", href, children: parse(inner) }], next };
	}
	if (aliased === "code") return { tokens: [{ kind: "code", text: inner }], next };
	if (aliased) return { tokens: [{ kind: aliased, children: parse(inner) }], next };
	if (rendered) return { tokens: [{ kind: "tag", name: name as InlineTag, children: parse(inner) }], next };
	return { tokens: parse(inner), next };
}

/** 配对的收尾标签，跳过嵌套的同名元素。 */
function findClose(source: string, name: string, from: number): number {
	const pattern = new RegExp(`<(/?)${name}(?:\\s[^<>]*)?/?>`, "gi");
	pattern.lastIndex = from;
	let depth = 1;
	let match = pattern.exec(source);
	while (match) {
		depth += match[1] === "/" ? -1 : 1;
		if (depth === 0) return match.index;
		match = pattern.exec(source);
	}
	return -1;
}

function attr(attrs: string, name: string): string | null {
	const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
	return match ? (match[2] ?? match[3] ?? match[4] ?? null) : null;
}

/**
 * 作者写在 `<img>` 上的尺寸。
 *
 * `width="200"` 是文档在说「这是个 logo，不是截图」，没有它的话一张 1024px 的图会撑满整栏。只认纯像素数：
 * `width="50%"` 是另一种指令，按它得出的数字（50）不是被忽略，而是错的。
 */
function size(attrs: string, name: "width" | "height"): number | undefined {
	const raw = attr(attrs, name);
	if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
	const value = Number(raw.trim());
	return value > 0 && value <= 4096 ? value : undefined;
}
