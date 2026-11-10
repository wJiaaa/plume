/**
 * 侧栏的会话列表：最上是「置顶」，「项目」底下每个项目一组，「聊天」是不属于项目的会话。
 *
 * 分组规则在 `grouping.ts`；这里只管画，和折叠、「展开显示」这些只属于界面的状态。
 * 折叠了哪些记在 localStorage 里：理好的侧栏下次打开还是理好的。
 */

import type { ProjectEntry, SessionSummary } from "@plume/contract";
import { ActionSpinner, Collapse, HoverRow, HoverRowReveal, hoverSlot, IconButton, RollingText, ScrollText, useI18n, usePopover } from "@plume/ui";
import { ChevronDown, ChevronRight, ChevronUp, Folder, FolderOpen, ListFilter, MoreHorizontal, Plus, SquarePen } from "@plume/ui/icons";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type Group, groupSessions, nestSpawned, withSpawned, projectSessions, type SessionSort } from "./grouping.ts";
import { ListMenu } from "./ListMenu.tsx";
import { useHideEmptiedProjects } from "./prefs.ts";
import { ProjectDialog, ProjectMenu } from "./ProjectDialog.tsx";
import { SessionRows } from "./SessionRows.tsx";
import { ProjectCard } from "./ProjectCard.tsx";
import { useSessionCard } from "./SessionCard.tsx";
import { SidebarReorderContext, useSidebarReorderContext, useReorderState } from "./reorder-context.ts";
import { useSidebarReorder } from "./useSidebarReorder.ts";
import { CarriedPill, DropLineIndicator } from "./DropIndicator.tsx";
import type { SidebarActions } from "./actions.ts";

const COLLAPSED_KEY = "plume.sidebar.collapsed";
/** 项目里的会话怎么排：是偏好，记下来，下次打开还是这样排。 */
const SORT_KEY = "plume.sidebar.sort";
/**
 * 三个分区的折叠键。项目的键是它的 id（UUID），不会以 `§` 开头，两种键放在一处不会撞。
 */
const PINNED = "§pinned";
const PROJECTS = "§projects";
const RECENT = "§recent";
/**
 * 一个项目先露几段会话，「展开显示」每次再多露几段。两个数一样：一次全部展开的话，四十段的项目一下变成一堵墙，
 * 而回去只有一个「收起」，读到哪儿全丢了；一次五段，可以一步步走、随时停。
 */
const SESSION_PAGE = 5;

function readCollapsed(): string[] {
	try {
		const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
		return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
	} catch {
		return [];
	}
}

function readSort(): SessionSort {
	try {
		const value = localStorage.getItem(SORT_KEY);
		return value === "manual" || value === "updatedAt" ? value : "createdAt";
	} catch {
		return "createdAt";
	}
}

