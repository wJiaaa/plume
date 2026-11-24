/**
 * 已归档的聊天：从侧栏收起来的会话，按项目折叠成一张张设置卡片。
 *
 * 组一开始是收着的：二十个项目的一页不该一下子把每段对话都摊开，点开一组是一下。搜索或选定具体项目时，匹配的组自动展开
 * （看不见的匹配不算匹配），但不写进人点出来的那份展开记录：清掉筛选，各组回到原来的样子。
 */

import type { ProjectEntry, SessionSummary } from "@plume/contract";
import { Button, Caret, ChoiceMark, Collapse, IconButton, ScrollText, SearchField, TimeAgo, useConfirmer, useI18n } from "@plume/ui";
import { Archive, ArchiveRestore, CheckSquare, ChevronsDownUp, ChevronsUpDown, Folder, MessageSquare, Pin, Search, Trash2 } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { modelsAgent } from "../models/store.ts";
import { deleteSessionQuestion } from "../sidebar/delete-session.tsx";
import { notify } from "../toast/index.ts";
import { filterArchivedGroups, groupArchivedSessions, LOOSE_PROJECT_KEY, resolveProjectFilter, selectArchivedSessions } from "./archived.ts";
import { Card, InlineSelect, PageHeader } from "./controls.tsx";

