/**
 * 暂存区，从上往下读的一列。
 */

import { IconButton, PanelEmpty, Scroller, SkeletonList, useConfirmer } from "@plume/ui";
import { Check, FileSearch, FolderTree, List, Minus, Plus, RotateCcw } from "@plume/ui/icons";
import { useEffect, useState } from "react";
import type { DiffFile, GitStatus, GitStatusFile } from "../api.ts";
import { DiffCommentsProvider } from "./DiffComments.tsx";
import { keepUnchangedHunks } from "./diff-merge.ts";
import { FileDiffList } from "./FileDiffList.tsx";
import { FileDiffTree } from "./FileDiffTree.tsx";
import { useT } from "./i18n.ts";
import { previewFile } from "./host.ts";
import { baseName, git } from "./remote.ts";
import { GroupHeader } from "./rows.tsx";
import type { SyncPlan } from "./sync-plan.ts";
import type { Act } from "./types.ts";

/** 平铺还是树：记的是这个人习惯怎么读改动，不按仓库分，关掉面板、换会话、重启都留着。 */
const TREE_VIEW_KEY = "plume.git.changes.tree";

function useTreeViewPreference(): [boolean, (next: (previous: boolean) => boolean) => void] {
	const [treeView, setTreeView] = useState(() => localStorage.getItem(TREE_VIEW_KEY) === "1");
	useEffect(() => {
		localStorage.setItem(TREE_VIEW_KEY, treeView ? "1" : "0");
	}, [treeView]);
	return [treeView, setTreeView];
}

/**
 * 已暂存在上，未暂存在下：上面一组是下一次提交会有的，下面是不会有的。往下读就是在读你要做的那次提交。
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
	const [treeView, setTreeView] = useTreeViewPreference();
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
	const nothing = stagedPaths.length === 0 && unstagedPaths.length === 0;
	const stagedRows = rowsFor(status?.staged ?? [], hunks.staged);
	const unstagedRows = rowsFor(status?.unstaged ?? [], hunks.unstaged);

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

	const treeToggle = (
		<IconButton
			label={treeView ? t("changes.flatView") : t("changes.treeView")}
			icon={treeView ? <List size={13} strokeWidth={1.9} /> : <FolderTree size={13} strokeWidth={1.9} />}
			size="sm"
			onClick={() => setTreeView((v) => !v)}
		/>
	);
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
			<Scroller className="git-enter git-fill" contentClassName="git-list-pad-wide" top="fade" bottom="fade">
				{stagedPaths.length > 0 && (
					<>
						<GroupHeader
							label={t("changes.staged")}
							count={stagedPaths.length}
							actions={
								<>
									{treeToggle}
									<IconButton
										label={t("changes.unstageAll")}
										icon={<Minus size={13} strokeWidth={1.9} />}
										size="sm"
										disabled={busy}
										onClick={() => void act(() => git().unstage(cwd, stagedPaths))}
									/>
								</>
							}
						/>
						<Files cwd={cwd} files={stagedRows} actions={unstage} />
					</>
				)}

				{unstagedPaths.length > 0 && (
					<>
						<GroupHeader
							label={t("changes.unstaged")}
							count={unstagedPaths.length}
							actions={
								<>
									{stagedPaths.length === 0 && treeToggle}
									<IconButton
										label={t("changes.stageAll")}
										icon={<Plus size={13} strokeWidth={1.9} />}
										size="sm"
										disabled={busy}
										onClick={() => void act(() => git().stage(cwd, unstagedPaths))}
									/>
								</>
							}
						/>
						<Files cwd={cwd} files={unstagedRows} actions={stageOrDiscard} />
					</>
				)}
			</Scroller>
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
