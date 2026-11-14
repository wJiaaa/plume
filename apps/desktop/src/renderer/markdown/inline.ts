/**
 * 行内 Markdown，切成 token。
 *
 * 用一条长长的正则把「代码、粗体、斜体、链接」并列起来，表达不了真正要紧的那条规则：有些跨度是不透明的。
 * 代码跨度里的东西不是 Markdown，`$…$` 里的也不是：`$a_*b*$` 是一个公式，按 `*…*` 扫的正则会在它中间
 * 找出一段强调。
 *
 * 所以写成扫描器。每种 token 要么吃掉自己的定界符、再扫一遍中间的内容，要么吃掉定界符、不再扫。整个设计
 * 就是这一个区分。
 *
 * 写成纯 `.ts` 好让测试能直接引用——这是会出错的那一半。
 */

import { type InlineTag, matchHtml } from "./html.ts";

export type Inline =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "math"; tex: string; display: boolean }
	| { kind: "break" }
	| { kind: "strong"; children: Inline[] }
	| { kind: "em"; children: Inline[] }
	| { kind: "del"; children: Inline[] }
	| { kind: "link"; href: string; children: Inline[] }
	/** `width`/`height` 只来自 HTML 的 `<img>`；`![](…)` 没地方写它们。 */
	| { kind: "image"; src: string; alt: string; width?: number; height?: number }
	| { kind: "tag"; name: InlineTag; children: Inline[] };

