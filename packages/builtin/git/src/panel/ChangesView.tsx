/**
 * 暂存区，从上往下读的一列。
 */

import { IconButton, PanelEmpty, Scroller, Segmented, SkeletonList, Text, useConfirmer, useNarrow } from "@plume/ui";
import { Check, ChevronsDownUp, ChevronsUpDown, Columns2, FileSearch, FolderTree, List, Minus, Plus, RotateCcw, Rows3, WrapText } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiffFile, GitStatus, GitStatusFile } from "../api.ts";
import { DiffCommentsProvider } from "./DiffComments.tsx";
import type { DiffLayout } from "./DiffView.tsx";
import { keepUnchangedHunks } from "./diff-merge.ts";
import { FileDiffList } from "./FileDiffList.tsx";
import { FileDiffTree } from "./FileDiffTree.tsx";
import { DiffStat } from "./file-row.tsx";
import { previewFile } from "./host.ts";
import { useT } from "./i18n.ts";
import { baseName, git } from "./remote.ts";
import { GroupHeader } from "./rows.tsx";
import type { SyncPlan } from "./sync-plan.ts";
import type { Act } from "./types.ts";

/** 平铺还是树、分栏还是统一、自动换行：记的是这个人习惯怎么读改动，关掉面板、换会话、重启都留着。 */
const TREE_VIEW_KEY = "plume.git.changes.tree";
const DIFF_LAYOUT_KEY = "plume.git.changes.layout";
const WRAP_LINES_KEY = "plume.git.changes.wrap";

function useBoolPreference(key: string): [boolean, (next: (previous: boolean) => boolean) => void] {
	const [value, setValue] = useState(() => localStorage.getItem(key) === "1");
	useEffect(() => {
		localStorage.setItem(key, value ? "1" : "0");
	}, [key, value]);
	return [value, setValue];
}

function useLayoutPreference(): [DiffLayout, (next: DiffLayout) => void] {
	const [layout, setLayout] = useState<DiffLayout>(() => (localStorage.getItem(DIFF_LAYOUT_KEY) === "split" ? "split" : "unified"));
	useEffect(() => {
		localStorage.setItem(DIFF_LAYOUT_KEY, layout);
	}, [layout]);
	return [layout, setLayout];
}

function sumStats(files: readonly DiffFile[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const file of files) {
		added += file.added;
		removed += file.removed;
	}
	return { added, removed };
}

/**
 * 已暂存在上，未暂存在下：上面一组是下一次提交会有的，下面是不会有的。往下读就是在读你要做的那次提交。
 * 顶上固定一条 diff 工具栏（呼应 T3 Code 的 DiffPanel 顶栏）：滚动长 diff 时全部展开/折叠、统一/分栏切换、换行和树切换始终触手可及。
 */
