import { useI18n } from "@plume/ui";
import { AppWindow, MessagesSquare, Settings } from "@plume/ui/icons";
import { MAIN_TOOLBAR_HEIGHT } from "../../shared/window-chrome.ts";
import { layoutMode, RAIL_WIDTH } from "../layout.ts";
import { listPages, localized, pageBadge, usePluginUis } from "../plugins.tsx";
import { MarketNavItem } from "../market/market.tsx";
import { RailItem } from "../nav-item.tsx";
import type { Screen } from "../nav-history.ts";
import { UpdateBadge } from "../update/UpdateBadge.tsx";
import { SidebarTools } from "../sidebar/SidebarTools.tsx";
import { setSidebar, showPanel } from "./panels.ts";
import { nextTurnCwd, state, update, useAppPick, useChrome } from "./state.ts";
import { DRAG, HEADER_BAR } from "./shell-classes.ts";
import { sidebarActions } from "./actions.ts";

/** 有自己侧栏的界面：对话是项目和会话，设置是章节列表。插件市场和插件的页面整页给内容，活动栏右边直接是卡片。 */
export function hasSidebar(screen: Screen): boolean {
	return screen === "chat" || screen === "settings";
}

/**
 * 活动栏：窗口最左边一列图标，换的是整个界面——对话、插件市场、插件的页面、设置；搜索和通知也在这里，哪一页都够得着。
 *
 * 以前这些入口和项目列表挤在同一根侧栏里，插件的页面要列表只能在正文里再开一列，成了三栏。分开以后侧栏只放当前界面自己的东西，
 * 页面不要侧栏就整页给它。这一列不收起、不拖宽度、不跟侧栏一起滑：开合侧栏时它一动不动，滑的只有侧栏和卡片。
 */
export function Rail() {
	const { t, resolvedLocale } = useI18n();
	const { screen, sessions, projects, currentId, windowWidth } = useChrome();
	const currentSummary = useAppPick((current) => current.view?.summary);
	usePluginUis();
	const go = (next: Screen) => update({ screen: next, drawerOpen: false });
	const compact = layoutMode(windowWidth) === "compact";
	return (
		<nav aria-label={t("app.rail")} className="relative z-30 flex shrink-0 flex-col items-center" style={{ width: RAIL_WIDTH }}>
			{/* 窗口顶上那一条在这一列的一段：红绿灯在这里，和侧栏身子上面那一截一样高，第一格和身子的顶边对齐。 */}
			<div aria-hidden className={`w-full shrink-0 ${HEADER_BAR ? "" : DRAG}`} style={{ height: MAIN_TOOLBAR_HEIGHT }} />
			<div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto pt-1 pb-1 [scrollbar-width:none]">
				<RailItem
					nav="chat"
					active={screen === "chat"}
					label={t("app.chats")}
					icon={<MessagesSquare size={17} strokeWidth={1.8} />}
					onClick={() => go("chat")}
				/>
				<MarketNavItem active={screen === "market"} onClick={() => go("market")} />
				{listPages().map((page) => {
					const Icon = page.icon ?? AppWindow;
					const key = `page:${page.key}` as const;
					const badge = pageBadge(page.key);
					return (
						<RailItem
							key={page.key}
							nav={key}
							active={screen === key}
							label={localized(page.title, resolvedLocale)}
							icon={<Icon size={17} strokeWidth={1.8} />}
							onClick={() => go(key)}
							// 窄活动栏只标有事待看，详情留在提示里；人就在这一页上时不再挂着。
							{...(badge && screen !== key ? { badge: true, badgeLabel: localized(badge.label, resolvedLocale) } : {})}
						/>
					);
				})}
			</div>
			<div className="flex shrink-0 flex-col items-center gap-1.5 pt-1.5 pb-2">
				<SidebarTools
					sessions={sessions}
					projects={projects}
					currentId={screen === "chat" ? currentId : undefined}
					cwd={nextTurnCwd(state, currentSummary)}
					actions={sidebarActions}
					openPage={(key) => go(key === "market" ? "market" : `page:${key}`)}
					openSettings={(settingsSection) => update({ screen: "settings", settingsSection, drawerOpen: false })}
					openPanel={(key) => {
						go("chat");
						showPanel(key, true);
					}}
					toggleSidebar={() => (compact ? update({ drawerOpen: !state.drawerOpen }) : setSidebar({ open: !state.sidebarOpen }))}
				/>
				<UpdateBadge />
				<RailItem
					nav="settings"
					active={screen === "settings"}
					label={t("sidebar.settings")}
					icon={<Settings size={17} strokeWidth={1.8} />}
					onClick={() => go("settings")}
				/>
			</div>
		</nav>
	);
}
