/**
 * 对话里划下的一段：怎么认、怎么量它在屏幕上的位置、发出去时怎么拼回正文。
 *
 * 只认落在同一条消息里的选区（`[data-plume-quote]`，回复和人问的话各挂一处）。跨了消息的那种，拖出来的除了两边的字，还有夹在
 * 中间的时间、「调用工具 N 个」、按钮上的字——拿去问，模型看到的是一段界面，不是谁说过的话。
 */

import type { DraftQuote } from "@plume/contract/ui";

export type { DraftQuote } from "@plume/contract/ui";

/**
 * 写成 Markdown 引用块，后面空一行留给要说的话。空一行不能省：紧跟在 `> …` 下面的一行在 Markdown 里会被并进引用，问题就成了
 * 引文的一部分。
 */
function quoteBlock(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
	return `${lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n")}\n\n`;
}

/**
 * 引文排在要说的话前面，一段一个引用块；只有引文、没说话时去掉末尾那行空行。引文平时挂在草稿上、不写进框里的字：几百字的一段
 * 塞进去，框被撑满，删也只能一个字一个字删。发出去那一刻才拼回来，模型收到的就是引用块加问题。
 */
export function withQuotes(text: string, quotes: readonly Pick<DraftQuote, "text">[]): string {
	if (quotes.length === 0) return text;
	return `${quotes.map((quote) => quoteBlock(quote.text)).join("")}${text}`.trimEnd();
}

/** 选区在哪一条消息里；不在消息里、或者跨了消息，为 null。 */
export function quotedIn(selection: Selection | null, within: HTMLElement): { text: string; range: Range; from: DraftQuote["from"] } | null {
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0);
	const start = holder(range.startContainer);
	if (!start || start !== holder(range.endContainer) || !within.contains(start)) return null;
	const text = selection.toString().trim();
	// 单个字拿去问说明不了什么，多半是点字时手抖带出来的选区，不值得弹一条菜单盖在正文上。按码位数，emoji 算一个。
	if ([...text].length < 2) return null;
	return { text, range: selectedText(range), from: start.getAttribute("data-plume-quote") === "user" ? "user" : "assistant" };
}

function holder(node: Node): Element | null {
	return (node instanceof Element ? node : node.parentElement)?.closest("[data-plume-quote]") ?? null;
}

/**
 * 选区收到人真正看见被选中的字上：起点挪到第一段选中的字，终点挪到最后一段。
 *
 * 三击选段时浏览器把终点放在下一段开头，下一段若是代码块，`user-select: none` 的标题栏被跳过、整个落进选区，量出来的框把它
 * 整栏宽的边框盒也并进来——菜单就对着栏中间，而不是那行字。
 */
function selectedText(range: Range): Range {
	const root = range.commonAncestorContainer;
	if (root.nodeType === Node.TEXT_NODE) return range.cloneRange();
	const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let first: Text | null = null;
	let last: Text | null = null;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		if (!range.intersectsNode(node) || !chosen(node, range)) continue;
		first ??= node;
		last = node;
	}
	if (!first || !last) return range.cloneRange();
	const trimmed = range.cloneRange();
	trimmed.setStart(first, first === range.startContainer ? range.startOffset : 0);
	trimmed.setEnd(last, last === range.endContainer ? range.endOffset : last.length);
	return trimmed;
}

/**
 * 选中的字在屏幕上占的外框，只并字的行框。两端收得了，中间收不了：跨三条列表项划选，中间那条 `<li>` 整个落在范围里，
 * 整个范围的外框会把它整栏宽的边框盒并进来，菜单就挂到了栏的右半边。
 */
export function selectedBounds(range: Range): DOMRect {
	const root = range.commonAncestorContainer;
	if (root.nodeType === Node.TEXT_NODE) return range.getBoundingClientRect();
	const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const piece = root.ownerDocument!.createRange();
	let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		if (!range.intersectsNode(node) || !chosen(node, range)) continue;
		piece.selectNodeContents(node);
		if (node === range.startContainer) piece.setStart(node, range.startOffset);
		if (node === range.endContainer) piece.setEnd(node, range.endOffset);
		for (const rect of piece.getClientRects()) {
			if (!rect.width) continue;
			left = Math.min(left, rect.left);
			top = Math.min(top, rect.top);
			right = Math.max(right, rect.right);
			bottom = Math.max(bottom, rect.bottom);
		}
	}
	return left === Infinity ? range.getBoundingClientRect() : new DOMRect(left, top, right - left, bottom - top);
}

/** 这段字在选区里有没有选中的可见内容：只选到一个换行、或者标题栏那种选不中的字，都不算。 */
function chosen(node: Text, range: Range): boolean {
	const from = node === range.startContainer ? range.startOffset : 0;
	const to = node === range.endContainer ? range.endOffset : node.length;
	if (!node.data.slice(from, to).trim()) return false;
	const parent = node.parentElement;
	return !parent || getComputedStyle(parent).userSelect !== "none";
}