export function ArchivedSettings({
	sessions,
	projects,
	onOpen,
	onError,
}: {
	sessions: readonly SessionSummary[];
	projects: readonly ProjectEntry[];
	onOpen: (sessionId: string) => void;
	onError: (error: unknown) => void;
}) {
	const { t, resolvedLocale } = useI18n();
	const [query, setQuery] = useState("");
	const [project, setProject] = useState("all");
	const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
	const [selecting, setSelecting] = useState(false);
	const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
	const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
	const [deletingAll, setDeletingAll] = useState(false);
	const [batchBusy, setBatchBusy] = useState<"unarchive" | "delete" | null>(null);
	const confirm = useConfirmer();

	const archived = useMemo(() => selectArchivedSessions(sessions), [sessions]);
	const looseName = t("projectList.recent");
	const options = useMemo(() => groupArchivedSessions(archived, projects, looseName), [archived, projects, looseName]);
	const activeProject = useMemo(() => resolveProjectFilter(project, options), [project, options]);
	const groups = useMemo(() => filterArchivedGroups(options, activeProject, query), [options, activeProject, query]);

	const searching = query.trim().length > 0;
	const hasFilters = searching || activeProject !== "all";
	const forcedOpen = hasFilters;
	const inSelect = selecting && archived.length > 0;

	const visibleIds = useMemo(() => groups.flatMap((group) => group.sessions.map((session) => session.id)), [groups]);
	const pickedVisible = useMemo(() => visibleIds.filter((id) => chosen.has(id)), [visibleIds, chosen]);
	const allVisiblePicked = visibleIds.length > 0 && pickedVisible.length === visibleIds.length;
	const allGroupsOpen = groups.length > 0 && groups.every((group) => opened.has(group.key));

	const stopSelecting = useCallback(() => {
		setSelecting(false);
		setChosen(new Set());
	}, []);

	// 选择模式下按 Esc 先退出选择，不直接关掉外层的设置浮层；有确认对话框叠在上面或搜索框里还有字时交给它们自己处理。
	useEffect(() => {
		if (!inSelect) return undefined;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (document.querySelectorAll("[data-plume-modal]").length > 1) return;
			if (event.target instanceof HTMLInputElement && event.target.value.length > 0) return;
			event.preventDefault();
			event.stopPropagation();
			stopSelecting();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [inSelect, stopSelecting]);

	const startSelecting = () => {
		setSelecting(true);
		setChosen(new Set());
		if (!forcedOpen && groups.length > 0 && groups.every((group) => !opened.has(group.key))) {
			setOpened(new Set(groups.map((group) => group.key)));
		}
	};

	const toggleChoice = (id: string) => {
		setChosen((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	};

	const toggleAllVisible = () => {
		setChosen((current) => {
			const next = new Set(current);
			if (allVisiblePicked) {
				for (const id of visibleIds) next.delete(id);
			} else {
				for (const id of visibleIds) next.add(id);
			}
			return next;
		});
	};

	const withPending = async (ids: readonly string[], work: () => Promise<void>) => {
		setPendingIds((current) => {
			const next = new Set(current);
			for (const id of ids) next.add(id);
			return next;
		});
		try {
			await work();
		} catch (error) {
			onError(error);
		} finally {
			setPendingIds((current) => {
				const next = new Set(current);
				for (const id of ids) next.delete(id);
				return next;
			});
		}
	};

	const restoreOne = (sessionId: string) => {
		if (pendingIds.has(sessionId) || deletingAll || batchBusy !== null) return;
		void withPending([sessionId], async () => {
			await modelsAgent().setSessionArchived(sessionId, false);
			notify(t("archived.restored"));
		});
	};

	const requestDeleteOne = (session: SessionSummary) => {
		if (pendingIds.has(session.id) || deletingAll || batchBusy !== null) return;
		void deleteSessionQuestion(session, sessions, resolvedLocale, (ids) => {
			void withPending(ids, () => deleteSessions(ids));
		})
			.then(confirm.ask)
			.catch(onError);
	};

	const deleteAll = () => {
		confirm.ask({
			title: t("archived.deleteAllConfirm", { n: archived.length }),
			detail: t("archived.deleteAllDetail"),
			confirmLabel: t("archived.deleteN", { n: archived.length }),
			onConfirm: () => {
				setDeletingAll(true);
				void Promise.resolve(modelsAgent().deleteArchivedSessions())
					.then(() => stopSelecting())
					.catch(onError)
					.finally(() => setDeletingAll(false));
			},
		});
	};

	const restorePicked = () => {
		if (pickedVisible.length === 0 || batchBusy !== null) return;
		const targets = [...pickedVisible];
		setBatchBusy("unarchive");
		void (async () => {
			let done = 0;
			try {
				for (const id of targets) {
					await modelsAgent().setSessionArchived(id, false);
					done += 1;
				}
				notify(t("archived.restoredMany", { n: done }));
				stopSelecting();
			} catch (error) {
				if (done > 0) notify(t("archived.restoredMany", { n: done }));
				onError(error);
			} finally {
				setBatchBusy(null);
			}
		})();
	};

	const requestDeletePicked = () => {
		if (pickedVisible.length === 0 || batchBusy !== null) return;
		const targets = [...pickedVisible];
		confirm.ask({
			title: t("archived.deleteSelectedConfirm", { n: targets.length }),
			detail: t("archived.deleteSelectedDetail"),
			confirmLabel: t("archived.deleteN", { n: targets.length }),
			onConfirm: () => {
				setBatchBusy("delete");
				void (async () => {
					let done = 0;
					try {
						for (const id of targets) {
							await modelsAgent().deleteSession(id);
							done += 1;
						}
						notify(t("archived.deletedMany", { n: done }));
						stopSelecting();
					} catch (error) {
						if (done > 0) notify(t("archived.deletedMany", { n: done }));
						onError(error);
					} finally {
						setBatchBusy(null);
					}
				})();
			},
		});
	};

	const toggleAllGroups = () => {
		if (allGroupsOpen) {
			setOpened((current) => {
				const next = new Set(current);
				for (const group of groups) next.delete(group.key);
				return next;
			});
		} else {
			setOpened((current) => {
				const next = new Set(current);
				for (const group of groups) next.add(group.key);
				return next;
			});
		}
	};

	const clearFilters = () => {
		setQuery("");
		setProject("all");
	};

	return (
		<>
			<PageHeader
				title={t("archived.title")}
				intro={t("archived.intro")}
				actions={
					archived.length > 0 && !inSelect ? (
						<>
							{archived.length > 1 && (
								<Button
									variant="subtle"
									size="sm"
									onClick={startSelecting}
									disabled={deletingAll}
									icon={<CheckSquare size={13} strokeWidth={1.8} aria-hidden />}
									data-plume-archive-select=""
								>
									{t("archived.select")}
								</Button>
							)}
							<Button
								variant="danger"
								size="sm"
								loading={deletingAll}
								onClick={deleteAll}
								label={t("archived.deleteAll", { n: archived.length })}
								icon={<Trash2 size={13} strokeWidth={1.9} aria-hidden />}
								data-plume-delete-all-archived=""
							>
								{t("archived.deleteAllAction")}
							</Button>
						</>
					) : undefined
				}
			/>

			{archived.length === 0 ? (
				<div className="flex flex-col items-center rounded-panel border border-line-soft bg-card/50 px-6 py-14 text-center">
					<span className="grid size-11 place-items-center rounded-xl border border-line-soft bg-card text-ink-faint" aria-hidden>
						<Archive size={20} strokeWidth={1.6} />
					</span>
					<p className="mt-3.5 text-label font-medium text-ink">{t("archived.empty")}</p>
					<p className="mt-1 max-w-sm text-caption leading-relaxed text-ink-muted">{t("archived.emptyDetail")}</p>
				</div>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-2 pb-4">
						<SearchField size="comfortable" value={query} onChange={setQuery} placeholder={t("archived.search")} className="min-w-[180px] flex-1" />
						{options.length > 1 && (
							<InlineSelect
								value={activeProject}
								onChange={setProject}
								ariaLabel={t("common.allProjects")}
								options={[
									{ value: "all", label: t("common.allProjects") },
									...options.map((group) => ({ value: group.key, label: t("archived.projectCount", { name: group.name, count: group.sessions.length }) })),
								]}
							/>
						)}
						{!forcedOpen && groups.length > 1 && (
							<Button
								variant="subtle"
								size="sm"
								onClick={toggleAllGroups}
								icon={allGroupsOpen ? <ChevronsDownUp size={13} strokeWidth={1.8} aria-hidden /> : <ChevronsUpDown size={13} strokeWidth={1.8} aria-hidden />}
								data-plume-archive-toggle-all=""
							>
								{allGroupsOpen ? t("archived.collapseAll") : t("archived.expandAll")}
							</Button>
						)}
					</div>

					{inSelect && (
						<Card data-plume-archive-batch="" className="mb-4 flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
							<div className="flex items-center gap-2">
								<span className="text-label font-medium text-ink tabular-nums">{t("archived.selectedCount", { n: pickedVisible.length })}</span>
								{visibleIds.length > 0 && (
									<Button variant="subtle" size="sm" onClick={toggleAllVisible} disabled={batchBusy !== null} data-plume-archive-select-all="">
										{allVisiblePicked ? t("common.deselectAll") : t("common.selectAll")}
									</Button>
								)}
							</div>
							<div className="flex flex-wrap items-center gap-1.5">
								<Button
									variant="ghost"
									size="sm"
									disabled={pickedVisible.length === 0 || batchBusy === "delete"}
									loading={batchBusy === "unarchive"}
									onClick={restorePicked}
									icon={<ArchiveRestore size={13} strokeWidth={1.9} aria-hidden />}
									data-plume-archive-unarchive-selected=""
								>
									{t("archived.unarchiveN", { n: pickedVisible.length })}
								</Button>
								<Button
									variant="danger"
									size="sm"
									disabled={pickedVisible.length === 0 || batchBusy === "unarchive"}
									loading={batchBusy === "delete"}
									onClick={requestDeletePicked}
									icon={<Trash2 size={13} strokeWidth={1.9} aria-hidden />}
									data-plume-archive-delete-selected=""
								>
									{t("archived.deleteN", { n: pickedVisible.length })}
								</Button>
								<Button variant="subtle" size="sm" disabled={batchBusy !== null} onClick={stopSelecting} data-plume-archive-select-done="">
									{t("common.done")}
								</Button>
							</div>
						</Card>
					)}

					{groups.length === 0 ? (
						<div className="flex flex-col items-center rounded-panel border border-line-soft bg-card/50 px-6 py-12 text-center">
							<Search size={18} strokeWidth={1.7} className="text-ink-faint" aria-hidden />
							<p className="mt-2.5 text-label text-ink-muted">{t("archived.noMatch")}</p>
							{hasFilters && (
								<Button variant="ghost" size="sm" onClick={clearFilters} className="mt-3" data-plume-archive-clear-filters="">
									{t("archived.clearFilters")}
								</Button>
							)}
						</div>
					) : (
						<div className="space-y-3">
							{groups.map((group) => {
								const open = forcedOpen || opened.has(group.key);
								const selectedInGroup = inSelect ? group.sessions.filter((session) => chosen.has(session.id)).length : 0;
								return (
									<section key={group.key} className="plume-settings-card" data-plume-archive-group={group.key} data-open={open ? "true" : "false"}>
										<button
											type="button"
											aria-expanded={open}
											aria-label={t("archived.toggleGroup", { name: group.name, n: group.sessions.length })}
											disabled={forcedOpen}
											onClick={() =>
												setOpened((current) => {
													const next = new Set(current);
													if (!next.delete(group.key)) next.add(group.key);
													return next;
												})
											}
											className="plume-scroll flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-card-hover active:bg-elevated disabled:cursor-default disabled:hover:bg-transparent disabled:active:bg-transparent"
										>
											<Caret open={open} from="right" size={12} className="shrink-0 text-ink-faint" />
											{group.key === LOOSE_PROJECT_KEY ? (
												<MessageSquare size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" aria-hidden />
											) : (
												<Folder size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" aria-hidden />
											)}
											<ScrollText text={group.name} className="min-w-0 flex-1 text-label font-medium text-ink" />
											<span className="shrink-0 text-caption text-ink-muted tabular-nums">
												{selectedInGroup > 0
													? t("archived.groupSelected", { selected: selectedInGroup, total: group.sessions.length })
													: t("archived.chatCount", { n: group.sessions.length })}
											</span>
										</button>
										<Collapse open={open}>
											<div>
												{group.sessions.map((session) => (
													<ArchivedRow
														key={session.id}
														session={session}
														busy={deletingAll || batchBusy !== null || pendingIds.has(session.id)}
														selection={inSelect ? { checked: chosen.has(session.id), onToggle: () => toggleChoice(session.id) } : undefined}
														onOpen={() => onOpen(session.id)}
														onRestore={() => restoreOne(session.id)}
														onDelete={() => requestDeleteOne(session)}
													/>
												))}
											</div>
										</Collapse>
									</section>
								);
							})}
						</div>
					)}
				</>
			)}

			{confirm.element}
		</>
	);
}

function ArchivedRow({
	session,
	busy,
	selection,
	onOpen,
	onRestore,
	onDelete,
}: {
	session: SessionSummary;
	busy: boolean;
	selection?: { checked: boolean; onToggle: () => void };
	onOpen: () => void;
	onRestore: () => void;
	onDelete: () => void;
}) {
	const { t } = useI18n();
	const title = session.title || t("sessionOps.newSession");
	const updatedIso = new Date(session.updatedAt).toISOString();

	return (
		<div
			data-plume-archive-row={session.id}
			data-settings-item=""
			className={`plume-scroll group/row @container flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-soft px-4 py-3 transition-colors @md:flex-nowrap ${
				selection?.checked ? "bg-card-hover" : "hover:bg-card-hover"
			}`}
		>
			<button
				type="button"
				onClick={selection ? selection.onToggle : onOpen}
				className="flex min-w-0 flex-1 items-center gap-3 text-left"
				data-plume-tip={selection ? undefined : t("common.open")}
				{...(selection ? { role: "checkbox", "aria-checked": selection.checked } : {})}
			>
				{selection && <ChoiceMark kind="checkbox" checked={selection.checked} />}
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-1.5">
						<ScrollText text={title} className="min-w-0 text-label font-medium text-ink" />
						{session.pinned && (
							<span className="inline-flex shrink-0 text-ink-faint" data-plume-tip={t("archived.pinnedTip")}>
								<Pin size={12} strokeWidth={1.9} aria-label={t("archived.pinnedTip")} />
							</span>
						)}
					</div>
					<span className="mt-0.5 block truncate text-caption text-ink-faint tabular-nums">
						<TimeAgo iso={updatedIso} />
						{t("archived.messageCount", { n: session.messageCount ?? 0 })}
					</span>
				</div>
			</button>
			{!selection && (
				<div className="flex shrink-0 items-center gap-1.5">
					<Button variant="ghost" size="sm" loading={busy} onClick={onRestore} icon={<ArchiveRestore size={13} strokeWidth={1.9} aria-hidden />}>
						{t("common.unarchive")}
					</Button>
					<IconButton
						tone="danger"
						disabled={busy}
						label={t("archived.deleteNamed", { title })}
						icon={<Trash2 size={14} strokeWidth={1.8} />}
						onClick={onDelete}
					/>
				</div>
			)}
		</div>
	);
}

/** 一个一个删，按给的顺序：后续会话排在来源前面。 */
async function deleteSessions(sessionIds: readonly string[]): Promise<void> {
	for (const id of sessionIds) await modelsAgent().deleteSession(id);
}
