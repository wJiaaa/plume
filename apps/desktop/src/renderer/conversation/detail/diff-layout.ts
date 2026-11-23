/**
 * Diff 展示用的纯计算：成对删/加行的行内差异、分栏配对、以及把行内差异与语法高亮片段合并。
 */

import type { ChangeHunk, ChangeLine } from "@plume/contract";
import type { Token } from "../../markdown/highlight.ts";

/**
 * 纯新增或纯删除文件（整份 diff 只有一侧有行）：分栏模式没必要留空另一半，自动退回通栏单列，
 * 避免新增文件左侧一整片空白还要横滚。
 */
export function isSingleSidedDiff(hunks: readonly ChangeHunk[]): boolean {
	let hasAdd = false;
	let hasRemove = false;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.type === "context") return false;
			if (line.type === "add") hasAdd = true;
			else if (line.type === "remove") hasRemove = true;
			if (hasAdd && hasRemove) return false;
		}
	}
	return hasAdd !== hasRemove;
}

/** 一行里的一个文字片段，`changed` 为真时在行底色上再叠一层行内强调色。 */
export interface InlinePart {
	text: string;
	changed: boolean;
}

const MAX_INLINE_LINE = 400;

/**
 * 计算一对删/加行之间的行内差异（公共前缀 + 公共后缀）。
 *
 * 超长行、完全相同或改动占比超过八成时返回 null：整行几乎全变时再涂一层强调色只会让字更花。
 */
export function computeInlineDiff(oldText: string, newText: string): { oldParts: InlinePart[]; newParts: InlinePart[] } | null {
	if (oldText === newText) return null;
	if (!oldText || !newText) return null;
	if (oldText.length > MAX_INLINE_LINE || newText.length > MAX_INLINE_LINE) return null;

	const minLen = Math.min(oldText.length, newText.length);
	let prefix = 0;
	while (prefix < minLen && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
		prefix += 1;
	}

	let suffix = 0;
	while (suffix < minLen - prefix && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) {
		suffix += 1;
	}

	const oldChanged = oldText.length - prefix - suffix;
	const newChanged = newText.length - prefix - suffix;
	if (oldChanged === 0 && newChanged === 0) return null;

	// 公共部分太少（两行几乎无关）就不画行内强调，留给整行底色表达即可。
	const common = prefix + suffix;
	const maxLen = Math.max(oldText.length, newText.length);
	if (common < 2 || common / maxLen < 0.2) return null;

	const slice = (text: string, changedLen: number): InlinePart[] => {
		const parts: InlinePart[] = [];
		if (prefix > 0) parts.push({ text: text.slice(0, prefix), changed: false });
		if (changedLen > 0) parts.push({ text: text.slice(prefix, prefix + changedLen), changed: true });
		if (suffix > 0) parts.push({ text: text.slice(text.length - suffix), changed: false });
		return parts;
	};

	return {
		oldParts: slice(oldText, oldChanged),
		newParts: slice(newText, newChanged),
	};
}

/**
 * 统一视图里，成对出现的连续删除/新增块逐行算出内联差异，按行序号索引。
 */
export function computeUnifiedInlineDiffs(lines: readonly ChangeLine[]): Map<number, InlinePart[]> {
	const map = new Map<number, InlinePart[]>();
	let i = 0;
	while (i < lines.length) {
		if (lines[i]!.type !== "remove") {
			i += 1;
			continue;
		}
		const remStart = i;
		while (i < lines.length && lines[i]!.type === "remove") i += 1;
		const remCount = i - remStart;
		const addStart = i;
		while (i < lines.length && lines[i]!.type === "add") i += 1;
		const addCount = i - addStart;
		if (addCount === 0) continue;
		const pairs = Math.min(remCount, addCount);
		for (let offset = 0; offset < pairs; offset += 1) {
			const pair = computeInlineDiff(lines[remStart + offset]!.text, lines[addStart + offset]!.text);
			if (!pair) continue;
			map.set(remStart + offset, pair.oldParts);
			map.set(addStart + offset, pair.newParts);
		}
	}
	return map;
}

export interface SplitCell {
	line: ChangeLine;
	lineIndex: number;
	parts?: InlinePart[];
}

export interface SplitRow {
	left: SplitCell | null;
	right: SplitCell | null;
}

/**
 * 把 hunk 里的行排成分栏对比（左旧右新）：上下文行占两边，连续的删除块和新增块并排对齐。
 * 保留原来的 `lineIndex`，行号交互在分栏视图里也能照常落回同一个 hunk 行。
 */
export function pairSplitHunk(lines: readonly ChangeLine[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let i = 0;
	while (i < lines.length) {
		const current = lines[i]!;
		if (current.type === "context") {
			const cell: SplitCell = { line: current, lineIndex: i };
			rows.push({ left: cell, right: cell });
			i += 1;
			continue;
		}
		const remStart = i;
		while (i < lines.length && lines[i]!.type === "remove") i += 1;
		const remCount = i - remStart;
		const addStart = i;
		while (i < lines.length && lines[i]!.type === "add") i += 1;
		const addCount = i - addStart;
		const count = Math.max(remCount, addCount);
		for (let offset = 0; offset < count; offset += 1) {
			const leftLine = offset < remCount ? lines[remStart + offset]! : null;
			const rightLine = offset < addCount ? lines[addStart + offset]! : null;
			const pair = leftLine && rightLine ? computeInlineDiff(leftLine.text, rightLine.text) : null;
			rows.push({
				left: leftLine ? { line: leftLine, lineIndex: remStart + offset, ...(pair ? { parts: pair.oldParts } : {}) } : null,
				right: rightLine ? { line: rightLine, lineIndex: addStart + offset, ...(pair ? { parts: pair.newParts } : {}) } : null,
			});
		}
	}
	return rows;
}

export interface InlineTokenRun {
	changed: boolean;
	tokens: Token[];
}

/**
 * 按行内差异边界切分语法高亮片段，让增删词强调与语法色同时保留、互不覆盖。
 */
export function mergeInlineTokens(tokens: readonly Token[], parts: readonly InlinePart[]): InlineTokenRun[] {
	const runs: InlineTokenRun[] = [];
	let tokenIndex = 0;
	let tokenOffset = 0;

	for (const part of parts) {
		let remaining = part.text.length;
		let partOffset = 0;
		const slice: Token[] = [];

		while (remaining > 0 && tokenIndex < tokens.length) {
			const token = tokens[tokenIndex]!;
			const available = token.text.length - tokenOffset;
			const take = Math.min(remaining, available);
			if (take > 0) {
				slice.push({ text: token.text.slice(tokenOffset, tokenOffset + take), className: token.className });
			}
			remaining -= take;
			partOffset += take;
			tokenOffset += take;
			if (tokenOffset >= token.text.length) {
				tokenIndex += 1;
				tokenOffset = 0;
			}
		}

		if (remaining > 0) {
			slice.push({ text: part.text.slice(partOffset), className: "" });
		}
		if (slice.length > 0) {
			runs.push({ changed: part.changed, tokens: slice });
		}
	}

	return runs;
}