export function ProjectList({
	sessions,
	projects,
	lit,
	compact,
	actions,
}: {
	sessions: SessionSummary[];
	projects: ProjectEntry[];
	/** 读作「开着」的会话：当前会话和开在独立窗口里的。 */
	lit: ReadonlySet<string>;
	compact: boolean;
	actions: SidebarActions;
}) {
	const { t } = useI18n();
	const [collapsed, setCollapsed] = useState(readCollapsed);
	/** 每个项目现在露几段，没有就是 SESSION_PAGE。不落盘：下次打开从头看起。 */
	const [shown, setShown] = useState<Record<string, number>>({});
	const [creating, setCreating] = useState(false);
	const [sort, setSort] = useState(readSort);
	const listMenu = usePopover();
	const hideEmptied = useHideEmptiedProjects();
	const groups = useMemo(() => nestSpawned(groupSessions(sessions, projects, hideEmptied, sort)), [sessions, projects, hideEmptied, sort]);
	const reorder = useSidebarReorder(groups, sort, actions, () => setSort("manual"));
	/** 有子会话在跑的会话。 */
	const busyParents = useMemo(() => new Set(sessions.flatMap((session) => (session.parentId && session.running ? [session.parentId] : []))), [sessions]);

	// 在提交之后写，不在 setState 的更新函数里写：更新函数可能被调用不止一次，写进去的未必是留下来的那一份。
	useEffect(() => {
		try {
			localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
			localStorage.setItem(SORT_KEY, sort);
		} catch {
			// 存不下只是下次不记得，这一次的折叠和排序照样生效。
		}
	}, [collapsed, sort]);

	const isCollapsed = (key: string) => collapsed.includes(key);
	const toggle = (key: string) => setCollapsed((current) => (current.includes(key) ? current.filter((each) => each !== key) : [...current, key]));
	const expand = (key: string) => setCollapsed((current) => current.filter((each) => each !== key));
	const foldable = groups.projects.map((group) => group.id);
	const allFolded = foldable.length > 0 && foldable.every((key) => collapsed.includes(key));
	const foldAll = (folded: boolean) =>
		setCollapsed((current) => (folded ? [...new Set([...current, ...foldable])] : current.filter((key) => !foldable.includes(key))));
	const gap = compact ? "gap-[5px]" : "gap-[2px]";

	return (
		<SidebarReorderContext value={reorder.contextValue}>
			{reorder.dragging && <CarriedPill item={reorder.dragging} />}
			{creating && <ProjectDialog actions={actions} onClose={() => setCreating(false)} />}
			{listMenu.open && (
				<ListMenu
					anchor={listMenu.anchor}
					sort={sort}
					onSort={setSort}
					canFold={foldable.length > 0}
					allFolded={allFolded}
					onFoldAll={foldAll}
					onClose={listMenu.close}
				/>
			)}
			{groups.pinned.length > 0 && (
				<>
					<SectionLabel
						first
						section="pinned"
						sessions={withSpawned(groups.pinned, groups.spawned)}
						count={withSpawned(groups.pinned, groups.spawned).length}
						collapsed={isCollapsed(PINNED)}
						onToggle={() => toggle(PINNED)}
					>
						{t("projectList.pinned")}
					</SectionLabel>
					<Collapse open={!isCollapsed(PINNED)}>
						<div className={`flex flex-col ${gap}`}>
							<SessionRows
								sessions={groups.pinned}
								spawned={groups.spawned}
								busyParents={busyParents}
								lit={lit}
								compact={compact}
								projects={projects}
								actions={actions}
							/>
						</div>
					</Collapse>
				</>
			)}
			{/* 空列表也保留入口，创建第一个项目不必离开侧栏。 */}
			<SectionLabel
				first={groups.pinned.length === 0}
				section="projects"
				sessions={groups.projects.flatMap((group) => withSpawned(group.sessions, groups.spawned))}
				count={groups.projects.length}
				collapsed={isCollapsed(PROJECTS)}
				onToggle={() => toggle(PROJECTS)}
				action={
					<>
						<IconButton
							size="sm"
							label={t("sidebar.listSettings")}
							menu={listMenu.open}
							onClick={listMenu.toggle}
							icon={<ListFilter size={13} strokeWidth={2} aria-hidden />}
						/>
						<IconButton size="sm" label={t("project.new")} onClick={() => setCreating(true)} icon={<Plus size={13} strokeWidth={2} aria-hidden />} />
					</>
				}
			>
				{t("projectList.projects")}
			</SectionLabel>
			<Collapse open={!isCollapsed(PROJECTS)}>
				{groups.projects.map((group) => (
					<ProjectGroup
						key={group.id}
						group={group}
						spawned={groups.spawned}
						live={projectSessions(sessions, group.id).length}
						busyParents={busyParents}
						projects={projects}
						lit={lit}
						compact={compact}
						actions={actions}
						collapsed={isCollapsed(group.id)}
						onToggleCollapsed={() => toggle(group.id)}
						onExpand={() => expand(group.id)}
						shown={shown[group.id] ?? SESSION_PAGE}
						onShowMore={() => setShown((current) => ({ ...current, [group.id]: (current[group.id] ?? SESSION_PAGE) + SESSION_PAGE }))}
						onCollapse={() => setShown((current) => ({ ...current, [group.id]: SESSION_PAGE }))}
					/>
				))}
			</Collapse>

			{groups.loose.length > 0 && (
				<div className="pt-4">
					<SectionLabel
						first
						held
						section="recent"
						sessions={withSpawned(groups.loose, groups.spawned)}
						count={withSpawned(groups.loose, groups.spawned).length}
						collapsed={isCollapsed(RECENT)}
						onToggle={() => toggle(RECENT)}
						action={
							<IconButton
								size="sm"
								label={t("projectList.newLooseChat")}
								onClick={() => actions.newSession({})}
								icon={<Plus size={13} strokeWidth={2} aria-hidden />}
							/>
						}
					>
						{t("projectList.recent")}
					</SectionLabel>
					{/* 和项目里一样的行、一样的间距，读起来是一张列表；不分页，整段只从标题折叠。 */}
					<Collapse open={!isCollapsed(RECENT)}>
						<div className={`flex flex-col ${gap}`}>
							<SessionRows
								sessions={groups.loose}
								spawned={groups.spawned}
								busyParents={busyParents}
								lit={lit}
								compact={compact}
								projects={projects}
								actions={actions}
							/>
						</div>
					</Collapse>
				</div>
			)}

			{groups.pinned.length === 0 && groups.projects.length === 0 && groups.loose.length === 0 && (
				<p className="px-2 py-6 text-center text-detail leading-relaxed text-ink-faint">
					{t("sidebar.noSessions")}
					<br />
					{t("sidebar.newChatHint")}
				</p>
			)}
		</SidebarReorderContext>
	);
}

