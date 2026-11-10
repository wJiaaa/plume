/**
 * 把抓来的网页变成值得花 token 的文字。
 *
 * 只删标签、压空白的做法会毁掉模型最常要的三样：表格变成一串没有行的词，嵌套列表丢了层次，代码块丢了换行。
 * 这里按标记走一遍，留下有意义的结构、丢掉只管样式的结构。不引 DOM 库：抓来的网页是不可信的输入，
 * 用一个小分词器加有上限的栈就够；认不出的地方退回成文字而不是抛错——排版差的一页也比一个错误有用。
 */

import { decodeEntities } from "./entities.ts";

/** 嵌套深度记到多少为止。嵌得比这还深的页面不是生成的就是恶意的，深度不再是信息；这道限是不让病态输入变成病态的工作量。 */
const MAX_DEPTH = 64;

/** 整段内容都是噪音的元素：写给浏览器的，不是给读者的。 */
const DROP = new Set(["script", "style", "noscript", "svg", "canvas", "template", "iframe", "object", "embed"]);

/** 换行但不空行的元素。 */
const LINE_BREAK = new Set(["br", "tr", "li", "dt", "dd"]);

/** 前后要空一行的元素。 */
const BLOCK = new Set([
	"p",
	"div",
	"section",
	"article",
	"header",
	"footer",
	"main",
	"aside",
	"nav",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"pre",
	"table",
	"ul",
	"ol",
	"dl",
	"form",
	"figure",
	"hr",
]);

interface Token {
	kind: "open" | "close" | "text";
	name?: string;
	text?: string;
	attrs?: string;
}

/**
 * 把标记切成标签和文字。
 *
 * 故意不做校验：没闭合的标签、落单的 `<`、引号里带 `>` 的属性在真实网页里都有，合理的做法都是接着往下走。
 */
function* tokenize(html: string): Generator<Token> {
	let index = 0;
	while (index < html.length) {
		const next = html.indexOf("<", index);
		if (next === -1) {
			yield { kind: "text", text: html.slice(index) };
			return;
		}
		if (next > index) yield { kind: "text", text: html.slice(index, next) };

		/*
		 * 只有下一个字符能开始一个标签时，`<` 才算开标签。
		 *
		 * 正文里有比较（`a < b`、`if (x<y)`），当成标签会吞掉直到下一个 `>` 的整句。浏览器也是这条规则。
		 */
		if (!/[a-zA-Z/!]/.test(html[next + 1] ?? "")) {
			yield { kind: "text", text: "<" };
			index = next + 1;
			continue;
		}

		// 注释和 doctype 没有内容。
		if (html.startsWith("<!--", next)) {
			const end = html.indexOf("-->", next);
			index = end === -1 ? html.length : end + 3;
			continue;
		}
		if (html.startsWith("<!", next)) {
			const end = html.indexOf(">", next);
			index = end === -1 ? html.length : end + 1;
			continue;
		}

		// 找标签的结尾，跳过引号属性里的 `>`。
		let cursor = next + 1;
		let quote: string | null = null;
		while (cursor < html.length) {
			const char = html[cursor];
			if (quote) {
				if (char === quote) quote = null;
			} else if (char === '"' || char === "'") {
				quote = char;
			} else if (char === ">") {
				break;
			}
			cursor++;
		}
		if (cursor >= html.length) {
			yield { kind: "text", text: html.slice(next) };
			return;
		}

		const raw = html.slice(next + 1, cursor).trim();
		index = cursor + 1;
		if (!raw) continue;

		const closing = raw.startsWith("/");
		const body = closing ? raw.slice(1) : raw;
		const space = body.search(/[\s/]/);
		const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
		if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;

		yield closing ? { kind: "close", name } : { kind: "open", name, attrs: space === -1 ? "" : body.slice(space) };
	}
}

/** 列表栈上的一项：哪种列表，已经写了几条。 */
interface ListFrame {
	ordered: boolean;
	count: number;
}

/**
 * 把网页画成能读的文字，表格、列表、代码都留着。
 *
 * 输出像 Markdown 而不是严格的 Markdown：模型两种都读得懂，追求严格就得转义那些原样看更好的内容。
 */
