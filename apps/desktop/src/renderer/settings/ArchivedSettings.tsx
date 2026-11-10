/**
 * 已归档的聊天：从侧栏收起来的会话，按项目分组。
 *
 * 组一开始是收着的：二十个项目的一页不该一下子把每段对话都摊开，点开一组是一下。搜索时有匹配的组全部展开（看不见的匹配
 * 不算匹配），但不写进人点出来的那份展开记录：清掉搜索，各组回到原来的样子。
 */

import type { ProjectEntry, SessionSummary } from "@plume/contract";
import {
	Caret,
	Collapse,
	DialogAction,
	hourStyle,
	IconButton,
	type ResolvedUiLocale,
	ScrollText,
	SearchField,
	translate,
	useConfirmer,
	useI18n,
} from "@plume/ui";
import { Archive, Folder, Trash2 } from "@plume/ui/icons";
import { useMemo, useState } from "react";
import { modelsAgent } from "../models/store.ts";
import { deleteSessionQuestion } from "../sidebar/delete-session.tsx";
import { Card, InlineSelect, PageHeader } from "./controls.tsx";

/** 不属于任何项目（或项目已经移除）的会话归在这一组，和侧栏的「聊天」一样。 */
const LOOSE = "";

interface Group {
	key: string;
	name: string;
	sessions: SessionSummary[];
}

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
	const { t } = useI18n();
	const [query, setQuery] = useState("");
	const [project, setProject] = useState("all");
	const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
	const confirm = useConfirmer();
	const searching = query.trim().length > 0;

	const archived = useMemo(() => sessions.filter((session) => session.archived && !session.parentId && !session.owner), [sessions]);

	// 按会话记的项目 id 分组，和侧栏一样：同一个文件夹可以登记成几个项目。
	const filedUnder = useMemo(() => {
		const names = new Map(projects.map((entry) => [entry.id, entry.name]));
		return (session: SessionSummary) => {
			const name = session.project ? names.get(session.project) : undefined;
			return name !== undefined && session.project ? { key: session.project, name } : { key: LOOSE, name: translate("projectList.recent") };
		};
	}, [projects]);

	const groupOf = (list: readonly SessionSummary[]): Group[] => {
		const byKey = new Map<string, Group>();
		for (const session of list) {
			const where = filedUnder(session);
			const entry = byKey.get(where.key) ?? { ...where, sessions: [] };
			entry.sessions.push(session);
			byKey.set(where.key, entry);
		}
		return [...byKey.values()]
			.map((group) => ({ ...group, sessions: group.sessions.sort((a, b) => b.updatedAt - a.updatedAt) }))
			.sort((a, b) => b.sessions.length - a.sessions.length);
	};

	// oxlint-disable-next-line react-hooks/exhaustive-deps -- groupOf 每次渲染新建，只经 filedUnder 变
	const options = useMemo(() => groupOf(archived), [archived, filedUnder]);
	const groups = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return groupOf(
			archived.filter((session) => (project === "all" || filedUnder(session).key === project) && (!needle || session.title.toLowerCase().includes(needle))),
		);
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 同上
	}, [archived, query, project, filedUnder]);

	const act = (work: PromiseLike<unknown>) => void Promise.resolve(work).catch(onError);

	return (
		<>
			<PageHeader
				title={t("archived.title")}
				intro={t("archived.intro")}
				actions={
					archived.length > 0 && (
						<DialogAction
							tone="danger"
							onClick={() =>
								confirm.ask({
									title: t("archived.deleteAllConfirm", { n: archived.length }),
									detail: t("archived.deleteAllDetail"),
									confirmLabel: t("archived.deleteN", { n: archived.length }),
									onConfirm: () => act(modelsAgent().deleteArchivedSessions()),
								})
							}
							label={t("archived.deleteAll", { n: archived.length })}
							data-plume-delete-all-archived=""
						>
							<Trash2 size={13} strokeWidth={2} aria-hidden />
							{t("archived.deleteAllAction")}
						</DialogAction>
					)
				}
			/>

			{archived.length === 0 ? (
				<div className="flex flex-col items-center rounded-panel border border-dashed border-line py-14">
					<Archive size={26} strokeWidth={1.5} className="text-ink-faint" />
					<p className="mt-3 text-label text-ink-muted">{t("archived.empty")}</p>
					<p className="mt-1 text-detail text-ink-faint">{t("archived.emptyDetail")}</p>
				</div>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-2 pb-5">
						<SearchField size="comfortable" value={query} onChange={setQuery} placeholder={t("archived.search")} className="min-w-[180px] flex-1" />
						<InlineSelect
							value={project}
							onChange={setProject}
							ariaLabel={t("common.allProjects")}
							options={[
								{ value: "all", label: t("common.allProjects") },
								...options.map((group) => ({ value: group.key, label: t("archived.projectCount", { name: group.name, count: group.sessions.length }) })),
							]}
						/>
					</div>

					{groups.length === 0 && <p className="py-10 text-center text-label text-ink-faint">{t("archived.noMatch")}</p>}

					{groups.map((group) => {
						const open = searching || opened.has(group.key);
						return (
							<section key={group.key} className="mb-6" data-plume-archive-group={group.key} data-open={open ? "true" : "false"}>
								<button
									type="button"
									aria-expanded={open}
									aria-label={t("archived.toggleGroup", { name: group.name, n: group.sessions.length })}
									disabled={searching}
									onClick={() =>
										setOpened((current) => {
											const next = new Set(current);
											if (!next.delete(group.key)) next.add(group.key);
											return next;
										})
									}
									className="flex w-full items-center gap-2 pb-2 text-left disabled:cursor-default"
								>
									<Caret open={open} from="right" size={12} className="text-ink-faint" />
									<Folder size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
									<ScrollText text={group.name} className="min-w-0 text-label text-ink" />
									<span className="shrink-0 text-detail text-ink-faint">{t("archived.chatCount", { n: group.sessions.length })}</span>
								</button>
								<Collapse open={open}>
									<Card>
										{group.sessions.map((session, index) => (
											<ArchivedRow
												key={session.id}
												session={session}
												sessions={sessions}
												first={index === 0}
												onOpen={() => onOpen(session.id)}
												onRestore={() => act(modelsAgent().setSessionArchived(session.id, false))}
												onDelete={(ids) => act(deleteSessions(ids))}
											/>
										))}
									</Card>
								</Collapse>
							</section>
						);
					})}
				</>
			)}

			{confirm.element}
		</>
	);
}

