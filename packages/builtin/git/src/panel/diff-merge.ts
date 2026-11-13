import type { ChangeHunk } from "@plume/contract";
import type { DiffFile } from "../api.ts";

/**
 * 列出来的文件，内容到了的填上。
 *
 * 一个提交的文件读两次：先是很快的列表，再是慢的 diff。列表决定布局，所以留下的是它——第二次的答案整个换上去，
 * 版面会再变一次。第二次的答案也不是超集：太大读不了的文件不在里面，以列表为准，那一行仍在，说没有可以按行比的内容。
 */
export function withContents(listed: DiffFile[], loaded: DiffFile[]): DiffFile[] {
	if (listed.length === 0) return loaded;
	const byPath = new Map(loaded.map((file) => [file.path, file]));
	return listed.map((file) => byPath.get(file.path) ?? file);
}

/** 重读的 diff 里没变的文件，沿用手上那份 hunk：展开着的文件不因一次刷新整个重画。 */
export function keepUnchangedHunks(held: DiffFile[], next: DiffFile[]): DiffFile[] {
	if (held.length === 0) return next;
	const byPath = new Map(held.map((file) => [file.path, file]));
	return next.map((file) => {
		const before = byPath.get(file.path);
		return before && before.hunks !== file.hunks && sameHunks(before.hunks, file.hunks) ? { ...file, hunks: before.hunks } : file;
	});
}

function sameHunks(a: ChangeHunk[], b: ChangeHunk[]): boolean {
	return (
		a.length === b.length &&
		a.every((hunk, index) => {
			const other = b[index];
			return (
				other !== undefined &&
				hunk.oldStart === other.oldStart &&
				hunk.newStart === other.newStart &&
				hunk.lines.length === other.lines.length &&
				hunk.lines.every((line, at) => {
					const twin = other.lines[at];
					return twin !== undefined && line.type === twin.type && line.text === twin.text && line.oldLine === twin.oldLine && line.newLine === twin.newLine;
				})
			);
		})
	);
}
