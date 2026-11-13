import { ResizeHandle, Scroller, useI18n } from "@plume/ui";
import { AppWindow, SquarePen } from "@plume/ui/icons";
import { useMemo } from "react";
import { TOP_ROW_HEIGHT } from "../../shared/window-chrome.ts";
import { clamp, layoutMode, SIDEBAR_DEFAULT, SIDEBAR_MIN } from "../layout.ts";
import { ArrowLeft, Settings } from "../icons.tsx";
import { listPages, pageBadge, localized, usePluginUis } from "../plugins.tsx";
import { MarketNavItem } from "../market/market.tsx";
import { NavItem } from "../nav-item.tsx";
import type { Screen } from "../nav-history.ts";
import { UpdateBadge } from "../update/UpdateBadge.tsx";
import { SettingsNav } from "../settings/pages.tsx";
import { SidebarTools } from "../sidebar/SidebarTools.tsx";
import { ProjectList } from "../sidebar/ProjectList.tsx";
import { sessionWindows } from "../session-windows.ts";
import { setSidebar, showPanel } from "./panels.ts";
import { nextTurnCwd, state, update, useAppPick, useChrome } from "./state.ts";
import { DRAG, HEADER_BAR } from "./shell-classes.ts";
import { sidebarActions } from "./actions.ts";
import { openNew } from "./sessions.ts";

/** 把手独立定位在侧栏右边界，避免被侧栏的溢出裁切。 */
export function SidebarResizer({ width, max }: { width: number; max: number }) {
	const { t } = useI18n();
	const resize = (next: number) => setSidebar({ width: clamp(Math.round(next), SIDEBAR_MIN, max) });
	return (
		<div className="absolute inset-y-0 w-0" style={{ left: width }}>
			<ResizeHandle
				edge="end"
				width={width}
				min={SIDEBAR_MIN}
				max={max}
				onResize={resize}
				onReset={() => resize(SIDEBAR_DEFAULT)}
				label={t("panes.resizeSidebar")}
			/>
		</div>
	);
}

/** 侧栏里放什么：工作区是会话列表，设置页是章节列表。开关、拖宽度、抽屉两边共用。 */
export function SidebarContent() {
	const { screen } = useChrome();
	return screen === "settings" ? <SettingsSidebar /> : <Sidebar />;
}

/**
 * 顶行的空当：红绿灯和侧栏开关浮在这里，这一行用来拖窗口。
 * 只留顶行的 44px，不加 ROW_OFFSET：红绿灯和开关跟着卡片往下挪了 5px，底边也还在 40px 以内，
 * 再给偏移多留一截，侧栏的内容就整体往下掉 5px，离红绿灯远了。
 */
function SidebarTopRow() {
	// Windows、Linux 的顶行是窗口顶上那条带子，侧栏从它底下开始，再留一行就空出两行。
	if (HEADER_BAR) return null;
	return <div className={`shrink-0 ${DRAG}`} style={{ height: TOP_ROW_HEIGHT }} />;
}

function SettingsSidebar() {
	const { t } = useI18n();
	const { settingsSection, windowWidth } = useChrome();
	const compact = layoutMode(windowWidth) === "compact";
	return (
		<>
			<SidebarTopRow />
			<div className={`pb-3 ${compact ? "px-3" : "px-2"}`}>
				<button
					type="button"
					onClick={() => update({ screen: "chat", drawerOpen: false })}
					className={`m-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-1.5 text-left text-label text-ink-muted transition hover:bg-card-hover hover:text-ink ${compact ? "h-10" : "h-8"}`}
				>
					<ArrowLeft />
					{t("app.backWorkspace")}
				</button>
			</div>
			<SettingsNav section={settingsSection} compact={compact} onPick={(section) => update({ settingsSection: section, drawerOpen: false })} />
		</>
	);
}

/**
 * 不是会话的去处。放在滚动区里、不钉在上面：去处一天只去几次，钉住的话每多一个就永久占掉窄栏的一行，
 * 会话——这一栏存在的理由——就一直从下面开始。开对话值得钉住，去处可以滚过去。
 * 插件加的页面也排在这里（在「插件」前面），加多少都不挤占会话的位置。
 */
