/**
 * 分支，以及任意两个分支之间的 diff。
 *
 * 比较是这一页存在的理由：「我的和 main 差在哪」是合并前要问的，在别处回答就得离开应用去开终端。
 */

import { Button, IconButton, Input, Scroller, SkeletonList, Text, useConfirmer, useSlowLoad } from "@plume/ui";
import { ArrowLeft, GitBranchPlus, X } from "@plume/ui/icons";
import { useCallback, useEffect, useState } from "react";
import type { BranchList, GitStatus, RefDiff, RepoRef } from "../api.ts";
import { FileDiffList } from "./FileDiffList.tsx";
import { useT } from "./i18n.ts";
import { git } from "./remote.ts";
import { BranchRow, CheckoutRow, GroupHeader } from "./rows.tsx";
import type { Act } from "./types.ts";

export function BranchesView({
	cwd,
	status,
	busy,
	act,
	repos,
	trees,
	onSelectRepo,
}: {
	cwd: string;
	status: GitStatus | null;
	busy: boolean;
	act: Act;
	repos: RepoRef[];
	trees: Record<string, RepoRef[]>;
	onSelectRepo: (path: string) => void;
}) {
	const t = useT();
	const [branches, setBranches] = useState<BranchList | null>(null);
	const slow = useSlowLoad(branches === null);
	const [revision, setRevision] = useState(0);
	const [compare, setCompare] = useState<{ base: string; head: string } | null>(null);
	const [diff, setDiff] = useState<RefDiff | null>(null);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const confirm = useConfirmer();
	const checkouts = repos.flatMap((repo) => [repo, ...(trees[repo.path] ?? [])]);

	const load = useCallback(() => setRevision((value) => value + 1), []);
	useEffect(() => {
		let live = true;
		git()
			.branches(cwd)
			.then((result) => live && setBranches(result))
			.catch(() => live && setBranches({ current: null, local: [], remote: [] }));
		return () => {
			live = false;
		};
	}, [cwd, revision, status?.branch]);

	useEffect(() => {
		setDiff(null);
		if (!compare) return;
		let live = true;
		git()
			.diffRefs(cwd, compare.base, compare.head)
			.then((result) => live && setDiff(result))
			.catch(() => live && setDiff({ files: [], added: 0, removed: 0 }));
		return () => {
			live = false;
		};
	}, [cwd, compare]);

	if (branches === null) return slow ? <SkeletonList count={5} label={t("branches.reading")} /> : null;
	const current = branches.current;
	// 切换菜单里滤掉了已有本地分支的远端分支，这里要把上游放回来：「我有什么远端没有」是最常比的一对。
	const remotes = status?.upstream && !branches.remote.includes(status.upstream) ? [status.upstream, ...branches.remote] : branches.remote;

	return (
		<Scroller className="git-fill" contentClassName="git-list-pad">
			{compare ? (
				<>
					<div className="git-compare-head">
						<Text size="label" tone="muted" className="git-truncate">
							<span className="git-ink">{compare.base}</span>
							<span className="git-arrow">→</span>
							<span className="git-ink">{compare.head}</span>
						</Text>
						<IconButton size="sm" icon={<ArrowLeft size={13} />} label={t("branches.back")} onClick={() => setCompare(null)} />
						{diff && (
							<Text size="caption" mono numeric className="git-push-right">
								<span className="git-ok">+{diff.added}</span> <span className="git-danger">−{diff.removed}</span>
							</Text>
						)}
					</div>
					<FileDiffList files={diff?.files ?? []} emptyLabel={diff ? t("branches.identical") : t("branches.comparing")} />
				</>
			) : (
				<>
					{/* 工作区里的每一份检出，排在分支前面：先知道在看哪个仓库，它的分支才有意义。 */}
					{checkouts.length > 1 && (
						<>
							<GroupHeader label={t("common.workspace")} count={checkouts.length} />
							{checkouts.map((entry) => (
								<CheckoutRow key={entry.path} entry={entry} cwd={cwd} onSelect={onSelectRepo} />
							))}
						</>
					)}

					<GroupHeader
						label={t("common.local")}
						count={branches.local.length}
						actions={
							<IconButton
								label={creating ? t("branches.cancelNew") : t("branches.new")}
								icon={creating ? <X size={13} strokeWidth={1.9} /> : <GitBranchPlus size={13} strokeWidth={1.9} />}
								size="sm"
								disabled={busy}
								onClick={() => {
									setCreating(!creating);
									setName("");
								}}
							/>
						}
					/>

					{creating && (
						<form
							className="git-new-branch"
							onSubmit={(event) => {
								event.preventDefault();
								void act(() => git().createBranch(cwd, name, null)).then((ok) => {
									if (!ok) return;
									setCreating(false);
									setName("");
									load();
								});
							}}
						>
							{/* 字号跟着这一行的细节档走：`plume-field` 自带的是控件档，紧凑字段里显得大。 */}
							<Text size="detail" className="git-grow">
								<Input
									autoFocus
									value={name}
									onChange={(event) => setName(event.target.value)}
									placeholder={t("branches.namePlaceholder")}
									data-plume-field=""
									className="plume-field git-field-compact git-branch-field"
								/>
							</Text>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								label={t("branches.createAndSwitch")}
								disabled={busy || !name.trim()}
								icon={<GitBranchPlus size={14} />}
							/>
						</form>
					)}

					{branches.local.map((branch) => (
						<BranchRow
							key={branch}
							name={branch}
							current={branch === current}
							busy={busy}
							onSwitch={() => void act(() => git().switchBranch(cwd, branch))}
							onCompare={current && branch !== current ? () => setCompare({ base: branch, head: current }) : undefined}
							onDelete={
								branch === current
									? undefined
									: () =>
											confirm.ask({
												title: t("branches.deleteConfirm", { branch }),
												detail: t("branches.deleteDetail"),
												confirmLabel: t("common.delete"),
												onConfirm: () => void act(() => git().deleteBranch(cwd, branch, false)).then(load),
											})
							}
						/>
					))}

					{remotes.length > 0 && <GroupHeader label={t("common.remote")} count={remotes.length} />}
					{remotes.map((branch) => (
						<BranchRow
							key={branch}
							name={branch}
							current={false}
							busy={busy}
							remote
							onSwitch={() => void act(() => git().switchBranch(cwd, branch))}
							onCompare={current ? () => setCompare({ base: branch, head: current }) : undefined}
						/>
					))}
				</>
			)}
			{confirm.element}
		</Scroller>
	);
}
