import type { ChangeHunk, ChangeLine } from "@plume/contract";
import type { FileDiffLineMark, FileDiffLineTarget, FileDiffProps } from "@plume/contract/ui";
import { MarkNumber, useI18n } from "@plume/ui";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { Token } from "../../markdown/highlight.ts";
import { useDiffHighlight } from "./diff-highlight.ts";
import { computeUnifiedInlineDiffs, isSingleSidedDiff, mergeInlineTokens, pairSplitHunk, type InlinePart, type SplitCell } from "./diff-layout.ts";

/** 一屏代码约十几行。整段保留原文、行号和滚动尺寸，只给眼前的一两页铺配色片段。 */
const PAGE = 24;

function hunkCounts(hunk: ChangeHunk): { oldCount: number; newCount: number } {
	let oldCount = 0;
	let newCount = 0;
	for (const line of hunk.lines) {
		if (line.type !== "add") oldCount += 1;
		if (line.type !== "remove") newCount += 1;
	}
	return { oldCount, newCount };
}

function formatHunkHeader(hunk: ChangeHunk): string {
	const { oldCount, newCount } = hunkCounts(hunk);
	return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`;
}

function renderCode(text: string, tokens: Token[] | undefined, parts: InlinePart[] | undefined, type: ChangeLine["type"]) {
	const markClass = type === "add" ? "tool-diff-inline-add" : "tool-diff-inline-remove";
	if (tokens?.length && parts?.length) {
		const runs = mergeInlineTokens(tokens, parts);
		return runs.map((run, index) => {
			const nodes = run.tokens.map((token, j) => (
				<span key={j} className={token.className}>
					{token.text}
				</span>
			));
			return run.changed ? (
				<mark key={index} className={markClass}>
					{nodes}
				</mark>
			) : (
				<Fragment key={index}>{nodes}</Fragment>
			);
		});
	}
	if (tokens?.length) {
		return tokens.map((token, j) => (
			<span key={j} className={token.className}>
				{token.text}
			</span>
		));
	}
	if (parts?.length) {
		return parts.map((part, index) =>
			part.changed ? (
				<mark key={index} className={markClass}>
					{part.text}
				</mark>
			) : (
				<Fragment key={index}>{part.text}</Fragment>
			),
		);
	}
	return text || " ";
}

/**
 * 统一 / 分栏 diff：最左缘是增删色条，紧挨着行号栏，代码按文件语法着色并叠成对改动的行内强调。
 *
 * - 纯新增或纯删除文件在分栏模式下自动退回通栏单列，不留半边空白、不无故挤出横滚条；
 * - 真实双侧改动在分栏不换行时拆成左右两个独立横滚窗格，长行不再把对侧推出视野；
 * - 统一模式不换行时行铺在和最长那行一样宽的一层上，左缘色条和行号钉在左侧，横滚时仍能看见。
 * - 横向不画滚动条（同 t3code）：触控板、Shift+滚轮照样横滚；滑块压在最后一行上、或在底下多留一条，读 diff 时都只是干扰。
 */
export const DiffView = memo(function DiffView({
	hunks,
	path,
	showPath = false,
	maxLines = 600,
	layout = "unified",
	wrap = false,
	lineMark,
	lineLabel,
	onLinePress,
	onLineEnter,
}: FileDiffProps) {
	const { t } = useI18n();
	const scroller = useRef<HTMLDivElement>(null);
	// 显示上限也约束解析：末尾根本不画的代码，不参与两边的语法分析。
	// 同时保留原始 `source` 引用，行号回调拿到的 `hunk` 和调用方传入的是同一个对象。
	const shown = useMemo(() => {
		const entries: { source: ChangeHunk; view: ChangeHunk }[] = [];
		let remaining = maxLines;
		let truncated = false;
		for (const hunk of hunks) {
			if (remaining <= 0) {
				truncated = true;
				break;
			}
			const take = Math.min(hunk.lines.length, remaining);
			if (take < hunk.lines.length) truncated = true;
			const view = take === hunk.lines.length ? hunk : { ...hunk, lines: hunk.lines.slice(0, take) };
			entries.push({ source: hunk, view });
			remaining -= take;
		}
		const views = entries.map((entry) => entry.view);
		const effectiveLayout = layout === "split" && !isSingleSidedDiff(views) ? "split" : "unified";
		return { entries, views, effectiveLayout, paged: effectiveLayout === "unified" && maxLines - remaining > PAGE, truncated };
	}, [hunks, maxLines, layout]);
	const [pages, setPages] = useState<ReadonlySet<number> | null>(null);
	// 等第一屏原文已排版、确实露出来才启动长段的整段解析，不让语法加载抢点击那一帧。
	const coloured = useDiffHighlight(shown.views, !shown.paged || pages !== null ? path : undefined);
	useEffect(() => {
		if (!shown.paged || !scroller.current) return;
		const observer = new IntersectionObserver((entries) => {
			setPages((previous) => {
				const next = new Set(previous);
				for (const entry of entries) {
					const page = Number((entry.target as HTMLElement).dataset.diffPage);
					if (entry.isIntersecting) next.add(page);
					else next.delete(page);
				}
				return !previous && next.size === 0 ? null : next;
			});
		});
		for (const page of scroller.current.querySelectorAll("[data-diff-page]")) observer.observe(page);
		return () => observer.disconnect();
	}, [shown]);

	const splitScrollPanes = shown.effectiveLayout === "split" && !wrap;
	const outerScrolls = !wrap && !splitScrollPanes;

	let offset = 0;
	return (
		<div data-diff-layout={shown.effectiveLayout}>
			<div
				ref={scroller}
				className={`tool-diff-scroll font-mono text-code ${wrap ? "tool-diff-wrap" : ""} ${outerScrolls ? "overflow-x-auto" : "overflow-x-hidden"}`}
			>
				<div className={`tool-diff-sheet ${outerScrolls ? "w-max min-w-full" : "w-full min-w-0"}`}>
					{showPath && path && <div className="sticky left-0 w-max border-b border-line-soft px-3 py-1.5 text-caption text-ink-faint">{path}</div>}
					{shown.entries.map(({ source, view }, hunkIndex) => {
						const start = offset;
						offset += view.lines.length;
						const showHeader = hunkIndex > 0 || view.oldStart > 1 || view.newStart > 1;
						return (
							<div key={hunkIndex} className="tool-diff-hunk">
								{showHeader && (
									<div className="tool-diff-hunk-head">
										<span className="tool-diff-hunk-label sticky left-0 px-3 py-0.5 text-caption text-ink-faint select-none">{formatHunkHeader(source)}</span>
									</div>
								)}
								{shown.effectiveLayout === "split" ? (
									<SplitHunk
										source={source}
										lines={view.lines}
										offset={start}
										wrap={wrap}
										colours={coloured}
										lineMark={lineMark}
										lineLabel={lineLabel}
										onLinePress={onLinePress}
										onLineEnter={onLineEnter}
									/>
								) : (
									<UnifiedHunk
										source={source}
										lines={view.lines}
										start={start}
										paged={shown.paged}
										pages={pages}
										colours={coloured}
										lineMark={lineMark}
										lineLabel={lineLabel}
										onLinePress={onLinePress}
										onLineEnter={onLineEnter}
									/>
								)}
							</div>
						);
					})}
					{shown.truncated && <div className="sticky left-0 w-max px-3 py-1.5 text-caption text-ink-faint">{t("diffView.truncated")}</div>}
				</div>
			</div>
		</div>
	);
});

const UnifiedHunk = memo(function UnifiedHunk({
	source,
	lines,
	start,
	paged,
	pages,
	colours,
	lineMark,
	lineLabel,
	onLinePress,
	onLineEnter,
}: {
	source: ChangeHunk;
	lines: readonly ChangeLine[];
	start: number;
	paged: boolean;
	pages: ReadonlySet<number> | null;
	colours: Token[][] | null;
	lineMark?: (line: ChangeLine) => FileDiffLineMark | null;
	lineLabel?: (lineNumber: number | string) => string;
	onLinePress?: (target: FileDiffLineTarget, anchor: HTMLElement, extend: boolean) => void;
	onLineEnter?: (target: FileDiffLineTarget, anchor: HTMLElement) => void;
}) {
	const inlineDiffs = useMemo(() => computeUnifiedInlineDiffs(lines), [lines]);
	return (
		<>
			{Array.from({ length: Math.ceil(lines.length / PAGE) }, (_, i) => {
				const first = i * PAGE;
				const page = start + first;
				return (
					<DiffPage
						key={page}
						source={source}
						lines={lines}
						first={first}
						page={page}
						colours={!paged || pages?.has(page) ? colours : null}
						inlineDiffs={inlineDiffs}
						lineMark={lineMark}
						lineLabel={lineLabel}
						onLinePress={onLinePress}
						onLineEnter={onLineEnter}
					/>
				);
			})}
		</>
	);
});

const DiffPage = memo(function DiffPage({
	source,
	lines,
	first,
	page,
	colours,
	inlineDiffs,
	lineMark,
	lineLabel,
	onLinePress,
	onLineEnter,
}: {
	source: ChangeHunk;
	lines: readonly ChangeLine[];
	first: number;
	page: number;
	colours: Token[][] | null;
	inlineDiffs: Map<number, InlinePart[]>;
	lineMark?: (line: ChangeLine) => FileDiffLineMark | null;
	lineLabel?: (lineNumber: number | string) => string;
	onLinePress?: (target: FileDiffLineTarget, anchor: HTMLElement, extend: boolean) => void;
	onLineEnter?: (target: FileDiffLineTarget, anchor: HTMLElement) => void;
}) {
	return (
		<div data-diff-page={page}>
			{lines.slice(first, first + PAGE).map((line, i) => {
				const lineIndex = first + i;
				const tokens = colours?.[page + i];
				const parts = inlineDiffs.get(lineIndex);
				const kind = line.type === "add" ? "tool-diff-add" : line.type === "remove" ? "tool-diff-remove" : "";
				const number = line.newLine ?? line.oldLine ?? "";
				const mark = lineMark?.(line) ?? null;
				return (
					<div key={i} className={`tool-diff-line flex ${kind}`}>
						<span className="tool-diff-rail sticky left-0 z-[1] w-[3px] shrink-0" />
						<DiffGutter
							className="tool-diff-gutter sticky left-[3px] z-[1] w-[46px] shrink-0 pr-3 pl-2 text-right select-none"
							number={number}
							mark={mark}
							source={source}
							lineIndex={lineIndex}
							lineLabel={lineLabel}
							onLinePress={onLinePress}
							onLineEnter={onLineEnter}
						/>
						<span className="tool-diff-code flex-1 pr-3.5 pl-2 whitespace-pre">{renderCode(line.text, tokens, parts, line.type)}</span>
					</div>
				);
			})}
		</div>
	);
});

const SplitHunk = memo(function SplitHunk({
	source,
	lines,
	offset,
	wrap,
	colours,
	lineMark,
	lineLabel,
	onLinePress,
	onLineEnter,
}: {
	source: ChangeHunk;
	lines: readonly ChangeLine[];
	offset: number;
	wrap: boolean;
	colours: Token[][] | null;
	lineMark?: (line: ChangeLine) => FileDiffLineMark | null;
	lineLabel?: (lineNumber: number | string) => string;
	onLinePress?: (target: FileDiffLineTarget, anchor: HTMLElement, extend: boolean) => void;
	onLineEnter?: (target: FileDiffLineTarget, anchor: HTMLElement) => void;
}) {
	const rows = useMemo(() => pairSplitHunk(lines), [lines]);

	if (wrap) {
		return (
			<div className="tool-diff-split">
				{rows.map((row, rowIndex) => (
					<div key={rowIndex} className="tool-diff-split-row">
						<SplitSideCell
							side="left"
							cell={row.left}
							source={source}
							offset={offset}
							colours={colours}
							lineMark={lineMark}
							lineLabel={lineLabel}
							onLinePress={onLinePress}
							onLineEnter={onLineEnter}
						/>
						<SplitSideCell
							side="right"
							cell={row.right}
							source={source}
							offset={offset}
							colours={colours}
							lineMark={lineMark}
							lineLabel={lineLabel}
							onLinePress={onLinePress}
							onLineEnter={onLineEnter}
						/>
					</div>
				))}
			</div>
		);
	}

	// 不换行时每行严格同高，左右各占 50% 独立横滚，长行互不挤压、且行与行严格对齐。
	return (
		<div className="tool-diff-split-panes">
			<div className="tool-diff-split-left min-w-0">
				<div className="tool-diff-split-pane overflow-x-auto">
					<div className="w-max min-w-full">
						{rows.map((row, rowIndex) => (
							<SplitPaneLine
								key={rowIndex}
								side="left"
								cell={row.left}
								source={source}
								offset={offset}
								colours={colours}
								lineMark={lineMark}
								lineLabel={lineLabel}
								onLinePress={onLinePress}
								onLineEnter={onLineEnter}
							/>
						))}
					</div>
				</div>
			</div>
			<div className="min-w-0">
				<div className="tool-diff-split-pane overflow-x-auto">
					<div className="w-max min-w-full">
						{rows.map((row, rowIndex) => (
							<SplitPaneLine
								key={rowIndex}
								side="right"
								cell={row.right}
								source={source}
								offset={offset}
								colours={colours}
								lineMark={lineMark}
								lineLabel={lineLabel}
								onLinePress={onLinePress}
								onLineEnter={onLineEnter}
							/>
						))}
					</div>
				</div>
			</div>
		</div>
	);
});

function SplitPaneLine({
	side,
	cell,
	source,
	offset,
	colours,
	lineMark,
	lineLabel,
	onLinePress,
	onLineEnter,
}: {
	side: "left" | "right";
	cell: SplitCell | null;
	source: ChangeHunk;
	offset: number;
	colours: Token[][] | null;
	lineMark?: (line: ChangeLine) => FileDiffLineMark | null;
	lineLabel?: (lineNumber: number | string) => string;
	onLinePress?: (target: FileDiffLineTarget, anchor: HTMLElement, extend: boolean) => void;
	onLineEnter?: (target: FileDiffLineTarget, anchor: HTMLElement) => void;
}) {
	if (!cell) {
		return (
			<div className="tool-diff-split-cell tool-diff-split-empty" aria-hidden>
				<span className="whitespace-pre">{"\u00A0"}</span>
			</div>
		);
	}
	const { line, lineIndex, parts } = cell;
	const tokens = colours?.[offset + lineIndex];
	const kind = line.type === "add" ? "tool-diff-add" : line.type === "remove" ? "tool-diff-remove" : "";
	const number = side === "left" ? (line.oldLine ?? "") : (line.newLine ?? "");
	const mark = lineMark?.(line) ?? null;
	return (
		<div className={`tool-diff-line tool-diff-split-cell ${kind}`.trim()}>
			<span className="tool-diff-split-rail sticky left-0 z-[1] w-[3px] shrink-0" />
			<DiffGutter
				className="tool-diff-split-gutter sticky left-[3px] z-[1] w-[44px] shrink-0 pr-2.5 pl-1.5 text-right select-none"
				number={number}
				mark={mark}
				source={source}
				lineIndex={lineIndex}
				lineLabel={lineLabel}
				onLinePress={onLinePress}
				onLineEnter={onLineEnter}
			/>
			<span className="tool-diff-code flex-1 pr-3 pl-1.5 whitespace-pre">{renderCode(line.text, tokens, parts, line.type)}</span>
		</div>
	);
}

function SplitSideCell({
	side,
	cell,
	source,
	offset,
	colours,
	lineMark,
	lineLabel,
	onLinePress,
	onLineEnter,
}: {
	side: "left" | "right";
	cell: SplitCell | null;
	source: ChangeHunk;
	offset: number;
	colours: Token[][] | null;
	lineMark?: (line: ChangeLine) => FileDiffLineMark | null;
	lineLabel?: (lineNumber: number | string) => string;
	onLinePress?: (target: FileDiffLineTarget, anchor: HTMLElement, extend: boolean) => void;
	onLineEnter?: (target: FileDiffLineTarget, anchor: HTMLElement) => void;
}) {
	if (!cell) {
		return <div className={`tool-diff-split-cell tool-diff-split-empty${side === "left" ? " tool-diff-split-left" : ""}`} aria-hidden />;
	}
	const { line, lineIndex, parts } = cell;
	const tokens = colours?.[offset + lineIndex];
	const kind = line.type === "add" ? "tool-diff-add" : line.type === "remove" ? "tool-diff-remove" : "";
	const number = side === "left" ? (line.oldLine ?? "") : (line.newLine ?? "");
	const mark = lineMark?.(line) ?? null;
	return (
		<div className={`tool-diff-line tool-diff-split-cell ${side === "left" ? "tool-diff-split-left" : ""} ${kind}`.trim()}>
			<span className="tool-diff-split-rail w-[3px] shrink-0" />
			<DiffGutter
				className="tool-diff-split-gutter w-[44px] shrink-0 pr-2.5 pl-1.5 text-right select-none"
				number={number}
				mark={mark}
				source={source}
				lineIndex={lineIndex}
				lineLabel={lineLabel}
				onLinePress={onLinePress}
				onLineEnter={onLineEnter}
			/>
			<span className="tool-diff-code flex-1 pr-3 pl-1.5 whitespace-pre">{renderCode(line.text, tokens, parts, line.type)}</span>
		</div>
	);
}

function DiffGutter({
	className,
	number,
	mark,
	source,
	lineIndex,
	lineLabel,
	onLinePress,
	onLineEnter,
}: {
	className: string;
	number: number | string;
	mark: FileDiffLineMark | null;
	source: ChangeHunk;
	lineIndex: number;
	lineLabel?: (lineNumber: number | string) => string;
	onLinePress?: (target: FileDiffLineTarget, anchor: HTMLElement, extend: boolean) => void;
	onLineEnter?: (target: FileDiffLineTarget, anchor: HTMLElement) => void;
}) {
	const content = mark?.badge !== undefined ? <MarkNumber n={mark.badge} className="align-middle" /> : number;
	if (!onLinePress) {
		return (
			<span className={className} data-diff-note={mark?.state}>
				{content}
			</span>
		);
	}
	return (
		<button
			type="button"
			tabIndex={-1}
			aria-label={lineLabel?.(number)}
			data-diff-pick=""
			data-diff-note={mark?.state}
			className={`${className} tool-diff-pick`}
			onMouseDown={(event) => {
				if (event.button !== 0) return;
				// 在行号上拖或 Shift 点是在挑行，不拦的话旁边的代码也会被选上。
				event.preventDefault();
				onLinePress({ hunk: source, lineIndex }, event.currentTarget, event.shiftKey);
			}}
			onMouseEnter={(event) => onLineEnter?.({ hunk: source, lineIndex }, event.currentTarget)}
		>
			{content}
		</button>
	);
}