/**
 * 分区标题，本身就是折叠这一区的按钮：项目能一个个折，一区不能折的话，长长的「聊天」只能滚过去。
 *
 * 数目只在折起来时显示：展开时行本身就是数目，折起来时它区分的是「折起来了」和「是空的」。
 * 分区自己的按钮（新建项目、新对话）浮在数目那个位置上，悬停时出来，数目让开。
 */
function SectionLabel({
	children,
	first,
	held,
	section,
	count,
	sessions,
	collapsed,
	onToggle,
	action,
}: {
	children: ReactNode;
	/** 一段的第一个标题，不留上间距；分区之间的间距由外层给。 */
	first?: boolean;
	/**
	 * 在所在的那一块里吸顶，像项目名那样。只给「聊天」：它不分页，常是整栏最长的一段，项目名都滚走以后，没有别的东西说明这些是谁的会话。
	 * 「置顶」「项目」不吸顶：它们只是把列表分成几段，钉在顶上不多说什么，还会和项目名抢顶上那个位置。
	 */
	held?: boolean;
	section: "pinned" | "projects" | "recent";
	count: number;
	sessions: readonly SessionSummary[];
	collapsed: boolean;
	onToggle: () => void;
	action?: ReactNode;
}) {
	return (
		<div
			data-plume-head={held || undefined}
			className={`group/section flex w-full items-center ${held ? "sticky top-0 z-20" : "relative"} ${first ? "" : "pt-4"}`}
		>
			<button
				type="button"
				data-plume-section={section}
				aria-expanded={!collapsed}
				onClick={onToggle}
				className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-lg px-2 text-left text-detail font-medium text-ink-faint transition-colors hover:text-ink-muted"
			>
				{children}
				<ChevronRight
					size={12}
					strokeWidth={2.2}
					className={`shrink-0 opacity-0 transition-[opacity,transform] group-hover/section:opacity-100 ${collapsed ? "" : "rotate-90"}`}
				/>
				<span
					data-plume-section-count
					className={`ml-auto flex min-w-5 items-center justify-end tabular-nums transition-opacity ${
						action ? "group-hover/section:opacity-0 group-has-[:focus-visible]/section:opacity-0" : ""
					}`}
				>
					<GroupActivity sessions={sessions} collapsed={collapsed} count={count} />
				</span>
			</button>
			{action && (
				// `right-1.5 gap-0.5` 和项目行悬停按钮的位置一样，标题上的按钮和底下行里的按钮落在同一列。
				<span
					data-plume-section-action
					className="absolute right-1.5 bottom-0 flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-hover/section:opacity-100 group-has-[:focus-visible]/section:opacity-100"
				>
					{action}
				</span>
			)}
		</div>
	);
}

/** 折起来的一组在标题上说里面有多少；有在跑的就换成转圈，否则折起来以后侧栏上就没有东西在动了。 */
function GroupActivity({ sessions, collapsed, count }: { sessions: readonly SessionSummary[]; collapsed: boolean; count: number }) {
	const { t } = useI18n();
	if (!collapsed) return null;
	const running = sessions.filter((session) => session.running).length;
	if (running === 0) return count > 0 ? count : null;
	return (
		<span
			className="inline-flex size-3.5 items-center justify-center"
			data-plume-group-running={running}
			aria-label={t("groupActivity.running", { n: running })}
		>
			<ActionSpinner size={14} className="text-accent" />
		</span>
	);
}

/**
 * 一个项目和它底下的会话。行之间留缝：悬停和选中都是圆角底色，紧挨着的两行会连成一块，分不清哪段是哪段。
 */
