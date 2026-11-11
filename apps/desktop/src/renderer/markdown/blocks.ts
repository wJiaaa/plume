/**
 * Markdown 的块级结构。
 *
 * 和画它的组件分开，因为这一半才有对错：哪几行是一张表、哪一行只是一句讲表格的话，是有答案的；
 * 表格画成什么样是品味。只有前一种能测，而 `--experimental-strip-types` 加载不了 `.tsx`，所以有答案的
 * 那一半放在测试能直接引用的文件里。
 */

export type Block =
	| { kind: "heading"; level: number; text: string; align?: Align }
	| { kind: "paragraph"; text: string }
	/** `open`：收尾的围栏还没写出来，这一块还在往里进字。 */
	| { kind: "code"; lang: string; code: string; open?: boolean }
	| { kind: "list"; ordered: boolean; items: ListItem[] }
	| { kind: "quote"; text: string }
	| { kind: "rule" }
	| { kind: "table"; header: string[]; rows: string[][]; align: Align[] }
	| { kind: "math"; tex: string }
	/** `summary`：作者没写 `<summary>` 时没有，由画的地方给一个默认标题（解析不碰界面文案）。 */
	| { kind: "details"; summary?: string; children: Block[] }
	/** 块级 HTML 元素：一个 `<div align="center">` 和它里面的块。 */
	| { kind: "html"; align: Align | null; children: Block[] };

/** 一列的对齐方式，来自分隔行里的冒号。 */
type Align = "left" | "center" | "right";

export interface ListItem {
	text: string;
	children: Block[];
	/** 只有 `- [ ]` / `- [x]` 才有；不是任务的圆点没有这一项。 */
	checked?: boolean;
}

export function parseMarkdown(source: string): Block[] {
	return parseBlocks(source.replace(/\r\n/g, "\n").split("\n"));
}

/**
 * 顶层的块，连同各自是从哪段原文来的。
 *
 * 给 `Markdown` 按块记忆用：流式输出时每一帧都整条重新解析（解析很便宜，64 KB 一次不到 1 ms），
 * 贵的是把前面几十个没变的块再画一遍。原文没变的块，画出来就不会变，比一下字符串就够了。
 *
 * 原文从这一块的第一行切到下一块的第一行，块后面的空行算在它身上——一块只会在后面补上空行时多画
 * 一次，不会画错。
 */
export function parseMarkdownChunks(source: string): { block: Block; raw: string }[] {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const starts: number[] = [];
	const blocks = parseBlocks(lines, starts);
	return blocks.map((block, index) => ({ block, raw: lines.slice(starts[index], starts[index + 1] ?? lines.length).join("\n") }));
}

