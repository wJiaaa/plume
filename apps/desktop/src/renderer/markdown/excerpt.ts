/**
 * 一段 Markdown 读出来的样子，压成一行纯文字：问题导航的悬停预览要的是能读的一段摘录，不是第二份带分隔线、
 * 嵌入和控件的文档。
 */

import { type Block, parseMarkdown } from "./blocks.ts";
import { type Inline, parseInline } from "./inline.ts";

function inlineText(tokens: Inline[]): string {
	return tokens
		.map((token) => {
			if ("children" in token) return inlineText(token.children);
			if ("text" in token) return token.text;
			if (token.kind === "math") return token.tex;
			if (token.kind === "image") return token.alt;
			return " ";
		})
		.join("");
}

function blockText(blocks: Block[]): string {
	return blocks
		.map((block) => {
			switch (block.kind) {
				case "rule":
					return "";
				case "code":
					return block.code;
				case "math":
					return block.tex;
				case "html":
					return blockText(block.children);
				case "details":
					return `${block.summary ? inlineText(parseInline(block.summary)) : ""} ${blockText(block.children)}`;
				case "list":
					return block.items.map((item) => `${inlineText(parseInline(item.text))} ${blockText(item.children)}`).join(" ");
				case "table":
					return [...block.header, ...block.rows.flat()].map((cell) => inlineText(parseInline(cell))).join(" ");
				default:
					return inlineText(parseInline(block.text));
			}
		})
		.join(" ");
}

export function markdownExcerpt(source: string): string {
	return blockText(parseMarkdown(source)).replace(/\s+/g, " ").trim();
}