export function htmlToText(html: string): string {
	let out = "";
	/** `<pre>` 里空白就是内容：代码全靠它撑着。 */
	let preDepth = 0;
	let inTable = false;
	/** 正在拼的这一行的单元格，表格才按行出来而不是一锅词。 */
	let row: string[] = [];
	let cell: string | null = null;
	let headerPending = false;
	const lists: ListFrame[] = [];
	/** 在整段丢弃的元素里面时设上。 */
	let dropping: string | null = null;

	const write = (text: string) => {
		if (cell !== null) cell += text;
		else out += text;
	};
	const newline = () => {
		if (cell !== null) return;
		if (!out.endsWith("\n")) out += "\n";
	};
	const blankLine = () => {
		if (cell !== null) return;
		out = out.replace(/[ \t]+$/, "");
		if (out && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
	};

	for (const token of tokenize(html)) {
		if (dropping) {
			if (token.kind === "close" && token.name === dropping) dropping = null;
			continue;
		}

		if (token.kind === "text") {
			const decoded = decodeEntities(token.text ?? "");
			if (preDepth > 0) write(decoded);
			else if (decoded.trim()) write(decoded.replace(/\s+/g, " "));
			else if (decoded && !out.endsWith(" ") && cell === null) write(" ");
			continue;
		}

		const name = token.name ?? "";
		if (token.kind === "open") {
			if (DROP.has(name)) {
				dropping = name;
				continue;
			}
			switch (name) {
				case "pre":
					blankLine();
					write("```\n");
					preDepth++;
					break;
				case "code":
					if (preDepth === 0) write("`");
					break;
				case "ul":
				case "ol":
					if (lists.length < MAX_DEPTH) lists.push({ ordered: name === "ol", count: 0 });
					blankLine();
					break;
				case "li": {
					newline();
					const frame = lists.at(-1);
					const indent = "  ".repeat(Math.max(0, lists.length - 1));
					if (frame) {
						frame.count++;
						write(`${indent}${frame.ordered ? `${frame.count}. ` : "- "}`);
					} else {
						write("- ");
					}
					break;
				}
				case "table":
					blankLine();
					inTable = true;
					headerPending = true;
					break;
				case "tr":
					row = [];
					break;
				case "th":
				case "td":
					cell = "";
					break;
				case "blockquote":
					blankLine();
					write("> ");
					break;
				case "hr":
					blankLine();
					write("---");
					blankLine();
					break;
				case "br":
					newline();
					break;
				case "h1":
				case "h2":
				case "h3":
				case "h4":
				case "h5":
				case "h6":
					blankLine();
					write(`${"#".repeat(Number(name[1]))} `);
					break;
				default:
					if (BLOCK.has(name)) blankLine();
					else if (LINE_BREAK.has(name)) newline();
			}
			continue;
		}

		// 闭合标签。
		switch (name) {
			case "pre":
				preDepth = Math.max(0, preDepth - 1);
				if (!out.endsWith("\n")) out += "\n";
				write("```");
				blankLine();
				break;
			case "code":
				if (preDepth === 0) write("`");
				break;
			case "ul":
			case "ol":
				lists.pop();
				blankLine();
				break;
			case "th":
			case "td":
				row.push((cell ?? "").trim());
				cell = null;
				break;
			case "tr":
				if (inTable && row.length > 0) {
					newline();
					out += `| ${row.join(" | ")} |`;
					newline();
					if (headerPending) {
						// 有分隔行，第一行才是表头而不是正文的第一行。
						out += `|${row.map(() => " --- ").join("|")}|`;
						newline();
						headerPending = false;
					}
				}
				row = [];
				break;
			case "table":
				inTable = false;
				headerPending = false;
				blankLine();
				break;
			default:
				if (BLOCK.has(name)) blankLine();
				else if (LINE_BREAK.has(name)) newline();
		}
	}

	return (
		out
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			// 锚在非空白字符后面，行首的缩进才留得下：列表的嵌套靠它，压掉了嵌套列表就全成一层。
			.replace(/(\S)[ \t]{2,}/g, "$1 ")
			.trim()
	);
}
