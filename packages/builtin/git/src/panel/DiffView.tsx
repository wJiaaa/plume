import type { ChangeHunk, ChangeLine } from "@plume/contract";
import type { FileDiffLayout, FileDiffLineMark, FileDiffLineTarget } from "@plume/contract/ui";
import { useCallback } from "react";
import { useDiffCommenting } from "./DiffComments.tsx";
import { renderFileDiff } from "./host.ts";
import { useT } from "./i18n.ts";

export type DiffLayout = FileDiffLayout;

/**
 * 复用宿主的 `ui.FileDiff`（带按文件语言的语法高亮、行内变动强调、统一/分栏切换与自动换行），
 * 在改动视图里把行号交互接到 `DiffCommentsProvider`。
 */
export function DiffView({
	hunks,
	path,
	showPath = false,
	maxLines = 600,
	layout = "unified",
	wrap = false,
}: {
	hunks: ChangeHunk[];
	path?: string;
	showPath?: boolean;
	maxLines?: number;
	layout?: DiffLayout;
	wrap?: boolean;
}) {
	const t = useT();
	const commenting = useDiffCommenting();

	const lineMark = useCallback(
		(line: ChangeLine): FileDiffLineMark | null => {
			if (!commenting || !path) return null;
			const note = commenting.noteOf(path, line);
			if (!note) return null;
			return {
				...(note.last ? { badge: note.n } : {}),
				state: note.draft ? "draft" : "saved",
			};
		},
		[commenting, path],
	);

	const lineLabel = useCallback((lineNumber: number | string) => t("diffComment.pick", { line: lineNumber }), [t]);

	const onLinePress = useCallback(
		(target: FileDiffLineTarget, anchor: HTMLElement, extend: boolean) => {
			if (!commenting || !path) return;
			commenting.press({ path, hunk: target.hunk, lineIndex: target.lineIndex }, anchor, extend);
		},
		[commenting, path],
	);

	const onLineEnter = useCallback(
		(target: FileDiffLineTarget, anchor: HTMLElement) => {
			if (!commenting || !path) return;
			commenting.enter({ path, hunk: target.hunk, lineIndex: target.lineIndex }, anchor);
		},
		[commenting, path],
	);

	return renderFileDiff({
		hunks,
		path,
		showPath,
		maxLines,
		layout,
		wrap,
		lineMark: commenting && path ? lineMark : undefined,
		lineLabel: commenting && path ? lineLabel : undefined,
		onLinePress: commenting && path ? onLinePress : undefined,
		onLineEnter: commenting && path ? onLineEnter : undefined,
	});
}