function parseBlocks(lines: string[], starts?: number[]): Block[] {
	const blocks: Block[] = [];
	let i = 0;
	let at = 0;
	const push = (block: Block) => {
		blocks.push(block);
		starts?.push(at);
	};

	while (i < lines.length) {
		const line = lines[i]!;

		if (!line.trim()) {
			i++;
			continue;
		}
		at = i;

		/*
		 * 围栏代码，两种围栏字符都认。
		 *
		 * 没收口的围栏一直算到结尾，而不是什么都不吞：代码块还在流式进来的整段时间里，它就是这个状态。
		 */
		const fence = openFence(line);
		if (fence) {
			const { lang, closer } = fence;
			const code: string[] = [];
			i++;
			while (i < lines.length && !closer.test(lines[i]!)) code.push(lines[i++]!);
			const open = i >= lines.length;
			i++;
			push(open ? { kind: "code", lang, code: code.join("\n"), open } : { kind: "code", lang, code: code.join("\n") });
			continue;
		}

		/*
		 * 独占几行的公式。
		 *
		 * 算块级而不是行内：它居中、上下自带间距——作者把它单放一行，说的是这是一句陈述，不是半句话。
		 */
		if (/^\s*\$\$/.test(line)) {
			const single = /^\s*\$\$(.+?)\$\$\s*$/.exec(line);
			if (single) {
				push({ kind: "math", tex: single[1]!.trim() });
				i++;
				continue;
			}
			const tex: string[] = [line.replace(/^\s*\$\$/, "")];
			i++;
			while (i < lines.length && !/\$\$\s*$/.test(lines[i]!)) tex.push(lines[i++]!);
			if (i < lines.length) tex.push(lines[i++]!.replace(/\$\$\s*$/, ""));
			push({ kind: "math", tex: tex.join("\n").trim() });
			continue;
		}

		/*
		 * `<details>` 块，长日志通常这样折起来。
		 *
		 * 在这里认而不是留给行内那一遍：它里面是块（通常是一段围栏日志），摘要是一个控件，不是一句话。
		 */
		if (/^\s*<details[\s>]/i.test(line)) {
			const { block, next } = parseDetails(lines, i);
			push(block);
			i = next;
			continue;
		}

		/*
		 * 块级 HTML 元素：Markdown 说不出来的，文档都靠它说。
		 *
		 * 留给行内那一遍的话它是透明的：标签没了、内容留着，包着 logo 的 `<p align="center">` 画出来是
		 * 靠左的 logo。更糟的是元素**里面**的换行仍按 Markdown 的换行读，一行一个写的三枚徽章（徽章行的
		 * 常见写法）会摞成三行链接。
		 *
		 * 两个毛病都出在把容器当成正文。在这里认成容器：对齐保留下来，里面按块解析，空白按 HTML 的规矩。
		 */
		if (htmlBlockAt(line)) {
			const { block, next } = parseHtmlBlock(lines, i);
			push(block);
			i = next;
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
			i++;
			continue;
		}

		if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
			push({ kind: "rule" });
			i++;
			continue;
		}

		if (/^\s*>\s?/.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*>\s?/, ""));
			push({ kind: "quote", text: quoted.join("\n") });
			continue;
		}

		if (isTableStart(lines, i)) {
			const header = splitRow(line);
			const align = alignOf(lines[i + 1]!);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(splitRow(lines[i++]!));
			push({ kind: "table", header, rows, align });
			continue;
		}

		if (isListLine(line)) {
			const { list, next } = parseList(lines, i, indentOf(line));
			push(list);
			i = next;
			continue;
		}

		/*
		 * 一段正文一直延续到别的东西开始。
		 *
		 * 表格也算「别的东西开始」。这对 Markdown 本身不成立，但对大家实际写的方言成立：一句话引出一张表，
		 * 表就写在紧接着的下一行、中间不空行，是最常见的写法。
		 */
		const paragraph: string[] = [];
		while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!) && !isTableStart(lines, i)) paragraph.push(lines[i++]!);
		if (paragraph.length > 0) push({ kind: "paragraph", text: paragraph.join("\n") });
		else i++;
	}

	return blocks;
}

const FENCE_OPEN = /^\s*(?:(\x60{3,})([^\x60]*)|(~{3,})(.*))$/;

/**
 * 围栏代码的开头一行：语言和认收口那一行的正则。
 *
 * 围栏后面的信息串（「 bash」「ts title=x」）取第一个词作语言。按 CommonMark，反引号围栏的信息串里不能有反引号，
 * 否则那一行是行内代码。收口的正则每个围栏建一次：流式时每一帧都要把整篇重新解析一遍，在循环里按行建的话，
 * 一个长代码块每帧要建几百个。`stream-tail.ts` 认围栏也用它，两边不会对不上。
 */
export function openFence(line: string): { lang: string; closer: RegExp } | null {
	const fence = FENCE_OPEN.exec(line);
	if (!fence) return null;
	const run = fence[1] ?? fence[3]!;
	return {
		lang: (fence[2] ?? fence[4] ?? "").trim().split(/\s+/)[0] ?? "",
		closer: new RegExp(`^\\s*${run[0] === "~" ? "~" : "\\x60"}{${run.length},}\\s*$`),
	};
}

function isBlockStart(line: string): boolean {
	return (
		/^\s*(\x60{3}|~{3})/.test(line) ||
		/^#{1,6}\s/.test(line) ||
		/^\s*>\s?/.test(line) ||
		/^\s*(---|\*\*\*|___)\s*$/.test(line) ||
		/^\s*\$\$/.test(line) ||
		/^\s*<details[\s>]/i.test(line) ||
		htmlBlockAt(line) !== null ||
		isListLine(line)
	);
}

/**
 * 是容器而不是行内成分的 HTML 元素。
 *
 * 有意列得很短。`<span>`、`<kbd>` 归行内那一遍——提到这里会把一句话从它们那里断成两截——不在表里的
 * 元素保持原来的处理。`h1`–`h6` 也是容器，但它们变成标题而不是盒子，见下面。
 */