export function parseInline(source: string): Inline[] {
	const out: Inline[] = [];
	let i = 0;

	/*
	 * 纯文本不是一个字符一个字符攒起来的，是记下起点、到收口时一次切下来。
	 *
	 * 原先那句 `text += char` 每个字符都造一个新字符串，一条 12 MB 的消息光垃圾回收就占了 28.7%
	 * 的时间（profiler 量的，是所有条目里最大的一项）。改成记区间之后，没有转义的那些段一次分配
	 * 都不用。
	 *
	 * `carry` 是给反斜杠转义留的：`\*` 要把 `*` 并进正文，但它和前后的文字属于同一个 text token，
	 * 位置上却是断开的。转义在真实文档里很少，所以只有它才走拼接这条路。
	 */
	let mark = 0;
	let carry = "";

	/** 把 `mark` 到当前位置的这段正文交出去，然后从 `resume` 开始新的一段。 */
	const flush = (resume = i) => {
		const text = carry + (mark < i ? source.slice(mark, i) : "");
		if (text) out.push({ kind: "text", text });
		carry = "";
		mark = resume;
	};

	while (i < source.length) {
		const char = source[i];

		// 反斜杠转义是作者在说「这个字符不是语法」。
		if (char === "\\" && i + 1 < source.length && /[\\\x60*_~[\]()<>#+\-.!$|]/.test(source[i + 1]!)) {
			carry += (mark < i ? source.slice(mark, i) : "") + source[i + 1];
			i += 2;
			mark = i;
			continue;
		}

		if (char === "\n") {
			flush(i + 1);
			out.push({ kind: "break" });
			i++;
			continue;
		}

		if (char === "`") {
			const code = matchCode(source, i);
			if (code) {
				flush(code.next);
				out.push({ kind: "code", text: code.text });
				i = code.next;
				continue;
			}
		}

		if (char === "$") {
			const math = matchMath(source, i);
			if (math) {
				flush(math.next);
				out.push({ kind: "math", tex: math.tex, display: math.display });
				i = math.next;
				continue;
			}
		}

		if (char === "<") {
			const html = matchHtml(source, i, parseInline);
			if (html) {
				flush(html.next);
				out.push(...html.tokens);
				i = html.next;
				continue;
			}
		}

		if (char === "!" && source[i + 1] === "[") {
			const image = matchLink(source, i + 1);
			if (image) {
				flush(image.next);
				out.push({ kind: "image", src: image.href, alt: image.label });
				i = image.next;
				continue;
			}
		}

		if (char === "[") {
			const link = matchLink(source, i);
			if (link) {
				flush(link.next);
				out.push({ kind: "link", href: link.href, children: parseInline(link.label) });
				i = link.next;
				continue;
			}
		}

		if (char === "*" || char === "_" || char === "~") {
			const emphasis = matchEmphasis(source, i);
			if (emphasis) {
				flush(emphasis.next);
				out.push({ kind: emphasis.kind, children: parseInline(emphasis.inner) });
				i = emphasis.next;
				continue;
			}
		}

		if ((char === "h" || char === "w") && isUrlStart(source, i)) {
			const url = matchBareUrl(source, i);
			if (url) {
				flush(url.next);
				out.push({ kind: "link", href: url.href, children: [{ kind: "text", text: url.text }] });
				i = url.next;
				continue;
			}
		}

		// 普通字符：什么都不做，它已经在 `mark` 到 `i` 这段区间里了，收口时一次切下来。
		i++;
	}

	flush();
	return out;
}

/**
 * 一个行内结构最远往后找多少个字符。
 *
 * 这些匹配全是「从这里开始往后找配对，找不到就算了」。没有上限时，**找不到的那些最贵**：一个孤零零
 * 的 `[` 会一路扫到结尾才承认自己不是链接，而下一个 `[` 再扫一遍。正文里这种字符有多少个，就白扫
 * 多少趟——平方级。实测一条 12.26 MB 的消息（一片 49 KB 里有 310 个 `[`、138 个 `_`、112 个 `$`）
 * 光 `parseInline` 就要 4.5 秒。
 *
 * 1000 不是随手定的：CommonMark 给链接标签的上限本来就是 999 字符，所以对 `[…]` 而言这不是新增
 * 限制，是把规范里写着的那条写进代码。强调、公式、代码跨度没有明文上限，但一个跨越一千字符的
 * `*…*` 在真实文档里不存在——而没有上限的代价是整页卡死。
 *
 * URL 单给一个更大的：地址确实可能长，而且它的扫描本来就在遇到空白时停，不会像那几个一样扫穿。
 */
const SPAN = 1000;
const URL_SPAN = 2048;

/** 代码跨度，用开头那串反引号的个数定界。 */
export function matchCode(source: string, start: number): { text: string; next: number } | null {
	let fence = 0;
	while (source[start + fence] === "`") fence++;
	// 手写这个循环而不是 `indexOf`：`indexOf` 找不到时照样会把剩下的全扫一遍，上限就落不下来。
	const fenceRun = "`".repeat(fence);
	const stop = Math.min(source.length - fence, start + fence + SPAN);
	let close = -1;
	for (let at = start + fence; at <= stop; at++) {
		if (source.startsWith(fenceRun, at)) {
			close = at;
			break;
		}
	}
	if (close === -1) return null;
	// 比开头那串更长的一串是内容，不是收口——`` a ``` b `` 是一个跨度。
	if (source[close + fence] === "`") return null;

	const inner = source.slice(start + fence, close);
	// 两边各一个空格是垫着的，让跨度能以反引号开头或结尾。
	const text = inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() ? inner.slice(1, -1) : inner;
	return { text, next: close + fence };
}

/**
 * 公式。
 *
 * `$` 也是货币符号，「costs $5 to $10」不能变成一个内容是「5 to」的公式。区分两者靠空白：开头的 `$`
 * 后面不是空白，收口的 `$` 前面不是空白，而且收口的 `$` 后面不跟数字。最后这一条救下了「$5 and $10」
 * ——KaTeX 自己的 auto-render 也是这条规则。
 */
function matchMath(source: string, start: number): { tex: string; display: boolean; next: number } | null {
	const display = source[start + 1] === "$";
	const fence = display ? "$$" : "$";
	const from = start + fence.length;
	if (!source[from] || /\s/.test(source[from])) return null;

	let i = from;
	const stop = Math.min(source.length, from + SPAN);
	while (i < stop) {
		if (source[i] === "\\") {
			i += 2;
			continue;
		}
		/*
		 * 行内公式碰到换行就收手。
		 *
		 * 下面那句 `tex.includes("\n")` 说的是同一条规则，但它是**找到配对之后**才否决——也就是说
		 * 一个落单的 `$` 要先扫过整段正文，才承认自己只是个美元号。规则既然是「不跨行」，就该在
		 * 跨行的那一刻停，而不是在终点回头看。
		 */
		if (!display && source[i] === "\n") return null;
		if (source.startsWith(fence, i) && !/\s/.test(source[i - 1]!)) {
			const after = source[i + fence.length];
			if (!display && after && /\d/.test(after)) return null;
			const tex = source.slice(from, i);
			// 行内公式不跨行；一个落单的 `$` 不该吞掉一整段。
			if (!display && tex.includes("\n")) return null;
			return { tex, display, next: i + fence.length };
		}
		i++;
	}
	return null;
}

/** `[label](href)`：标签里允许嵌套，地址里允许成对的括号。 */
export function matchLink(source: string, start: number): { label: string; href: string; next: number } | null {
	let depth = 0;
	let i = start;
	// 标签的上限是 CommonMark 自己的 999 字符；扫过这条线还没收口的，不是链接。
	const labelStop = Math.min(source.length, start + SPAN);
	for (; i < labelStop; i++) {
		if (source[i] === "\\") i++;
		else if (source[i] === "[") depth++;
		else if (source[i] === "]") {
			depth--;
			if (depth === 0) break;
		}
	}
	if (depth !== 0 || source[i + 1] !== "(") return null;

	const label = source.slice(start + 1, i);
	let paren = 0;
	let j = i + 1;
	const hrefStop = Math.min(source.length, i + URL_SPAN);
	for (; j < hrefStop; j++) {
		if (source[j] === "\\") j++;
		else if (source[j] === "(") paren++;
		else if (source[j] === ")") {
			paren--;
			if (paren === 0) break;
		}
	}
	if (paren !== 0) return null;

	// 地址后面的标题（[x](url "title")）不显示，但也不能混进地址里。
	const href = source
		.slice(i + 2, j)
		.trim()
		.replace(/\s+[\x22\x27(].*$/, "");
	return { label, href, next: j + 1 };
}

/** `**strong**`、`*em*`、`~~del~~`。下划线只在词外面才算，`a_b_c` 保持原样。 */
function matchEmphasis(source: string, start: number): { kind: "strong" | "em" | "del"; inner: string; next: number } | null {
	const char = source[start]!;
	const double = source[start + 1] === char;
	const fence = double ? char + char : char;

	if (char === "~" && !double) return null;
	if (char === "_" && start > 0 && /[\p{L}\p{N}]/u.test(source[start - 1]!)) return null;

	const from = start + fence.length;
	if (!source[from] || /\s/.test(source[from])) return null;

	let i = from;
	const stop = Math.min(source.length, from + SPAN);
	while (i < stop) {
		if (source[i] === "\\") {
			i += 2;
			continue;
		}
		// 不在代码跨度里收口——`**a `b**` c**` 收在最后一对上，不是第一对。
		if (source[i] === "`") {
			const code = matchCode(source, i);
			if (code) {
				i = code.next;
				continue;
			}
		}
		if (source.startsWith(fence, i) && !/\s/.test(source[i - 1]!)) {
			if (!double && source[i + 1] === char) {
				i++;
				continue;
			}
			if (char === "_" && /[\p{L}\p{N}]/u.test(source[i + fence.length] ?? "")) {
				i++;
				continue;
			}
			const inner = source.slice(from, i);
			if (!inner) return null;
			const kind = char === "~" ? "del" : double ? "strong" : "em";
			return { kind, inner, next: i + fence.length };
		}
		i++;
	}
	return null;
}

function isUrlStart(source: string, i: number): boolean {
	if (i > 0 && /[\p{L}\p{N}/@._-]/u.test(source[i - 1]!)) return false;
	return source.startsWith("http://", i) || source.startsWith("https://", i) || source.startsWith("www.", i);
}

/**
 * 没用链接语法、直接敲出来的网址。
 *
 * 难处全在结尾的标点：「see https://x.com/a.」结尾的句号是正文，而「https://en.wikipedia.org/wiki/Foo_(bar)」
 * 结尾的括号是地址的一部分。结尾的闭括号只有在网址自己开过括号时才保留。
 */
function matchBareUrl(source: string, start: number): { href: string; text: string; next: number } | null {
	let end = start;
	// 没有空白的长数据里，这个循环本来会一路跑到结尾——而那样长的东西不是地址。
	const stop = Math.min(source.length, start + URL_SPAN);
	while (end < stop && !/[\s<>\x22\x27\x60\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(source[end]!)) end++;
	if (end === stop && stop < source.length) return null;

	let url = source.slice(start, end);
	while (url.length > 0) {
		const last = url[url.length - 1]!;
		if (/[.,;:!?]/.test(last)) {
			url = url.slice(0, -1);
			continue;
		}
		if (last === ")" && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}

	// 光秃秃的「www.x.com」没有协议，要打开还得补上一个。
	if (url.length < 8 || !/^[a-z][\w+.-]*:\/\/|^www\./.test(url)) return null;
	return { href: url.startsWith("www.") ? `https://${url}` : url, text: url, next: start + url.length };
}
