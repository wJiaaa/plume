import { ResizeHandle, Scroller, useI18n } from "@plume/ui";
import { SquarePen } from "@plume/ui/icons";
import { useMemo } from "react";
import { MAIN_TOOLBAR_HEIGHT } from "../../shared/window-chrome.ts";
import { clamp, layoutMode, RAIL_WIDTH, SIDEBAR_DEFAULT, SIDEBAR_MIN } from "../layout.ts";
import { NavItem } from "../nav-item.tsx";
import { SettingsNav } from "../settings/pages.tsx";
import { ProjectList } from "../sidebar/ProjectList.tsx";
import { sessionWindows } from "../session-windows.ts";
import { setSidebar } from "./panels.ts";
import { update, useChrome } from "./state.ts";
import { DRAG, HEADER_BAR } from "./shell-classes.ts";
import { ArrowLeft } from "../icons.tsx";
import { sidebarActions } from "./actions.ts";
import { openNew } from "./sessions.ts";

/** 把手独立定位在侧栏右边界（活动栏右边再过一个侧栏宽），避免被侧栏的溢出裁切。 */
export function SidebarResizer({ width, max }: { width: number; max: number }) {
	const { t } = useI18n();
	const resize = (next: number) => setSidebar({ width: clamp(Math.round(next), SIDEBAR_MIN, max) });
	return (
		<div className="absolute inset-y-0 w-0" style={{ left: RAIL_WIDTH + width }}>
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
 * 侧栏身子上面那一截：窗口顶上那一条在侧栏这一段，红绿灯和前进、后退、侧栏开关浮在这里，能拖窗口。
 * 和对话的标题栏一样高（见 `ScreenCard`），侧栏和对话的身子顶边对齐。
 * Windows、Linux 上按钮在窗口顶上那条带子里，这一截只占位、不拖窗口：对话的身子上面同样空着一行标题栏。
 *
 * 停靠时右端竖一小截线（`divider`），和下面两栏之间的分隔线在同一列，把这一条分成侧栏、对话两段。开合滑动时它不在：
 * 它长在侧栏右边上，跟着滑会从红绿灯、前进后退、侧栏开关底下扫过去；收起那一下当场藏起，展开滑到位再淡出来。
 */
export function SidebarTopRow({ divider }: { divider: boolean }) {
	return (
		<div className={`relative shrink-0 ${HEADER_BAR ? "" : DRAG}`} style={{ height: MAIN_TOOLBAR_HEIGHT }}>
			<span
				aria-hidden
				data-sidebar-divider=""
				className={`absolute top-1/2 right-0 h-5 w-px -translate-y-1/2 bg-line-float ${divider ? "transition-opacity duration-[var(--plume-t-base)]" : "opacity-0"}`}
			/>
		</div>
	);
}

function SettingsSidebar() {
	const { t } = useI18n();
	const { settingsSection, windowWidth } = useChrome();
	const compact = layoutMode(windowWidth) === "compact";
	return (
		<>
			<div className={`pt-1 pb-3 ${compact ? "px-3" : "px-2"}`}>
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

/** 对话的侧栏：新对话钉在上面，下面是项目和会话。去处（插件的页面、插件市场、设置）和搜索、通知在活动栏里，见 Rail.tsx。 */
function Sidebar() {
	const { t } = useI18n();
	const { sessions, projects, currentId, pendingId, windowWidth, split } = useChrome();
	const compact = layoutMode(windowWidth) === "compact";
	const pad = compact ? "px-3" : "px-2.5";
	const detached = sessionWindows.use();
	const selected = pendingId ?? currentId;
	// 分屏时另一屏的会话也点亮。
	const other = split?.sessionId;
	const lit = useMemo(() => new Set([...detached, ...(selected ? [selected] : []), ...(other ? [other] : [])]), [selected, other, detached]);
	return (
		<>
			<div className={`shrink-0 pt-1.5 pb-1 ${pad}`}>
				<NavItem nav="new-chat" compact={compact} icon={<SquarePen size={16} />} label={t("sidebar.newChat")} onClick={() => openNew()} />
			</div>
			{/* 两头都不渐隐：顶上有吸顶的项目名盖着滑过去的行，再淡一层只会把边上的行弄灰。 */}
			<Scroller className="flex-1" contentClassName={`pb-2 ${pad}`} top="none" bottom="none">
				{/* pt-2 是新对话和列表之间的间距，列表的第一个标题不自带上间距。 */}
				<nav className="pt-2" aria-label={t("common.session")}>
					<ProjectList sessions={sessions} projects={projects} lit={lit} compact={compact} actions={sidebarActions} />
				</nav>
			</Scroller>
		</>
	);
}