const BLOCK_TAGS = new Set(["div", "p", "center", "section", "article", "figure", "figcaption", "main", "aside", "header", "footer"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** 这一行开头的元素，如果这一行开了一个的话。 */
function htmlBlockAt(line: string): { name: string; attrs: string; from: number } | null {
	const open = /^\s*<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)>/.exec(line);
	if (!open) return null;
	const name = open[1]!.toLowerCase();
	if (!BLOCK_TAGS.has(name) && !HEADING_TAGS.has(name)) return null;
	return { name, attrs: open[2] ?? "", from: open[0].length };
}

/**
 * 一个块级元素，里面按块解析。
 *
 * 收尾按深度找，和 `<details>` 找自己的收尾一样，所以 `<div>` 里的 `<div>` 不会让外面那个提前结束。
 * 没收口的元素吃掉文档剩下的部分而不是被丢掉：开了 `<div align="center">` 一直没关的文档，意思仍然是
 * 「下面全部居中」，GitHub 也这样显示。
 */
function parseHtmlBlock(lines: string[], start: number): { block: Block; next: number } {
	const open = htmlBlockAt(lines[start]!);
	if (!open) return { block: { kind: "paragraph", text: lines[start]! }, next: start + 1 };

	const { name, attrs } = open;
	const opener = new RegExp(`<${name}(?:\\s[^<>]*)?>`, "gi");
	const closer = new RegExp(`</${name}\\s*>`, "gi");

	let depth = 0;
	let end = lines.length - 1;
	let closed = false;
	for (let i = start; i < lines.length; i++) {
		depth += lines[i]!.match(opener)?.length ?? 0;
		depth -= lines[i]!.match(closer)?.length ?? 0;
		if (depth <= 0) {
			end = i;
			closed = true;
			break;
		}
	}

	const body = lines
		.slice(start, end + 1)
		.join("\n")
		.slice(open.from);
	const inner = closed ? body.replace(new RegExp(`</${name}\\s*>\\s*$`, "i"), "") : body;
	const align = alignAttr(attrs);

	/*
	 * 标题就是标题，不是装着一个标题的盒子。
	 *
	 * `<h1 align="center">` 是文档给自己起标题的写法；画成一个装着一段正文的容器，标题的位置上就是正文
	 * ——字号不对、字重不对，按大纲读的东西也看不见它。
	 */
	if (HEADING_TAGS.has(name)) {
		const level = Number(name[1]);
		return { block: { kind: "heading", level, text: collapse(inner), ...(align ? { align } : {}) }, next: end + 1 };
	}

	return { block: { kind: "html", align, children: htmlChildren(inner) }, next: end + 1 };
}

/**
 * 容器里面的内容，按块读——但空白按 HTML 的规矩，不按 Markdown 的。
 *
 * 徽章行之所以要这样：一行一个写的三个 `<a><img></a>` 是三个被空白隔开的行内元素，HTML 把空白收成一个
 * 空格、排成一行；Markdown 把同样的换行读成换行，摞起来。HTML 元素的内容跟 HTML 走，所以里面每一段都
 * 折成一行——作者真想在容器里换行，还有 `<br>`，照样管用。
 */
function htmlChildren(inner: string): Block[] {
	return parseBlocks(inner.split("\n")).map((block) => (block.kind === "paragraph" ? { ...block, text: collapse(block.text) } : block));
}

function collapse(text: string): string {
	return text.replace(/\s*\n\s*/g, " ").trim();
}

/** `align="center"`，或者写在 `style` 属性里的同一件事。 */
function alignAttr(attrs: string): Align | null {
	const raw = /(?:^|\s)align\s*=\s*(\x22([^\x22]*)\x22|\x27([^\x27]*)\x27|([^\s>]+))/i.exec(attrs);
	const value = (raw?.[2] ?? raw?.[3] ?? raw?.[4] ?? "").trim().toLowerCase();
	if (value === "center" || value === "middle") return "center";
	if (value === "right") return "right";
	if (value === "left") return "left";

	const style = /(?:^|\s)style\s*=\s*(\x22([^\x22]*)\x22|\x27([^\x27]*)\x27)/i.exec(attrs);
	const styled = /text-align\s*:\s*(left|center|right)/i.exec(style?.[2] ?? style?.[3] ?? "");
	return (styled?.[1]?.toLowerCase() as Align | undefined) ?? null;
}

/**
 * 表格：一行表头，接一行短横线。
 *
 * 唯一一种光看第一行认不出来的块——一行竖线是表头还是一句普通的话，全看下一行是什么。写成一个函数，
 * 因为这段往后看的判断写两份，规则就有两处会走样。
 */
function isTableStart(lines: string[], i: number): boolean {
	return lines[i]!.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]!);
}

