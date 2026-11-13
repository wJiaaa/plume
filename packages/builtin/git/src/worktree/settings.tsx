/**
 * 设置页里「工作树」那一节：工作树建在哪、建之前要不要获取、旧的要不要自动清，以及各项目上挂着的工作树。
 * 页头由宿主画。设置存在逻辑入口那边（插件数据目录），经 `ui.remote()` 读写。
 */

import { ActionSpinner, IconButton, Input, NumberField, SettingsCard, SettingsRow, SettingsSectionTitle, Text, Toggle, macKeyboard } from "@plume/ui";
import { FolderGit2, FolderOpen, RefreshCw, Trash2 } from "@plume/ui/icons";
import { field } from "@plume/styles";
import type { UiContext } from "@plume/contract/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ListedWorktree, SettingsView, WorktreeSettings } from "./api.ts";
import { notify, reasonOf, revealPath, useText, worktree } from "./remote.ts";

export function WorktreesSettings({ useProjects }: { useProjects: UiContext["useProjects"] }) {
	const text = useText();
	const projects = useProjects();
	const [view, setView] = useState<SettingsView | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [trees, setTrees] = useState<ListedWorktree[]>([]);
	const [refreshing, setRefreshing] = useState(false);
	const [deleting, setDeleting] = useState<string | null>(null);
	// 根目录边打边存：每个键都写一次盘不值得，停下来再存。
	const rootTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const load = useCallback(() => {
		worktree()
			.worktreeSettings()
			.then(
				(next) => {
					setView(next);
					setLoadError(null);
				},
				(error: unknown) => setLoadError(reasonOf(error)),
			);
	}, []);
	useEffect(load, [load]);
	useEffect(() => () => clearTimeout(rootTimer.current), []);

	const paths = projects.map((project) => project.path);
	const key = paths.join("\0");
	const refreshList = useCallback(async () => {
		setRefreshing(true);
		try {
			setTrees(await worktree().linkedWorktrees(key ? key.split("\0") : []));
		} catch (error) {
			notify(reasonOf(error), "error");
		} finally {
			setRefreshing(false);
		}
	}, [key]);
	useEffect(() => void refreshList(), [refreshList]);

	const update = (patch: Partial<WorktreeSettings>) => {
		if (!view) return;
		setView({ ...view, ...patch });
		worktree()
			.saveWorktreeSettings(patch)
			.then(undefined, (error: unknown) => {
				notify(text.saveFailed(reasonOf(error)), "error");
				load();
			});
	};

	const changeRoot = (rootDir: string) => {
		if (!view) return;
		setView({ ...view, rootDir });
		clearTimeout(rootTimer.current);
		rootTimer.current = setTimeout(() => update({ rootDir }), 400);
	};

	const remove = async (tree: ListedWorktree) => {
		if (deleting) return;
		setDeleting(tree.path);
		try {
			const result = await worktree().removeWorktree(tree.repo, tree.path);
			if (result.ok) {
				notify(text.removed);
				await refreshList();
			} else notify(result.error ?? text.removeFailed, "error");
		} catch (error) {
			notify(reasonOf(error) || text.removeFailed, "error");
		} finally {
			setDeleting(null);
		}
	};

	const reveal = (path: string) => revealPath(path).then(undefined, (error: unknown) => notify(text.revealFailed(reasonOf(error)), "error"));

	if (loadError) {
		return (
			<Text as="p" size="label" tone="danger">
				{text.loadFailed(loadError)}
			</Text>
		);
	}
	if (!view) return null;
	// 系统的文件管理器按这个平台的叫法：访达、资源管理器，别处统称文件管理器。
	const revealLabel = macKeyboard() ? text.reveal : /^Win/i.test(navigator.platform) ? text.revealExplorer : text.revealOther;

	return (
		<div data-worktree-settings="">
			<SettingsSectionTitle>{text.config}</SettingsSectionTitle>
			<SettingsCard className="worktree-card">
				<SettingsRow
					title={text.root}
					detail={text.rootDetail(view.defaultRoot)}
					control={
						<Input
							type="text"
							value={view.rootDir}
							placeholder={view.defaultRoot}
							spellCheck={false}
							aria-label={text.root}
							onChange={(event) => changeRoot(event.target.value)}
							className={`${field} worktree-root`}
						/>
					}
				/>
				<SettingsRow
					title={text.fetchFirst}
					detail={text.fetchFirstDetail}
					control={<Toggle checked={view.fetchFirst} ariaLabel={text.fetchFirst} onChange={(next) => update({ fetchFirst: next })} />}
				/>
				{/* 没开过就是关着，和逻辑入口读的一样：显示成开着，它却从没跑过。 */}
				<SettingsRow
					title={text.autoPrune}
					detail={text.autoPruneDetail}
					control={<Toggle checked={view.autoClean} ariaLabel={text.autoPrune} onChange={(next) => update({ autoClean: next })} />}
				/>
				<SettingsRow
					title={text.keepLimit}
					detail={text.keepLimitDetail}
					control={
						<NumberField
							value={view.keepLimit}
							min={1}
							max={100}
							label={text.keepLimit}
							name="keepLimit"
							width={80}
							onChange={(next) => update({ keepLimit: next })}
						/>
					}
				/>
			</SettingsCard>

			<div className="worktree-list-head">
				<SettingsSectionTitle>{text.active}</SettingsSectionTitle>
				<IconButton
					label={text.refresh}
					onClick={() => void refreshList()}
					disabled={refreshing}
					icon={refreshing ? <ActionSpinner size={12} /> : <RefreshCw size={12} aria-hidden />}
				/>
			</div>
			{trees.length === 0 ? (
				<div className="worktree-empty">
					<FolderGit2 size={24} className="worktree-empty-icon" />
					<Text size="label" tone="faint">
						{text.empty}
					</Text>
					<Text size="caption" tone="faint">
						{text.emptyDetail}
					</Text>
				</div>
			) : (
				<SettingsCard>
					{trees.map((tree) => (
						<div key={tree.path} data-worktree-row="" className="worktree-row">
							<div className="worktree-row-body">
								<div className="worktree-row-head">
									<Text size="label" weight="medium" className="worktree-row-label">
										{tree.label}
									</Text>
									{tree.branch && (
										<Text size="caption" tone="muted" mono className="worktree-row-branch">
											{tree.branch}
										</Text>
									)}
								</div>
								<Text as="div" size="caption" tone="faint" mono className="worktree-row-path">
									{tree.path}
								</Text>
							</div>
							<div className="worktree-row-actions">
								<IconButton label={revealLabel} onClick={() => void reveal(tree.path)} icon={<FolderOpen size={13} strokeWidth={1.8} />} />
								<IconButton tone="danger" label={text.delete} disabled={deleting === tree.path} onClick={() => void remove(tree)} icon={<Trash2 size={14} />} />
							</div>
						</div>
					))}
				</SettingsCard>
			)}
		</div>
	);
}
