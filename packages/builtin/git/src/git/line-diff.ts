/**
 * 按行比较，给出带上下文的 hunk：面板要画行、要数行，光有计数不够。
 *
 * Myers 最短编辑脚本，搜索有上限：两处离得很远的改动不会分配整个文件的矩阵，
 * 超过上限的大改写退回成整块删、整块加，结果仍然准确。
 */

import type { DiffHunk, DiffLine } from "../api.ts";

export interface FileDiff {
	added: number;
	removed: number;
	hunks: DiffHunk[];
}

const CONTEXT_LINES = 3;

export function computeDiff(before: string, after: string, contextLines = CONTEXT_LINES): FileDiff {
	const ops = diffLines(splitLines(before), splitLines(after));
	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.type === "add") added++;
		else if (op.type === "remove") removed++;
	}
	return { added, removed, hunks: groupHunks(ops, contextLines) };
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function diffLines(a: string[], b: string[]): DiffLine[] {
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	const midA = a.slice(prefix, a.length - suffix);
	const midB = b.slice(prefix, b.length - suffix);
	const middle = shortestEdits(midA, midB) ?? [
		...midA.map((text): DiffLine => ({ type: "remove", text })),
		...midB.map((text): DiffLine => ({ type: "add", text })),
	];
	const ops: DiffLine[] = [
		...a.slice(0, prefix).map((text): DiffLine => ({ type: "context", text })),
		...middle,
		...a.slice(a.length - suffix).map((text): DiffLine => ({ type: "context", text })),
	];
	let oldLine = 1;
	let newLine = 1;
	for (const op of ops) {
		if (op.type !== "add") op.oldLine = oldLine++;
		if (op.type !== "remove") op.newLine = newLine++;
	}
	return ops;
}

function shortestEdits(a: string[], b: string[]): DiffLine[] | null {
	const frontier = new Map<number, number>([[1, 0]]);
	const trace: Map<number, number>[] = [];
	let work = 0;
	for (let d = 0; d <= a.length + b.length; d++) {
		// 限住轨迹的内存和计算量；超出时由调用方换成整块替换。
		if (d * d > 250_000 || work > 1_000_000) return null;
		trace.push(new Map(frontier));
		for (let k = -d; k <= d; k += 2) {
			const left = frontier.get(k - 1) ?? -1;
			const down = frontier.get(k + 1) ?? -1;
			let x = k === -d || (k !== d && left < down) ? down : left + 1;
			let y = x - k;
			while (x < a.length && y < b.length && a[x] === b[y]) {
				x++;
				y++;
				work++;
			}
			frontier.set(k, x);
			work++;
			if (x >= a.length && y >= b.length) return backtrack(trace, a, b);
		}
	}
	return null;
}

function backtrack(trace: Map<number, number>[], a: string[], b: string[]): DiffLine[] {
	const out: DiffLine[] = [];
	let x = a.length;
	let y = b.length;
	for (let d = trace.length - 1; d >= 0; d--) {
		const frontier = trace[d] as Map<number, number>;
		const k = x - y;
		const previousK = k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1)) ? k + 1 : k - 1;
		const previousX = frontier.get(previousK) ?? 0;
		const previousY = previousX - previousK;
		while (x > previousX && y > previousY) {
			out.push({ type: "context", text: a[--x] as string });
			y--;
		}
		if (d === 0) break;
		if (x === previousX) out.push({ type: "add", text: b[--y] as string });
		else out.push({ type: "remove", text: a[--x] as string });
	}
	return out.reverse();
}

function groupHunks(ops: DiffLine[], contextLines: number): DiffHunk[] {
	const changed = ops.map((op, index) => (op.type === "context" ? -1 : index)).filter((i) => i !== -1);
	const first = changed[0];
	if (first === undefined) return [];
	const hunks: DiffHunk[] = [];
	let start = Math.max(0, first - contextLines);
	let end = Math.min(ops.length - 1, first + contextLines);
	for (const index of changed.slice(1)) {
		if (index - contextLines <= end + 1) {
			end = Math.min(ops.length - 1, index + contextLines);
			continue;
		}
		hunks.push(makeHunk(ops.slice(start, end + 1)));
		start = Math.max(0, index - contextLines);
		end = Math.min(ops.length - 1, index + contextLines);
	}
	hunks.push(makeHunk(ops.slice(start, end + 1)));
	return hunks;
}

function makeHunk(lines: DiffLine[]): DiffHunk {
	return {
		oldStart: lines.find((l) => l.oldLine !== undefined)?.oldLine ?? 1,
		newStart: lines.find((l) => l.newLine !== undefined)?.newLine ?? 1,
		lines,
	};
}
