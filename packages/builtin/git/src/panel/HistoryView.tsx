/**
 * 已经发生的事，旁边画着图。
 */

import { PanelEmpty, relativeTime, Scroller, ScrollText, SkeletonBar, SkeletonList, Text, useSlowLoad } from "@plume/ui";
import { GitCommitHorizontal } from "@plume/ui/icons";
import { useEffect, useMemo, useState } from "react";
import type { DiffFile, GitCommit } from "../api.ts";
import { CommitGraph, CommitThroughGraph, LANE_WIDTH } from "./CommitGraph.tsx";
import { withContents } from "./diff-merge.ts";
import { FileDiffList } from "./FileDiffList.tsx";
import { buildGraph, graphWidths } from "./graph.ts";
import { useT } from "./i18n.ts";
import { git } from "./remote.ts";

/** 固定的：图要靠它让各行的线对上。 */
const ROW_HEIGHT = 46;

/** 读多久才值得画占位：在这之前什么都不说、答案到了直接画，比画一个高度不对的占位再改过来顺。 */
const SLOW_ENOUGH_MS = 120;

/** 展开的那个提交和目前知道的一切。和 sha 绑在一起：一帧要么是这个提交的状态，要么什么都没有。 */
interface Expansion {
	sha: string;
	files: DiffFile[];
	/** 文件列表还没到，没东西可排。 */
	listing: boolean;
	/** 列表到了，后面的 diff 还在读。 */
	reading: boolean;
	slow: boolean;
}

export function HistoryView({ cwd }: { cwd: string }) {
	const t = useT();
	const [commits, setCommits] = useState<GitCommit[] | null>(null);
	const [expansion, setExpansion] = useState<Expansion | null>(null);

	useEffect(() => {
		let live = true;
		void git()
			.log(cwd, 80, null)
			.then(
				(list) => live && setCommits(list),
				() => live && setCommits([]),
			);
		return () => {
			live = false;
		};
	}, [cwd]);

	/*
	 * 先要文件列表，再要 diff。
	 *
	 * 一起要的话，大提交的 diff 要半秒，块先按占位的高度排、停半秒、再一下子跳到几千像素。文件列表几十毫秒就回来，
	 * 而它决定了布局：行一开始就是最终的高度，内容随后在底下填上，什么都不动。
	 */
	const openSha = expansion?.sha ?? null;
	useEffect(() => {
		if (!openSha) return;
		let live = true;
		let contentArrived = false;
		const update = (change: (current: Expansion) => Expansion) => setExpansion((current) => (current && current.sha === openSha ? change(current) : current));
		const announce = setTimeout(() => {
			if (live) update((current) => ({ ...current, slow: true }));
		}, SLOW_ENOUGH_MS);

		git()
			.commitDiffSummary(cwd, openSha)
			.then((summary) => {
				// 小提交的 diff 可能先到，列表不能盖掉它。
				if (!live || contentArrived) return;
				update((current) => ({ ...current, files: summary.files, listing: false }));
			})
			.catch(() => {});

		git()
			.commitDiff(cwd, openSha)
			.then((result) => {
				if (!live) return;
				contentArrived = true;
				update((current) => ({ ...current, files: withContents(current.files, result.files), listing: false, reading: false }));
			})
			.catch(() => {
				if (live) update((current) => ({ ...current, listing: false, reading: false }));
			});

		return () => {
			live = false;
			clearTimeout(announce);
		};
	}, [cwd, openSha]);

	const rows = useMemo(() => buildGraph(commits ?? []), [commits]);
	const widths = useMemo(() => graphWidths(rows, LANE_WIDTH), [rows]);

	const slow = useSlowLoad(commits === null);
	if (commits === null) return slow ? <SkeletonList count={5} label={t("history.reading")} /> : null;
	if (commits.length === 0) {
		return (
			<PanelEmpty icon={GitCommitHorizontal} title={t("history.noCommits")}>
				{t("history.afterCommit")}
			</PanelEmpty>
		);
	}

	return (
		<Scroller className="git-fill" contentClassName="git-list-pad">
			{rows.map((row, index) => {
				const commit = row.commit;
				const state = expansion && expansion.sha === commit.sha ? expansion : null;
				const expanded = state !== null;
				const width = widths[index] ?? LANE_WIDTH;
				return (
					<div key={commit.sha}>
						<div className="git-stretch">
							<CommitGraph row={row} height={ROW_HEIGHT} width={width} />
							<button
								type="button"
								onClick={() => setExpansion(expanded ? null : { sha: commit.sha, files: [], listing: true, reading: true, slow: false })}
								aria-expanded={expanded}
								style={{ height: ROW_HEIGHT }}
								className="plume-scroll git-commit-row"
							>
								<span className="git-grow">
									{/* 悬停时滚动而不是截断：提交标题有用的那一半经常在省略号后面。 */}
									<Text size="label" className="git-block">
										<ScrollText text={commit.subject} className="plume-fade-tail" />
									</Text>
									<span className="git-row-6">
										<Text size="caption" tone="faint" mono>
											{commit.shortSha}
										</Text>
										<Text size="caption" tone="faint" className="git-truncate">
											{commit.author} · {relativeTime(commit.date)}
										</Text>
									</span>
								</span>
								{/* 标签比标题先让：`origin/fix/很长的名字` 比半个面板还宽，不让就把整行推出面板。 */}
								{commit.refs.length > 0 && (
									<span className="git-commit-refs">
										{commit.refs.slice(0, 2).map((ref) => (
											<Text key={ref} size="caption" tone="muted" title={ref} className="git-commit-ref">
												{ref}
											</Text>
										))}
									</span>
								)}
							</button>
						</div>
						{/* 展开块底下的空隙是文字那边的内边距，不是行的外边距：外边距在图那一栏撑开的盒子外面，线会断六个像素。 */}
						{state && (state.slow || !state.listing) && (
							<div className="git-enter git-stretch">
								<CommitThroughGraph row={row} width={width} />
								<div className="git-commit-body">
									{state.listing ? (
										<div className="git-commit-skeleton" aria-hidden>
											{["65%", "82%", "48%"].map((bar) => (
												<div key={bar} className="git-row-8">
													<SkeletonBar width="12px" height={12} className="git-skeleton-mark" />
													<SkeletonBar width={bar} height={10} />
												</div>
											))}
										</div>
									) : (
										<FileDiffList files={state.files} loadingContent={state.reading} emptyLabel={t("history.noFiles")} />
									)}
								</div>
							</div>
						)}
					</div>
				);
			})}
		</Scroller>
	);
}