function DestinationNav({ compact, active }: { compact: boolean; active: Screen }) {
	const { resolvedLocale } = useI18n();
	usePluginUis();
	return (
		<div className="flex flex-col gap-1 pb-1">
			{listPages().map((page) => {
				const Icon = page.icon ?? AppWindow;
				const screen = `page:${page.key}` as const;
				const badge = pageBadge(page.key);
				return (
					<NavItem
						key={page.key}
						nav={screen}
						compact={compact}
						active={active === screen}
						icon={<Icon size={16} />}
						label={localized(page.title, resolvedLocale)}
						onClick={() => update({ screen, drawerOpen: false })}
						// 人就在这一页上时数目说的就是眼前的东西，不再挂着。
						{...(badge && active !== screen ? { badge: badge.count, badgeLabel: localized(badge.label, resolvedLocale) } : {})}
					/>
				);
			})}
			<MarketNavItem active={active === "market"} compact={compact} onClick={() => update({ screen: "market", drawerOpen: false })} />
		</div>
	);
}

/** 产品名一行右边的按钮。比 IconButton 的 26px 大一档、字色深一档：它们是整栏的入口，不是工具栏里的一个小操作。 */
function Sidebar() {
	const { t } = useI18n();
	const { sessions, projects, currentId, pendingId, windowWidth, screen } = useChrome();
	const currentSummary = useAppPick((current) => current.view?.summary);
	const compact = layoutMode(windowWidth) === "compact";
	const pad = compact ? "px-3" : "px-2.5";
	const detached = sessionWindows.use();
	const selected = pendingId ?? currentId;
	const lit = useMemo(() => new Set(selected ? [...detached, selected] : detached), [selected, detached]);
	return (
		<>
			<SidebarTopRow />
			{/*
			 * 产品名这一行。pl-5：名字和下面新对话的图标、列表的标题起在同一条线上（侧栏边距 10px 加行内 10px）。
			 * 行高和右边的按钮一样是 28px：按钮的顶边落在旁边卡片的顶边上，再留空当两个顶边就读成没对齐。
			 * mb-[11px] 让它读作整栏的标题，而不是新对话的上一行。右边距让按钮落在会话行右端操作的那一列上。
			 */}
			<div className={`mb-[11px] flex h-7 shrink-0 items-center justify-between pl-5 ${compact ? "pr-[15px]" : "pr-[13px]"}`}>
				<span className="text-title font-semibold tracking-tight text-ink">Plume</span>
				<div className="flex items-center gap-[5px]">
					<SidebarTools
						sessions={sessions}
						projects={projects}
						currentId={screen === "chat" ? currentId : undefined}
						cwd={nextTurnCwd(state, currentSummary)}
						actions={sidebarActions}
						openPage={(key) => update({ screen: key === "market" ? "market" : `page:${key}`, drawerOpen: false })}
						openSettings={(settingsSection) => update({ screen: "settings", settingsSection, drawerOpen: false })}
						openPanel={(key) => {
							update({ screen: "chat", drawerOpen: false });
							showPanel(key, true);
						}}
						toggleSidebar={() => (compact ? update({ drawerOpen: !state.drawerOpen }) : setSidebar({ open: !state.sidebarOpen }))}
					/>
				</div>
			</div>
			{/* 只有新对话钉在列表上面，其余去处见 DestinationNav。 */}
			<div className={`shrink-0 pb-1 ${pad}`}>
				<NavItem nav="new-chat" compact={compact} icon={<SquarePen size={16} />} label={t("sidebar.newChat")} onClick={() => openNew()} />
			</div>
			{/* 两头都不渐隐：顶上有吸顶的项目名盖着滑过去的行，底下有设置那一行，再淡一层只会把边上的行弄灰。 */}
			<Scroller className="flex-1" contentClassName={`pb-2 ${pad}`} top="none" bottom="none">
				<DestinationNav compact={compact} active={screen} />
				{/* pt-3 是上面那截和列表之间的间距，列表的第一个标题不自带上间距。 */}
				<nav className="pt-3" aria-label={t("common.session")}>
					<ProjectList sessions={sessions} projects={projects} lit={lit} compact={compact} actions={sidebarActions} />
				</nav>
			</Scroller>
			{/* 设置那一行，末尾是有新版本时才出现的更新圆点：这一条是关于应用本身的。 */}
			<div data-plume-sidebar-foot="" className={`flex shrink-0 items-center gap-2 ${compact ? "p-3" : "p-2.5"}`}>
				<button
					type="button"
					className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-card-hover active:bg-elevated ${compact ? "h-10" : "h-8.5"}`}
					onClick={() => update({ screen: "settings", drawerOpen: false })}
				>
					<span className="text-ink-muted">
						<Settings />
					</span>
					<span className="sidebar-foot-label min-w-0 flex-1 truncate text-label text-ink">{t("sidebar.settings")}</span>
				</button>
				<UpdateBadge compact={compact} />
			</div>
		</>
	);
}
