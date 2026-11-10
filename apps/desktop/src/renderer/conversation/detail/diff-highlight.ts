/**
 * diff 的语法配色，叠在增删的颜色上面，不替代它。
 *
 * 两者回答同一行的两个问题：这是哪种代码、它改了没有。字形说语法，行的底色和竖条说改动；把加的行整行涂绿，第二个问题
 * 答了两遍，第一个一遍都没答。
 *
 * 每个 hunk 拆成两段整体解析，不逐行解析：删的行属于旧文件，加的行属于新文件，各自拼回去整段解析，跨行的块注释、模板
 * 字符串才不会断色——逐行解析总在这里出错。
 */

import { useEffect, useState } from "react";
import { grammarKeyFor, loadFenceLanguage, sharedHighlightStyle, type Token, tokenize } from "../../markdown/highlight.ts";

interface DiffLine {
	type: "context" | "add" | "remove";
	text: string;
	oldLine?: number;
	newLine?: number;
}

export interface DiffHunk {
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

/** 每一行画出来的配色，按画的次序；还解析不了（语法没加载完、认不出的文件）时是 null，行照纯文本画。 */
export function useDiffHighlight(hunks: DiffHunk[], path?: string): Token[][] | null {
	const [result, setResult] = useState<{ hunks: DiffHunk[]; path: string | undefined; lines: Token[][] } | null>(null);

	useEffect(() => {
		const grammar = path ? grammarKeyFor(path) : null;
		if (!grammar) {
			setResult(null);
			return;
		}
		let cancelled = false;
		void loadFenceLanguage(grammar).then((language) => {
			if (cancelled || !language) return;
			// 用共享的那套样式：另建一套会生成自己的类名，文档里没有对得上的规则。
			const style = sharedHighlightStyle();
			setResult({ hunks, path, lines: highlightHunks(hunks, (code) => tokenLines(tokenize(code, language, style))) });
		});
		return () => {
			cancelled = true;
		};
	}, [hunks, path]);

	// 语法异步加载：新 diff 到了、旧结果还没换掉时，不能把另一个文件的字画上去。
	return result?.hunks === hunks && result.path === path ? result.lines : null;
}

/**
 * 两边各拼回一段、上色，再按画的次序把行发回去。没改的行两段都有，两个游标都要走过它：漏了这一步，第一处改动之后的
 * 每一行颜色都错一行——而且看上去不像坏了，像是配色本来就不对。
 */
function highlightHunks(hunks: DiffHunk[], toLines: (code: string) => Token[][]): Token[][] {
	const rows: Token[][] = [];
	for (const hunk of hunks) {
		const after = toLines(side(hunk, "remove"));
		const before = toLines(side(hunk, "add"));
		let a = 0;
		let b = 0;
		for (const line of hunk.lines) {
			if (line.type === "add") rows.push(after[a++] ?? []);
			else if (line.type === "remove") rows.push(before[b++] ?? []);
			else {
				rows.push(after[a++] ?? []);
				b += 1;
			}
		}
	}
	return rows;
}

/** hunk 的一边，作为一段连续的源码：去掉另一边独有的行。 */
function side(hunk: DiffHunk, exclude: "add" | "remove"): string {
	return hunk.lines
		.filter((line) => line.type !== exclude)
		.map((line) => line.text)
		.join("\n");
}

/** 一串片段按换行切成每行一串：跨行的片段拆开，各行带着同一个类名。 */
function tokenLines(tokens: Token[]): Token[][] {
	const lines: Token[][] = [[]];
	for (const token of tokens) {
		const parts = token.text.split("\n");
		parts.forEach((text, index) => {
			if (index > 0) lines.push([]);
			if (text) lines[lines.length - 1]!.push({ text, className: token.className });
		});
	}
	return lines;
}