function ProjectGroup({
	group,
	spawned,
	live,
	busyParents,
	projects,
	lit,
	compact,
	actions,
	collapsed,
	onToggleCollapsed,
	onExpand,
	shown,
	onShowMore,
	onCollapse,
}: {
	group: Group;
	spawned: Record<string, SessionSummary[]>;
	/** 项目里还列着的会话数（含置顶的），给菜单的「归档聊天」。 */
	live: number;
	busyParents: ReadonlySet<string>;
	projects: readonly ProjectEntry[];
	lit: ReadonlySet<string>;
	compact: boolean;
	actions: SidebarActions;
	collapsed: boolean;
	onToggleCollapsed: () => void;
	onExpand: () => void;
	shown: number;
	onShowMore: () => void;
	onCollapse: () => void;
}) {
	const visible = group.sessions.slice(0, Math.max(SESSION_PAGE, shown));
	const hidden = group.sessions.length - visible.length;
	const gap = compact ? "gap-[5px]" : "gap-[2px]";
	return (
		<div className="relative mb-2 flex flex-col">
			{/*
			 * 滚到这个项目里时项目名停在顶上，下一个项目的名字上来把它顶走。吸顶只在这一组里，组滚过去了名字跟着走，
			 * 交接不用写代码。铺底色和毛玻璃下的遮罩见 styles.css 的 `[data-plume-head]`。
			 */}
			<div data-plume-head className="sticky top-0 z-20">
				<ProjectHead
					group={{ ...group, sessions: withSpawned(group.sessions, spawned) }}
					live={live}
					compact={compact}
					actions={actions}
					collapsed={collapsed}
					onToggleCollapsed={onToggleCollapsed}
					onExpand={onExpand}
				/>
			</div>
			{/* 没有会话时整段不挂：底下那层的上内边距会让空项目展开比收起高出几像素。 */}
			{group.sessions.length > 0 && (
				<Collapse open={!collapsed}>
					<div className={`flex flex-col ${gap} ${compact ? "pt-[5px]" : "pt-[4px]"}`}>
						<SessionRows sessions={visible} spawned={spawned} busyParents={busyParents} lit={lit} compact={compact} projects={projects} actions={actions} />
						<ShowMore hidden={hidden} canCollapse={visible.length > SESSION_PAGE} compact={compact} onShowMore={onShowMore} onCollapse={onCollapse} />
					</div>
				</Collapse>
			)}
		</div>
	);
}

/**
 * 项目名这一行，是底下会话的标题。点它是折叠，不是切换：标题在一张长列表里最有用的是能收起来。
 *
 * 打开的项目不铺底色：项目紧挨着它下面打开的会话，两块一样的底色叠在一起就分不出层次。
 * 底色只留给悬停，意思是「你要按它了」。
 */
function ProjectHead({
	group,
	live,
	compact,
	actions,
	collapsed,
	onToggleCollapsed,
	onExpand,
}: {
	group: Group;
	live: number;
	compact: boolean;
	actions: SidebarActions;
	collapsed: boolean;
	onToggleCollapsed: () => void;
	onExpand: () => void;
}) {
	const { t } = useI18n();
	const menu = usePopover();
	const hover = useSessionCard();
	const reorder = useSidebarReorderContext();
	const dragging = useReorderState((state) => state.dragging?.kind === "project" && state.dragging.id === group.id);
	const placement = useReorderState((state) => (state.dropTarget?.kind === "project" && state.dropTarget.id === group.id ? state.dropTarget.placement : null));
	// 在折起来的项目里新开一段，先把它展开，不然新会话开了却看不见。
	const newSession = () => {
		onExpand();
		actions.newSession({ project: group.id });
	};
	return (
		<HoverRow
			data-plume-project={group.name}
			data-plume-project-id={group.id}
			{...hover.bind}
			onPointerMove={(event) => reorder?.registerTarget("project", group.id, event.currentTarget.getBoundingClientRect(), event.clientY)}
			onPointerLeave={() => reorder?.clearTarget(group.id)}
			controls={hoverSlot(2)}
			className={`rounded-field transition-colors hover:bg-card-hover ${dragging ? "opacity-40" : ""}`}
			onContextMenu={(event) => {
				event.preventDefault();
				hover.dismiss();
				// 右键作用于整行，没有哪个按钮可挂，菜单开在指针处。
				menu.openAtPoint(event);
			}}
		>
			{placement && <DropLineIndicator placement={placement} />}
			{hover.anchor && !dragging && (
				<ProjectCard name={group.name} path={group.path} folders={group.folders} count={group.sessions.length} anchor={hover.anchor} leaving={hover.leaving} />
			)}
			<button
				type="button"
				aria-expanded={!collapsed}
				onClick={onToggleCollapsed}
				onPointerDown={(event) => {
					hover.dismiss();
					reorder?.startDrag({ kind: "project", id: group.id, title: group.name }, event);
				}}
				className={`flex w-full items-center gap-2 rounded-field pr-2 pl-2.5 text-left text-label text-ink-muted transition-colors ${compact ? "h-[40px]" : "h-[32px]"}`}
			>
				{/* 只用文件夹本身表示开合，悬停时不换成箭头。 */}
				<span className="shrink-0">{collapsed ? <Folder size={16} /> : <FolderOpen size={16} />}</span>
				<ScrollText text={group.name} className="plume-fade-tail min-w-0 flex-1" />
				{/*
				 * 折起来时的数目，或在跑时的转圈。悬停时让开：菜单按钮正落在这个位置上，数字和图标画在同一块像素上哪个都读不出。
				 * 有东西时才占地方，展开的项目里名字能占满整行。
				 */}
				<span className="flex shrink-0 items-center pr-0.5 text-caption text-ink-faint tabular-nums transition-opacity empty:hidden group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0">
					<GroupActivity sessions={group.sessions} collapsed={collapsed} count={group.sessions.length} />
				</span>
			</button>
			<HoverRowReveal className="gap-0.5 rounded-r-lg">
				<IconButton
					size="sm"
					label={t("projectHead.newSession")}
					ariaLabel={t("projectHead.newSessionIn", { name: group.name })}
					onClick={newSession}
					className="pointer-events-auto"
					icon={<SquarePen size={13} strokeWidth={1.8} />}
				/>
				<IconButton
					size="sm"
					label={t("projectHead.actions")}
					ariaLabel={t("projectHead.actionsFor", { name: group.name })}
					menu={menu.open}
					onClick={menu.toggle}
					className="pointer-events-auto"
					icon={<MoreHorizontal size={13} strokeWidth={1.8} />}
				/>
			</HoverRowReveal>
			{menu.open && <ProjectMenu anchor={menu.anchor} project={group} live={live} actions={actions} onNewSession={newSession} onClose={menu.close} />}
		</HoverRow>
	);
}