function isListLine(line: string): boolean {
	return /^\s*([-*+]|\d+[.)])\s+/.test(line);
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/** 解析一层列表；缩进更深的行递归进当前一项的子块。 */
function parseList(lines: string[], start: number, baseIndent: number): { list: Block; next: number } {
	const first = /^\s*(\d+)[.)]\s+/.exec(lines[start]!);
	const ordered = first !== null;
	const items: ListItem[] = [];
	let i = start;

	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) {
			// 空行只有在后面的内容不属于这个列表时才结束它。
			const lookahead = lines[i + 1];
			if (!lookahead || (!isListLine(lookahead) && indentOf(lookahead) <= baseIndent)) break;
			i++;
			continue;
		}

		const indent = indentOf(line);
		if (indent < baseIndent || !isListLine(line)) {
			if (indent > baseIndent && items.length > 0) {
				/*
				 * 缩进在上一个圆点下面的东西。
				 *
				 * 折行的句子并进那一项自己的文字——它是一句话，做成一段会在圆点里撑开块间距。
				 *
				 * 开始一个块的东西不并。写在圆点下面的表格从前就是接在同一个字符串后面、交给行内渲染，
				 * 竖线和短横线于是原样露出来。从第一行这样的行起，这一项剩下的部分按块读，整体左移到它自己
				 * 的边距，里面那一遍解析看到的就是从第 0 列开始。
				 */
				if (isBlockStart(line) || isTableStart(lines, i)) {
					const nested: string[] = [];
					while (i < lines.length) {
						const next = lines[i]!;
						if (next.trim()) {
							if (indentOf(next) <= baseIndent) break;
							// 不越过一行自己的缩进，否则缩进浅的行会丢掉开头几个字。
							nested.push(next.slice(Math.min(indent, indentOf(next))));
							i++;
							continue;
						}
						// 空行只有后面还跟着这一项的内容时才留在项里。
						const after = lines[i + 1];
						if (!after?.trim() || indentOf(after) <= baseIndent) break;
						nested.push("");
						i++;
					}
					items[items.length - 1]!.children.push(...parseBlocks(nested));
					continue;
				}

				items[items.length - 1]!.text += `\n${line.trim()}`;
				i++;
				continue;
			}
			break;
		}

		if (indent > baseIndent) {
			const nested = parseList(lines, i, indent);
			if (items.length > 0) items[items.length - 1]!.children.push(nested.list);
			i = nested.next;
			continue;
		}

		const marker = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
		const body = marker?.[1] ?? line.trim();

		/*
		 * `- [ ]` 是复选框，不是一个文字以方括号开头的圆点。
		 *
		 * 清单画成字面上的方括号，就丢了它唯一的用处：哪几项做完了。
		 */
		const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
		if (task) items.push({ text: task[2]!, children: [], checked: task[1] !== " " });
		else items.push({ text: body, children: [] });
		i++;
	}

	return { list: { kind: "list", ordered, items }, next: i };
}

/**
 * `<details>` 和它的 `<summary>`，中间的一切按块解析。
 *
 * 收尾按深度找，折起来的一节里嵌着的 `<details>` 不会让外面那个提前结束。没收口的标签把文档剩下的部分
 * 折进去，而不是丢掉。
 */
function parseDetails(lines: string[], start: number): { block: Block; next: number } {
	let depth = 0;
	let end = lines.length - 1;
	for (let i = start; i < lines.length; i++) {
		depth += lines[i]!.match(/<details[\s>]/gi)?.length ?? 0;
		depth -= lines[i]!.match(/<\/details>/gi)?.length ?? 0;
		if (depth === 0) {
			end = i;
			break;
		}
	}

	const body = lines
		.slice(start, end + 1)
		.join("\n")
		.replace(/^\s*<details[^>]*>/i, "")
		.replace(/<\/details>\s*$/i, "");

	const summaryMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(body);
	const inner = summaryMatch ? body.replace(summaryMatch[0], "") : body;
	const children = parseBlocks(inner.split("\n"));

	return { block: summaryMatch ? { kind: "details", summary: summaryMatch[1]!.trim(), children } : { kind: "details", children }, next: end + 1 };
}

/** 分隔行里的冒号说明每一列怎么对齐。 */
function alignOf(separator: string): Align[] {
	return splitRow(separator).map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		return "left";
	});
}

/**
 * 一行拆成单元格。
 *
 * 代码跨度里的竖线是竖线，不是列的边界——反引号里写的 `a | b` 是一个单元格。直接按竖线拆，讲联合类型的
 * 那一行会变成两个参差的单元格，后面每一列都错位。
 */
function splitRow(line: string): string[] {
	const body = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
	const cells: string[] = [];
	let cell = "";
	let inCode = false;

	for (let i = 0; i < body.length; i++) {
		const char = body[i];
		if (char === "`") inCode = !inCode;
		if (char === "\\" && body[i + 1] === "|") {
			// 转义的竖线是字面内容，反斜杠只是为了藏住它。
			cell += "|";
			i++;
			continue;
		}
		if (char === "|" && !inCode) {
			cells.push(cell.trim());
			cell = "";
			continue;
		}
		cell += char;
	}
	cells.push(cell.trim());

	return cells;
}
