import type { ChangeHunk } from "@plume/contract";
import { OverlayScrollbar, useI18n } from "@plume/ui";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Token } from "../../markdown/highlight.ts";
import { useDiffHighlight } from "./diff-highlight.ts";

/** 一屏代码约十几行。整段保留原文、行号和滚动尺寸，只给眼前的一两页铺配色片段。 */
const PAGE = 24;

/**
 * 统一 diff：左边一栏行号，加的行一条绿色竖条、删的行一条红色，代码在底下照语法上色。
 * 行铺在和最长那行一样宽的一层上，行号和竖条钉在左边，横滚时仍能看见。
 */
export const DiffView = memo(function DiffView({
	hunks,
	path,
	showPath = false,
	maxLines = 600,
}: {
	hunks: ChangeHunk[];
	path?: string;
	showPath?: boolean;
	maxLines?: number;
}) {
	const { t } = useI18n();
	const scroller = useRef<HTMLDivElement>(null);
	// 显示上限也约束解析：末尾根本不画的代码，不参与两边的语法分析。
	const shown = useMemo(() => {
		const visible: ChangeHunk[] = [];
		let remaining = maxLines;
		for (const hunk of hunks) {
			if (remaining <= 0) break;
			visible.push(hunk.lines.length <= remaining ? hunk : { ...hunk, lines: hunk.lines.slice(0, remaining) });
			remaining -= hunk.lines.length;
		}
		return { hunks: visible, paged: maxLines - remaining > PAGE, truncated: remaining < 0 || visible.length < hunks.length };
	}, [hunks, maxLines]);
	const [pages, setPages] = useState<ReadonlySet<number> | null>(null);
	// 等第一屏原文已排版、确实露出来才启动长段的整段解析，不让语法加载抢点击那一帧。
	const coloured = useDiffHighlight(shown.hunks, !shown.paged || pages !== null ? path : undefined);
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
	let offset = 0;
	return (
		<div className="plume-scroll-host relative">
			<div ref={scroller} className="tool-diff-scroll overflow-x-auto font-mono text-code">
				<div className="w-max min-w-full">
					{showPath && path && <div className="sticky left-0 w-max border-b border-line-soft px-3 py-1.5 text-caption text-ink-faint">{path}</div>}
					{shown.hunks.map((hunk, hunkIndex) => {
						const start = offset;
						offset += hunk.lines.length;
						return (
							<div key={hunkIndex} className="border-b border-line-soft last:border-b-0">
								{hunkIndex > 0 && (
									<div className="sticky left-0 w-max bg-shell/60 px-3 py-0.5 text-caption text-ink-faint">
										@@ -{hunk.oldStart} +{hunk.newStart} @@
									</div>
								)}
								{Array.from({ length: Math.ceil(hunk.lines.length / PAGE) }, (_, i) => {
									const first = i * PAGE;
									const page = start + first;
									return <DiffPage key={page} lines={hunk.lines} first={first} page={page} colours={!shown.paged || pages?.has(page) ? coloured : null} />;
								})}
							</div>
						);
					})}
					{shown.truncated && <div className="sticky left-0 w-max px-3 py-1.5 text-caption text-ink-faint">{t("diffView.truncated")}</div>}
				</div>
			</div>
			<OverlayScrollbar viewport={scroller} orientation="horizontal" placement="sticky" />
		</div>
	);
});

const DiffPage = memo(function DiffPage({
	lines,
	first,
	page,
	colours,
}: {
	lines: ChangeHunk["lines"];
	first: number;
	page: number;
	colours: Token[][] | null;
}) {
	return (
		<div data-diff-page={page}>
			{lines.slice(first, first + PAGE).map((line, i) => {
				const tokens = colours?.[page + i];
				const kind = line.type === "add" ? "tool-diff-add" : line.type === "remove" ? "tool-diff-remove" : "";
				return (
					<div key={i} className={`flex ${kind}`}>
						<span className="tool-diff-gutter sticky left-0 z-[1] w-[42px] shrink-0 pr-2 text-right select-none">{line.newLine ?? line.oldLine ?? ""}</span>
						<span className="tool-diff-rail sticky left-[42px] z-[1] w-[3px] shrink-0" />
						<span className="tool-diff-code shrink-0 px-2.5 whitespace-pre text-ink">
							{tokens?.length
								? tokens.map((token, j) => (
										<span key={j} className={token.className}>
											{token.text}
										</span>
									))
								: line.text || " "}
						</span>
					</div>
				);
			})}
		</div>
	);
});