function ArchivedRow({
	session,
	sessions,
	first,
	onOpen,
	onRestore,
	onDelete,
}: {
	session: SessionSummary;
	sessions: readonly SessionSummary[];
	first: boolean;
	onOpen: () => void;
	onRestore: () => void;
	onDelete: (sessionIds: string[]) => void;
}) {
	const { t, resolvedLocale } = useI18n();
	const confirm = useConfirmer();
	const title = session.title || t("sessionOps.newSession");
	return (
		<div
			data-plume-archive-row={session.id}
			className={`group/row flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-card-hover ${first ? "" : "border-t border-line-soft"}`}
		>
			<button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left" data-plume-tip={t("common.open")}>
				<ScrollText text={title} className="text-label text-ink" />
				<span className="mt-0.5 block text-detail text-ink-faint">
					{formatDate(session.updatedAt, resolvedLocale)}
					{t("archived.messageCount", { n: session.messageCount ?? 0 })}
				</span>
			</button>
			<div className="flex shrink-0 items-center gap-2">
				<IconButton
					tone="danger"
					label={t("archived.deleteNamed", { title })}
					icon={<Trash2 size={14} strokeWidth={1.8} />}
					onClick={() => void deleteSessionQuestion(session, sessions, resolvedLocale, onDelete).then(confirm.ask)}
				/>
				<DialogAction onClick={onRestore}>{t("common.unarchive")}</DialogAction>
			</div>
			{confirm.element}
		</div>
	);
}

/** 一个一个删，按给的顺序：后续会话排在来源前面。 */
async function deleteSessions(sessionIds: readonly string[]): Promise<void> {
	for (const id of sessionIds) await modelsAgent().deleteSession(id);
}

function formatDate(ts: number, locale: ResolvedUiLocale): string {
	return new Date(ts).toLocaleString(locale, { year: "numeric", month: "long", day: "numeric", hour: hourStyle(locale), minute: "2-digit" });
}