export function ChangesView({
	status,
	cwd,
	busy,
	loading,
	act,
	plan,
	sessionId,
}: {
	status: GitStatus | null;
	cwd: string;
	busy: boolean;
	loading?: boolean;
	act: Act;
	plan: SyncPlan;
	sessionId?: string;
}) {
	const t = useT();
	const [treeView, setTreeView] = useBoolPreference(TREE_VIEW_KEY);
	const [diffLayout, setDiffLayout] = useLayoutPreference();
	const [wrapLines, setWrapLines] = useBoolPreference(WRAP_LINES_KEY);
	const [narrowSplit, hostRef] = useNarrow(540);
	const effectiveLayout: DiffLayout = narrowSplit ? "unified" : diffLayout;

	const [openStaged, setOpenStaged] = useState<Set<string>>(() => new Set());
	const [openUnstaged, setOpenUnstaged] = useState<Set<string>>(() => new Set());

	const toggleStaged = useCallback((path: string) => {
		setOpenStaged((current) => {
			const next = new Set(current);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	}, []);

	const toggleUnstaged = useCallback((path: string) => {
		setOpenUnstaged((current) => {
			const next = new Set(current);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	}, []);

	const confirm = useConfirmer();
	const askDiscard = (path: string) =>
		confirm.ask({
			title: t("changes.discardConfirm", { name: baseName(path) }),
			detail: t("changes.discardDetail"),
			confirmLabel: t("common.discard"),
			onConfirm: () => void act(() => git().discard(cwd, [path])),
		});
	/** 行不等 hunk，hunk 到了再填进去，见 `rowsFor`。 */
	const [hunks, setHunks] = useState<{ staged: DiffFile[]; unstaged: DiffFile[] }>({ staged: [], unstaged: [] });

	/*
	 * 两份 diff，对着两组：已暂存是暂存区对 HEAD，未暂存是工作区对暂存区，和 git 自己的切法一样。
	 * `status` 在没变的轮询之间要是同一个对象（`sameStatus`），否则这里每 1.5 秒重跑一次。
	 */
	useEffect(() => {
		let live = true;
		void Promise.all([git().diffRefs(cwd, "HEAD", null), git().workspaceDiff(cwd, "index")])
			.then(([indexDiff, treeDiff]) => {
				if (!live) return;
				setHunks((held) => ({ staged: keepUnchangedHunks(held.staged, indexDiff.files), unstaged: keepUnchangedHunks(held.unstaged, treeDiff.files) }));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [cwd, status]);

	const stagedPaths = status?.staged.map((file) => file.path) ?? [];
	const unstagedPaths = status?.unstaged.map((file) => file.path) ?? [];
	const totalFiles = stagedPaths.length + unstagedPaths.length;
	const nothing = totalFiles === 0;
	const stagedRows = useMemo(() => rowsFor(status?.staged ?? [], hunks.staged), [status?.staged, hunks.staged]);
	const unstagedRows = useMemo(() => rowsFor(status?.unstaged ?? [], hunks.unstaged), [status?.unstaged, hunks.unstaged]);
	const stagedStat = useMemo(() => sumStats(stagedRows), [stagedRows]);
	const unstagedStat = useMemo(() => sumStats(unstagedRows), [unstagedRows]);
	const totalStat = useMemo(
		() => ({ added: stagedStat.added + unstagedStat.added, removed: stagedStat.removed + unstagedStat.removed }),
		[stagedStat, unstagedStat],
	);

	const anyExpanded = stagedRows.some((file) => openStaged.has(file.path)) || unstagedRows.some((file) => openUnstaged.has(file.path));
	const toggleAllFiles = () => {
		if (anyExpanded) {
			setOpenStaged(new Set());
			setOpenUnstaged(new Set());
			return;
		}
		setOpenStaged(new Set(stagedRows.map((file) => file.path)));
		setOpenUnstaged(new Set(unstagedRows.map((file) => file.path)));
	};

	// 切换检出时先占住要来的东西的形状：这时「工作区干净」是一个错的答案。
	if (loading) {
		return (
			<div className="git-enter git-skeleton-pad">
				<SkeletonList count={5} label={t("changes.reading")} />
			</div>
		);
	}

	// 干净之后还剩什么，看分支和远端的关系；这句话和同步那一行出自同一张表，两边不会说得不一样。
	if (nothing) {
		return (
			<PanelEmpty icon={Check} title={t("changes.clean")}>
				{plan.empty.body}
			</PanelEmpty>
		);
	}

	const Files = treeView ? FileDiffTree : FileDiffList;
	const preview = (file: DiffFile) =>
		sessionId && file.status !== "deleted" && !file.path.endsWith("/") ? (
			<IconButton
				icon={<FileSearch size={12} strokeWidth={1.9} />}
				label={t("changes.previewWorking")}
				size="sm"
				data-git-preview={file.path}
				onClick={() => void previewFile(`${cwd}/${file.path}`, sessionId)}
			/>
		) : null;
	const unstage = (file: DiffFile) => (
		<>
			{preview(file)}
			<IconButton
				icon={<Minus size={12} strokeWidth={1.9} />}
				label={t("changes.unstage")}
				size="sm"
				disabled={busy}
				onClick={() => void act(() => git().unstage(cwd, [file.path]))}
			/>
		</>
	);
	const stageOrDiscard = (file: DiffFile) => (
		<>
			{preview(file)}
			<IconButton
				icon={<RotateCcw size={12} strokeWidth={1.9} />}
				label={t("common.discard")}
				size="sm"
				tone="danger"
				disabled={busy}
				onClick={() => askDiscard(file.path)}
			/>
			<IconButton
				icon={<Plus size={12} strokeWidth={1.9} />}
				label={t("changes.stage")}
				size="sm"
				disabled={busy}
				onClick={() => void act(() => git().stage(cwd, [file.path]))}
			/>
		</>
	);

	return (
		<DiffCommentsProvider cwd={cwd} sessionId={sessionId}>
			<div ref={hostRef} className="git-changes-host">
				<div className="git-changes-bar">
					<Text size="caption" tone="muted" numeric className="git-changes-summary">
						{t("changes.fileCount", { n: totalFiles })}
					</Text>
					<DiffStat added={totalStat.added} removed={totalStat.removed} inline />
					<div className="git-changes-controls">
						<IconButton
							label={anyExpanded ? t("changes.collapseAll") : t("changes.expandAll")}
							icon={anyExpanded ? <ChevronsDownUp size={13} strokeWidth={1.9} /> : <ChevronsUpDown size={13} strokeWidth={1.9} />}
							size="sm"
							onClick={toggleAllFiles}
						/>
						{!narrowSplit && (
							<Segmented
								compact
								ariaLabel={t("changes.diffLayout")}
								value={diffLayout}
								onChange={setDiffLayout}
								options={[
									{ value: "unified", label: t("changes.unifiedView"), icon: <Rows3 size={12.5} strokeWidth={1.9} /> },
									{ value: "split", label: t("changes.splitView"), icon: <Columns2 size={12.5} strokeWidth={1.9} /> },
								]}
							/>
						)}
						<IconButton
							label={wrapLines ? t("changes.unwrapLines") : t("changes.wrapLines")}
							icon={<WrapText size={13} strokeWidth={1.9} />}
							size="sm"
							active={wrapLines}
							onClick={() => setWrapLines((v) => !v)}
						/>
						<IconButton
							label={treeView ? t("changes.flatView") : t("changes.treeView")}
							icon={treeView ? <List size={13} strokeWidth={1.9} /> : <FolderTree size={13} strokeWidth={1.9} />}
							size="sm"
							active={treeView}
							onClick={() => setTreeView((v) => !v)}
						/>
					</div>
				</div>

				<Scroller className="git-enter git-fill" contentClassName="git-changes-list" top="fade" bottom="fade">
					{stagedPaths.length > 0 && (
						<section className="git-section">
							<GroupHeader
								surface="bar"
								label={t("changes.staged")}
								count={stagedPaths.length}
								stat={stagedStat}
								actions={
									<IconButton
										label={t("changes.unstageAll")}
										icon={<Minus size={13} strokeWidth={1.9} />}
										size="sm"
										disabled={busy}
										onClick={() => void act(() => git().unstage(cwd, stagedPaths))}
									/>
								}
							/>
							<Files
								cwd={cwd}
								files={stagedRows}
								actions={unstage}
								openPaths={openStaged}
								onTogglePath={toggleStaged}
								diffLayout={effectiveLayout}
								wrapLines={wrapLines}
							/>
						</section>
					)}

					{unstagedPaths.length > 0 && (
						<section className="git-section">
							<GroupHeader
								surface="bar"
								label={t("changes.unstaged")}
								count={unstagedPaths.length}
								stat={unstagedStat}
								actions={
									<IconButton
										label={t("changes.stageAll")}
										icon={<Plus size={13} strokeWidth={1.9} />}
										size="sm"
										disabled={busy}
										onClick={() => void act(() => git().stage(cwd, unstagedPaths))}
									/>
								}
							/>
							<Files
								cwd={cwd}
								files={unstagedRows}
								actions={stageOrDiscard}
								openPaths={openUnstaged}
								onTogglePath={toggleUnstaged}
								diffLayout={effectiveLayout}
								wrapLines={wrapLines}
							/>
						</section>
					)}
				</Scroller>
			</div>
			{confirm.element}
		</DiffCommentsProvider>
	);
}

/**
 * git 报的每个文件一行，hunk 到了就带上。
 *
 * 哪些文件在组里、各自怎么了、几行，以 `status` 为准——标题的数就是从它数的；diff 只提供展开以后看的内容。
 * 行数也用 `status` 的，不让加载进来的 hunk 换成另一种比法或更旧的快照。
 */
function rowsFor(files: GitStatusFile[], diffed: DiffFile[]): DiffFile[] {
	const known = new Map(diffed.map((file) => [file.path, file]));
	return files.map((file) => ({
		...known.get(file.path),
		path: file.path,
		status: file.status,
		added: file.added,
		removed: file.removed,
		hunks: known.get(file.path)?.hunks ?? [],
	}));
}
