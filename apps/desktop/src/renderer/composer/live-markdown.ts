import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

/*
 * 输入框里的 Markdown 就地渲染。
 *
 * 字始终是 Markdown 原文：发出去的、撤销的、复制的都是人打的那些字符，这里只加装饰。标题、加粗、代码这些
 * 会改字宽和行高，所以不能像镜像层那样在原生输入框上叠一层——每个字得由编辑器自己排，光标才落得准。
 *
 * 标记符号（`#`、`**`、`` ` ``、链接的括号和地址）在光标碰到那一段时才露出来，其余时候藏起来，看到的是
 * 渲染后的样子；要改哪一段，光标走过去就是原文。没聚焦时整段都按渲染后的样子画。
 * 围栏代码块和列表编号不藏：前者要能看见语言名、在哪收尾，后者本身就是内容。
 */

const hide = Decoration.replace({});
const marks = {
	strong: Decoration.mark({ class: "plume-md-strong" }),
	em: Decoration.mark({ class: "plume-md-em" }),
	del: Decoration.mark({ class: "plume-md-del" }),
	code: Decoration.mark({ class: "plume-md-code" }),
	link: Decoration.mark({ class: "plume-md-link" }),
	syntax: Decoration.mark({ class: "plume-md-syntax" }),
};
const lines = {
	h1: Decoration.line({ class: "plume-md-h1" }),
	h2: Decoration.line({ class: "plume-md-h2" }),
	h3: Decoration.line({ class: "plume-md-h3" }),
	quote: Decoration.line({ class: "plume-md-quote" }),
	codeBlock: Decoration.line({ class: "plume-md-codeblock" }),
	codeBlockFirst: Decoration.line({ class: "plume-md-codeblock plume-md-codeblock-first" }),
	codeBlockLast: Decoration.line({ class: "plume-md-codeblock plume-md-codeblock-last" }),
	codeBlockOnly: Decoration.line({ class: "plume-md-codeblock plume-md-codeblock-first plume-md-codeblock-last" }),
};

class Bullet extends WidgetType {
	eq(): boolean {
		return true;
	}
	toDOM(): HTMLElement {
		const dot = document.createElement("span");
		dot.className = "plume-md-bullet";
		dot.textContent = "•";
		return dot;
	}
}
const bullet = Decoration.replace({ widget: new Bullet() });

const HEADINGS: Record<string, Decoration> = {
	ATXHeading1: lines.h1,
	SetextHeading1: lines.h1,
	ATXHeading2: lines.h2,
	SetextHeading2: lines.h2,
	ATXHeading3: lines.h3,
	ATXHeading4: lines.h3,
	ATXHeading5: lines.h3,
	ATXHeading6: lines.h3,
};
const INLINE: Record<string, Decoration> = { StrongEmphasis: marks.strong, Emphasis: marks.em, Strikethrough: marks.del, InlineCode: marks.code };
const INLINE_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"]);

function build(state: EditorState, focused: boolean): DecorationSet {
	const doc = state.doc;
	const ranges = focused ? state.selection.ranges : [];
	// 光标或选区碰到这一段（含两端）就算在改它。
	const touched = (from: number, to: number) => ranges.some((range) => range.from <= to && range.to >= from);
	const lineTouched = (pos: number) => {
		const line = doc.lineAt(pos);
		return touched(line.from, line.to);
	};
	const out: Range<Decoration>[] = [];
	const eachLine = (from: number, to: number, pick: (index: number, count: number) => Decoration) => {
		const first = doc.lineAt(from).number;
		const last = doc.lineAt(to).number;
		for (let n = first; n <= last; n++) out.push(pick(n - first, last - first + 1).range(doc.line(n).from));
	};

	syntaxTree(state).iterate({
		enter(node) {
			const { name, from, to } = node;
			const heading = HEADINGS[name];
			if (heading) {
				out.push(heading.range(doc.lineAt(from).from));
				return;
			}
			const inline = INLINE[name];
			if (inline) {
				if (from < to) out.push(inline.range(from, to));
				return;
			}
			switch (name) {
				case "HeaderMark": {
					const line = doc.lineAt(from);
					if (node.node.parent?.name.startsWith("Setext")) {
						out.push(marks.syntax.range(from, to));
						return;
					}
					if (lineTouched(from)) return;
					// 连同它和标题字之间的那个空格一起藏，标题才顶格；行尾的收尾 `#` 连同前面的空格。
					const atStart = from === line.from || /^\s*$/.test(doc.sliceString(line.from, from));
					if (atStart) out.push(hide.range(line.from, Math.min(line.to, to + (doc.sliceString(to, to + 1) === " " ? 1 : 0))));
					else out.push(hide.range(from - (doc.sliceString(from - 1, from) === " " ? 1 : 0), to));
					return;
				}
				case "Blockquote":
					eachLine(from, to, () => lines.quote);
					return;
				case "QuoteMark":
					if (!lineTouched(from)) out.push(hide.range(from, Math.min(doc.lineAt(from).to, to + (doc.sliceString(to, to + 1) === " " ? 1 : 0))));
					return;
				case "FencedCode":
				case "CodeBlock":
					eachLine(from, to, (index, count) =>
						count === 1 ? lines.codeBlockOnly : index === 0 ? lines.codeBlockFirst : index === count - 1 ? lines.codeBlockLast : lines.codeBlock,
					);
					return;
				case "CodeInfo":
					out.push(marks.syntax.range(from, to));
					return;
				case "ListMark": {
					const unordered = node.node.parent?.parent?.name === "BulletList";
					if (unordered && !lineTouched(from)) out.push(bullet.range(from, to));
					else out.push(marks.syntax.range(from, to));
					return;
				}
				case "HorizontalRule":
					out.push(marks.syntax.range(from, to));
					return;
				case "Link": {
					out.push(marks.link.range(from, to));
					if (touched(from, to)) return;
					// 只留方括号里的字：括号、地址、标题都藏起来。
					const cursor = node.node.cursor();
					if (cursor.firstChild()) {
						do {
							if (cursor.name === "LinkMark" || cursor.name === "URL" || cursor.name === "LinkTitle") {
								if (cursor.from < cursor.to) out.push(hide.range(cursor.from, cursor.to));
							}
						} while (cursor.nextSibling());
					}
					return;
				}
				case "URL":
					// 不在链接里的裸地址（`<…>` 和 GFM 自动识别的）。
					if (node.node.parent?.name !== "Link") out.push(marks.link.range(from, to));
					return;
				default:
					if (INLINE_MARKS.has(name)) {
						const parent = node.node.parent;
						// 围栏代码块的 ``` 也叫 CodeMark，那几个不藏。
						if (!parent || !INLINE[parent.name]) {
							out.push(marks.syntax.range(from, to));
							return;
						}
						if (!touched(parent.from, parent.to)) out.push(hide.range(from, to));
					}
			}
		},
	});
	return Decoration.set(out, true);
}

export const liveMarkdown = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = build(view.state, view.hasFocus);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.selectionSet || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
				this.decorations = build(update.state, update.view.hasFocus);
			}
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);