/**
 * 一组会话底下的翻页。「再多看几段」和「回到开头」是两件事，分成两个按钮：一个按钮随状态换意思，第二下按出什么就猜不准。
 * 数的是还剩几段没露出来，那才是想知道的。只有字，悬停字色深一档，不铺底色。
 * 图标落在 14px 的槽里，和上面会话行的状态点对齐。
 */
function ShowMore({
	hidden,
	canCollapse,
	compact,
	onShowMore,
	onCollapse,
}: {
	hidden: number;
	canCollapse: boolean;
	compact: boolean;
	onShowMore: () => void;
	onCollapse: () => void;
}) {
	const { t } = useI18n();
	if (hidden <= 0 && !canCollapse) return null;
	const height = compact ? "h-[34px]" : "h-[32px]";
	const slot = "flex size-3.5 shrink-0 items-center justify-center text-ink-faint transition-colors group-hover/more:text-ink-muted";
	const label = "truncate text-detail text-ink-faint tabular-nums transition-colors group-hover/more:text-ink-muted";
	const more = (
		<>
			<span className={slot}>
				<ChevronDown size={12} strokeWidth={2} aria-hidden />
			</span>
			<span className={label}>
				<RollingText rollKey={hidden}>{t("showMore.expand", { n: hidden })}</RollingText>
			</span>
		</>
	);

	// 三种形状各给一个 key：前两种对 React 是同一个 <button>，按下后节点留着，悬停色会跟到列表挪过去的位置上。
	if (hidden > 0 && !canCollapse) {
		return (
			<button
				key="more"
				type="button"
				data-plume-show-more=""
				onClick={onShowMore}
				className={`group/more flex w-full min-w-0 items-center gap-2 rounded-field pr-2 pl-2 text-left text-label ${height}`}
			>
				{more}
			</button>
		);
	}
	if (hidden <= 0) {
		return (
			<button
				key="collapse"
				type="button"
				data-plume-show-more=""
				onClick={onCollapse}
				className={`group/more flex w-full min-w-0 items-center gap-2 rounded-field pr-2 pl-2 text-left text-label ${height}`}
			>
				<span className={slot}>
					<ChevronUp size={12} strokeWidth={2} aria-hidden />
				</span>
				<span className={label}>{t("common.collapse")}</span>
			</button>
		);
	}
	return (
		<div key="split" data-plume-show-more="" className={`flex w-full min-w-0 items-center justify-between gap-1 rounded-field ${height}`}>
			<button type="button" onClick={onShowMore} className="group/more flex min-w-0 flex-1 items-center gap-2 rounded-field pr-1.5 pl-2 text-left text-label">
				{more}
			</button>
			<button
				type="button"
				onClick={onCollapse}
				className="flex shrink-0 items-center gap-1 rounded-md px-1.5 text-detail text-ink-faint transition-colors hover:text-ink-muted"
			>
				<ChevronUp size={12} strokeWidth={2} aria-hidden />
				{t("common.collapse")}
			</button>
		</div>
	);
}
