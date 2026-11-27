import type { SessionSummary, SessionView } from "@plume/contract";
import type { PanelProps } from "@plume/contract/ui";
import {
	acceleratorLabel,
	ClosableTab,
	composingKey,
	IconButton,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	Popover,
	ResizeHandle,
	shortcutLetter,
	Sideways,
	translate,
	useI18n,
	usePopover,
} from "@plume/ui";
import { AppWindow, Compass, Maximize2, Minimize2, SquareArrowOutUpRight, PanelRight, Pin, PinOff, Plus } from "@plume/ui/icons";
import { memo, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PanelSurface } from "../panel-surface.tsx";
import { MAIN_TOOLBAR_HEIGHT, TOP_ROW_HEIGHT } from "../../shared/window-chrome.ts";
import type { TitlebarInsets } from "../titlebar.ts";
import { clamp, layoutMode, PANEL_MIN } from "../layout.ts";
import { notify } from "../toast/index.ts";
import { useManagedSkin } from "../appearance-settings.ts";
import { listPanels, panelEntry, localized, type PanelEntry, PanelSlot, setPanelScope, usePluginUis } from "../plugins.tsx";
import { FileBrowser } from "../files/FileBrowser.tsx";
import { FilePanel } from "../files/FilePanel.tsx";
import { fileOf, openFileIn } from "../files/open-file.ts";
import { useLiveSession } from "../session-live.ts";
import { flushChildDrafts } from "../conversation/child-drafts.ts";
import { ToolbarButton, ToolbarOverlap, WindowHeader } from "../window-controls.tsx";
import { panelGeometry } from "../panel-layout.ts";
import { type Chrome, type PanelTab, type PanelTabs, panelWindow, state, update, useAppPick, useChrome } from "./state.ts";
import { addPanelTab, closeTab, handlesOf, launch, panelOpenIn, popOutTab, scopeOf, selectTab, setPanelWidth, tabsOf, togglePanel } from "./panels.ts";
import { useTabSessions } from "./tab-sessions.ts";
import { activityOf, useActivityVersion, waitingWords, waitOf } from "../sidebar/activity.ts";
import { CARD_DRAG, DRAG, HEADER_BAR, NO_DRAG, slideMotion } from "./shell-classes.ts";
import { FrameRound } from "./FrameRound.tsx";
import { parked } from "./sessions.ts";

/** 弹出去的标签不占这一屏的位置，当前标签移交给仍留在屏内的一个。 */
function panelGroup(app: Chrome, scope: string): PanelTabs {
	const group = tabsOf(app, scope);
	const tabs = group.tabs.filter((tab) => !app.panelWindows.some((entry) => entry.tab === tab.id));
	return { tabs, active: tabs.some((tab) => tab.id === group.active) ? group.active : (tabs.at(-1)?.id ?? "") };
}

export function panelLayout(app: Chrome, size: { width: number; height: number }, share: number, scope = scopeOf(app)) {
	const group = panelGroup(app, scope);
	const shown = listPanels().length > 0 && group.tabs.length > 0 && panelOpenIn(app, scope);
	return {
		shown,
		...panelGeometry({
			...size,
			preferred: app.panelWidth[scope] ?? 0,
			share,
			compact: layoutMode(app.windowWidth) === "compact",
			maximized: app.panelMaximized[scope] === true,
			shown,
		}),
	};
}

/**
 * 面板区开合时对话和面板一起滑，和侧栏开合（`slideMotion`）同一组时长、曲线：展开 slow + out，收起 base + soft。
 * 里面的内容跟着淡入淡出，见 styles.css 的 `[data-panel-sliding]`。
 */
export function panelMotion(opening: boolean): string {
	return `transition-[right,bottom,width,height] ${slideMotion(opening)}`;
}

/** 独立窗口浮在别的应用上面：查资料、对着别的窗口干活时，这段对话或这块面板一直在手边。 */
export function KeepOnTopButton({ keepOnTop }: { keepOnTop: (enabled?: boolean) => Promise<boolean> }) {
	const { t } = useI18n();
	const [enabled, setEnabled] = useState(false);
	const [pending, setPending] = useState(false);
	useEffect(() => {
		void keepOnTop().then(setEnabled);
	}, [keepOnTop]);
	return (
		<ToolbarButton
			label={t(enabled ? "window.releaseTop" : "window.keepOnTop")}
			active={enabled}
			onClick={async () => {
				if (pending) return;
				setPending(true);
				try {
					setEnabled(await keepOnTop(!enabled));
				} finally {
					setPending(false);
				}
			}}
		>
			<span data-keep-on-top={enabled ? "true" : "false"} className="flex items-center justify-center">
				{enabled ? <PinOff size={13} strokeWidth={1.9} /> : <Pin size={13} strokeWidth={1.9} />}
			</span>
		</ToolbarButton>
	);
}

function PanelIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
			<rect x="2" y="3" width="12" height="10" rx="2" />
			<path d="M10 3v10" />
		</svg>
	);
}

/** 顶行右端给面板开关让的位置：开关右边 12px、自己 26px、和前面的按钮隔 6px。正文和面板的顶行让得一样多。 */
export const PANEL_TOGGLE_ROOM = "pr-11";

/**
 * 面板区的开关只有一颗，钉在工作区右上角，不长在哪张卡片上：开合时两张卡片在它底下滑，它留在原处，只换说明。
 * 分成正文顶行的「打开」、面板顶行的「收起」两颗时，开合那一下鼠标底下的按钮先没了（一颗当场卸掉，另一颗还在窗口外，
 * 或者还没淡进来），滑完又在差几像素的地方冒出来。上下排时面板区在下面，收起按钮留在它自己的顶行，见 PanelArea。
 * 它盖在两张卡片的顶行（拖拽区）上，得排在工作区的最后，见 Chat.tsx 的 ChatScreen。
 */
export function PanelToggle({ open, scope }: { open: boolean; scope: string }) {
	const { t } = useI18n();
	return (
		<div data-panel-toggle="" className="absolute top-0 right-px z-10 flex items-center pr-3 will-change-transform" style={{ height: MAIN_TOOLBAR_HEIGHT }}>
			<IconButton
				className={NO_DRAG}
				label={t(open ? "panel.hide" : "panel.show")}
				expanded={open}
				icon={<PanelIcon />}
				onClick={() => togglePanel(!open, scope)}
			/>
		</div>
	);
}

/** 把手骑在对话和面板区之间那 1px 分隔线上，独立于面板的溢出裁切。 */
export function PanelResizer({ scope, width, windowWidth, max }: { scope: string; width: number; windowWidth: number; max: number }) {
	const { t } = useI18n();
	const resize = (next: number) => setPanelWidth(scope, clamp(Math.round(next), PANEL_MIN, max));
	return (
		// 压在常驻面板的内容层上面（那一层在工作区的最后，见 Chat.tsx 的 `ChatWorkspace`），把手右半截不被它挡住。
		// 贴着右边用 `right: width` 定位：侧栏滑动改变工作区宽度时，把手纯靠 CSS 钉在面板左沿，不依赖每帧 JS 重算宽度。
		<div className="absolute inset-y-0 z-10 w-0" style={{ right: width }}>
			<ResizeHandle edge="start" width={width} min={PANEL_MIN} max={max} onResize={resize} onReset={() => resize(windowWidth / 2)} label={t("panel.resize")} />
		</div>
	);
}

/** 一屏的面板几何（见 Chat.tsx 的 `ChatWorkspace`）：常驻面板的内容只有一层，按标签所在的那一屏摆。 */
export interface PaneLayout {
	scope: string;
	focused: boolean;
	/** 这一屏在工作区里的左边和宽度。 */
	left: number;
	width: number;
	/** 分屏时在哪一边；一屏时是 undefined。 */
	side?: "left" | "right" | undefined;
	layout: ReturnType<typeof panelLayout>;
	/** 侧栏开合、面板区正滑着时内容定住的宽度（面板外框），见 Chat.tsx 的 `screenLayout`；不在滑时是 undefined。 */
	floor: number | undefined;
}

/**
 * 内容按首次挂载的顺序追加，切换会话不能让 React 移动 webview 的 DOM。整个工作区只有这一层：分屏时两屏的标签也在这里，
 * 按标签所在的那一屏（`panes`）摆，换会话、换焦点时只换位置，不搬 DOM。
 */
export function PanelLayer({ panes }: { panes: readonly PaneLayout[] }) {
	const app = useChrome();
	usePluginUis();
	const found: { tab: PanelTab; scope: string; panel: PanelEntry }[] = [];
	for (const [scope, group] of Object.entries(app.panelTabs)) {
		for (const tab of group.tabs) {
			const panel = tab.panel ? panelEntry(tab.panel) : undefined;
			const onScreen = app.screen === "chat" && panes.some((pane) => pane.scope === scope);
			if (panel && !app.panelWindows.some((entry) => entry.tab === tab.id) && (panel.keepAlive || onScreen)) found.push({ tab, scope, panel });
		}
	}
	const order = useRef<string[]>([]);
	const ids = new Set(found.map(({ tab }) => tab.id));
	order.current = [...order.current.filter((id) => ids.has(id)), ...[...ids].filter((id) => !order.current.includes(id))];
	found.sort((a, b) => order.current.indexOf(a.tab.id) - order.current.indexOf(b.tab.id));
	const focused = panes.find((pane) => pane.focused);
	if (!focused) return null;
	return (
		<div className="contents" data-panel-kept="">
			{found.map(({ tab, scope, panel }) => (
				<PanelLayerTab key={tab.id} tab={tab} scope={scope} panel={panel} pane={panes.find((pane) => pane.scope === scope)} fallback={focused} />
			))}
		</div>
	);
}

function PanelLayerTab({
	tab,
	scope,
	panel,
	pane,
	fallback,
}: {
	tab: PanelTab;
	scope: string;
	panel: PanelEntry;
	/** 标签的会话在哪一屏；不在屏上（后台的常驻面板）是 undefined。 */
	pane: PaneLayout | undefined;
	/** 还没在屏上摆过的后台标签先按焦点那一屏摆。 */
	fallback: PaneLayout;
}) {
	const app = useChrome();
	const current = pane !== undefined;
	// 后台标签保留最后的位置和尺寸，切换会话不改变其内部布局。
	const last = useRef(pane ?? fallback);
	if (pane) last.current = pane;
	const { layout, left, width, side } = last.current;
	const moving = app.panelMoving && pane?.focused === true;
	const shown = current && layout.shown && app.screen === "chat" && panelGroup(app, scope).active === tab.id;
	const hidden = !shown && !(moving && panelGroup(app, scope).active === tab.id);
	const motion = moving ? panelMotion(layout.shown) : "";
	const floor = current ? pane.floor : undefined;
	return (
		// 外层按这一屏摆，带上这一屏的排法、开合和拼边：styles.css 按它们给内容淡入淡出、去掉挨着别人那一边的圆角。
		<div
			className="pointer-events-none absolute inset-y-0"
			style={{ left, width: current && !side ? "100%" : width }}
			data-panel-layout={layout.arrangement}
			data-panel-sliding={moving ? (layout.shown ? "open" : "close") : undefined}
			data-panel-shown={layout.shown || undefined}
			data-frame-right={(layout.arrangement === "row" && (layout.shown || moving)) || undefined}
			data-split-pane={side}
		>
			<div
				data-panel-layer={scope}
				data-panel-tab-id={tab.id}
				inert={!shown}
				// 同时给 opacity-0：只靠 visibility: hidden 时，后代或插件若显式声明 visibility: visible 会穿透出来。
				className={`pointer-events-none absolute inset-0 overflow-hidden ${hidden ? "invisible opacity-0" : ""}`}
			>
				<div className={`plume-panel plume-freeze absolute ${motion}`} style={layout.panel}>
					{/* 和 PanelArea 里面板的身子对齐：标签行在身子上面，身子从它下面开始、带 1px 描边。 */}
					<div data-frame-clip="" className="absolute inset-x-0 bottom-0 overflow-hidden" style={{ top: MAIN_TOOLBAR_HEIGHT }}>
						<FrameRound>
							<div
								id={`panel-content:${tab.id}`}
								data-panel={panel.key}
								inert={!shown}
								className={`plume-dock-pane ${shown ? "pointer-events-auto" : "pointer-events-none"} absolute overflow-auto origin-top-left`}
								// 定宽时贴着左边：面板区靠右停，滑着时它的左边跟着正文走，内容跟着左边，右边先空出一截。
								style={floor !== undefined ? { top: 1, left: 1, bottom: 1, width: Math.max(0, floor - 2) } : { top: 1, left: 1, right: 1, bottom: 1 }}
							>
								<PanelContents panel={panel} tab={tab} scope={scope} shown={shown} />
							</div>
						</FrameRound>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * 标签的图标，左上角挂一个点：标签名会被截断、标签条会横着溢出，挂在名字后面常被裁掉。
 * 替它说话的会话（`PanelProps.setSessions`）有停下来等人的，是和侧栏同色、同一句话的等待点，悬停说在等什么；
 * 否则是面板点亮的未读点。等人的排前面：那是一件会一直等下去的事。
 */
function TabIcon({ tab, icon }: { tab: PanelTab; icon: ReactNode }) {
	const { t } = useI18n();
	const sessions = useTabSessions(tab.id);
	// 等待状态在侧栏的活动记录里，跟着它的版本号重算。
	useActivityVersion();
	const waiting = sessions.find((sessionId) => activityOf(sessionId) === "waiting");
	const waitingLabel = waiting === undefined ? undefined : waitingWords(waitOf(waiting), t);
	return (
		<span className="relative flex shrink-0" data-plume-tip={waitingLabel}>
			{icon}
			{waitingLabel !== undefined ? (
				<span data-panel-tab-waiting="" role="img" aria-label={waitingLabel} className="absolute -top-0.5 -left-0.5 block size-1.5 rounded-full bg-warning" />
			) : (
				tab.unread && (
					<span
						data-panel-tab-unread=""
						role="img"
						aria-label={t("sessionStatus.unread")}
						className="absolute -top-0.5 -left-0.5 block size-1.5 rounded-full bg-accent"
					/>
				)
			)}
		</span>
	);
}

/**
 * 面板区：一张和正文一样的浮起卡片，卡片上面一排标签，每个开着的面板一个，后面的「+」弹出面板菜单直接添加。
 * 这个会话的标签都挂着，只有当前那个看得见：后台的终端、计划切回来不重来。右端收起面板区。
 */
export function PanelArea({
	scope = scopeOf(state),
	maximized = false,
	compact = false,
	underToolbar = false,
	detached = false,
	titlebar,
	arrangement = "row",
}: {
	scope?: string;
	maximized?: boolean;
	compact?: boolean;
	/** 面板区独占工作区（单栏）时占着卡片的左上角：侧栏收起后顶行要给窗口按钮让位，宽度是 `ToolbarOverlap`。 */
	underToolbar?: boolean;
	detached?: boolean;
	/** 弹出的窗口顶行两端让给系统多少；Windows、Linux 上标题栏就画在窗口顶上那条带子里。 */
	titlebar?: TitlebarInsets;
	arrangement?: string;
}) {
	const { t, resolvedLocale } = useI18n();
	const app = useChrome();
	const overlap = useContext(ToolbarOverlap);
	const managedSkin = useManagedSkin();
	usePluginUis();
	const panels = detached && panelWindow ? [panelEntry(panelWindow.panel)].filter((entry): entry is PanelEntry => Boolean(entry)) : listPanels();
	// 只要摘要：订阅整份视图的话，流式输出时草稿每一拍都把标签条、开始页整片重画一遍。
	const summary = usePanelSummary(scope);
	const cwd = panelCwd(app, scope, summary);
	const running = summary?.running ?? false;
	useLayoutEffect(() => setPanelScope(cwd, scope !== ""), [cwd, scope, running]);
	const available = listPanels(cwd, scope !== "");
	const group = tabsOf(app, scope, panels);
	const tabs = group.tabs.filter((tab) => !app.panelWindows.some((entry) => entry.tab === tab.id));
	const active = tabs.some((tab) => tab.id === group.active) ? group.active : tabs.at(-1)?.id;
	const current = tabs.find((tab) => tab.id === active);
	const definition = panels.find((entry) => entry.key === current?.panel);
	const track = useRef<HTMLDivElement>(null);
	const addMenu = usePopover();
	const closeAddMenu = useRef(addMenu.close);
	closeAddMenu.current = addMenu.close;
	const stacked = arrangement === "column";
	const panelOpen = panelOpenIn(app, scope);
	const listedPanels = available.filter((entry) => entry.listed);
	const openedKeys = new Set(group.tabs.filter((tab) => tab.panel && !tab.sessionId).map((tab) => tab.panel!));
	const addable = listedPanels.filter((entry) => entry.multiple || !openedKeys.has(entry.key));
	// 切换会话、切换标签、面板区收起或已无可添加项时收起「+」菜单，避免菜单悬在旧上下文上。
	useEffect(() => {
		closeAddMenu.current();
	}, [scope, active]);
	useEffect(() => {
		if (!panelOpen || addable.length === 0) closeAddMenu.current();
	}, [panelOpen, addable.length]);
	useEffect(() => {
		const strip = track.current;
		const tab = strip?.querySelector('[aria-selected="true"]');
		if (!strip || !tab) return;
		const observer = new ResizeObserver(() => {
			const outer = strip.getBoundingClientRect(),
				inner = tab.getBoundingClientRect();
			if (inner.left < outer.left) strip.scrollLeft -= outer.left - inner.left;
			else if (inner.right > outer.right) strip.scrollLeft += inner.right - outer.right;
		});
		observer.observe(tab);
		return () => observer.disconnect();
	}, [active, tabs.length]);
	// 主窗口卡片顶行的标签和右端的按钮；弹出的窗口不画标签，见下面 `detached` 那一支。
	const heading = (
		<>
			{/* 不撑满：标签后面的空白留给拖窗口。 */}
			<div data-panel-heading="" className={`flex min-w-0 items-center gap-0.5 ${NO_DRAG}`}>
				<Sideways trackRef={track} role="tablist" aria-label={t("pane.tabs")} className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
					{tabs.map((tab) => {
						const panel = panels.find((entry) => entry.key === tab.panel);
						const Icon = panel ? (panel.icon ?? PanelRight) : Compass;
						const label = panel ? (tab.title ?? localized(panel.title, resolvedLocale)) : t("panel.start");
						return (
							<ClosableTab
								key={tab.id}
								data-panel-tab={tab.panel ?? "start"}
								data-panel-tab-id={tab.id}
								current={tab.id === active}
								onSelect={() => selectTab(tab.id, scope)}
								onClose={() => void closeTab(tab.id, scope)}
								closeLabel={t("pane.closeOne", { label })}
							>
								<span className="flex items-center gap-1.5">
									<TabIcon tab={tab} icon={<Icon size={13} />} />
									<span className="max-w-40 truncate">{label}</span>
								</span>
							</ClosableTab>
						);
					})}
				</Sideways>
				{addable.length > 0 && (
					<IconButton
						size="sm"
						data-panel-add=""
						label={t("pane.addTab")}
						menu={addMenu.open}
						icon={<Plus size={13} strokeWidth={2} />}
						onClick={addMenu.toggle}
					/>
				)}
				{addMenu.open && addable.length > 0 && (
					<PanelAddMenu
						anchor={addMenu.anchor}
						panels={listedPanels}
						openedKeys={openedKeys}
						onClose={addMenu.close}
						onSelect={(key) => {
							addMenu.close();
							addPanelTab(key, scope);
						}}
					/>
				)}
			</div>
			<div className={`ml-auto flex shrink-0 items-center gap-0.5 ${NO_DRAG}`}>
				{current && definition?.detachable && scope && (
					<IconButton size="xs" label={t("pane.openInNewWindow")} icon={<SquareArrowOutUpRight size={12} />} onClick={() => void popOutTab(current, scope)} />
				)}
				{!compact && (
					<IconButton
						size="xs"
						label={t(maximized ? "pane.exitFullScreen" : "common.fullScreen")}
						icon={maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
						onClick={() => update({ panelMaximized: { ...app.panelMaximized, [scope]: !maximized } })}
					/>
				)}
				{/* 横排、独占时收起按钮是工作区右上角那颗开关（PanelToggle），盖在这一行右端；上下排时面板区在下面，自己带一颗。 */}
				{stacked && <IconButton label={t("panel.hide")} icon={<PanelIcon />} onClick={() => togglePanel(false, scope)} />}
			</div>
		</>
	);
	const content = (
		<div data-panel-content="" className="relative min-h-0 flex-1 origin-top-left">
			{current && !current.panel && (
				<div data-panel="start" className="absolute inset-0 overflow-auto">
					<PanelStart panels={available.filter((entry) => entry.listed)} onLaunch={(key) => launch(current.id, key, scope)} />
				</div>
			)}
			{detached && current && definition && (
				<div data-panel={definition.key} className="absolute inset-0 overflow-auto">
					<PanelContents panel={definition} tab={current} scope={scope} shown />
				</div>
			)}
		</div>
	);
	if (detached) {
		// 独立窗口和会话窗口一样没有卡片：标题栏贴着窗口顶，写面板的名字，右边是置顶和收回，内容铺满。
		const title = current ? (definition ? (current.title ?? localized(definition.title, resolvedLocale)) : t("panel.start")) : "";
		const chrome = (
			<>
				<span data-panel-window-title="" className="min-w-0 flex-1 truncate text-label font-semibold text-ink select-none">
					{title}
				</span>
				<div className={`ml-auto flex shrink-0 items-center gap-0.5 ${NO_DRAG}`}>
					<KeepOnTopButton keepOnTop={window.plume.panelWindows.keepOnTop} />
					<ToolbarButton
						label={t("pane.dockBack")}
						onClick={() => {
							try {
								flushChildDrafts();
								void window.plume.panelWindows.dock();
							} catch {
								notify(t("pane.openFailed"), "error");
							}
						}}
					>
						<span data-panel-dock-back="" className="flex items-center justify-center">
							<AppWindow size={13} strokeWidth={1.9} />
						</span>
					</ToolbarButton>
				</div>
			</>
		);
		const start = (titlebar?.start ?? 0) + 10;
		return HEADER_BAR ? (
			<>
				{/* Windows、Linux：标题和按钮放进顶上那条带子，和系统按钮同一行。 */}
				<WindowHeader fill={managedSkin ? "bg-root" : "bg-sidebar"} insets={{ start, end: (titlebar?.end ?? 0) + 8 }}>
					<div data-panel-window-chrome="" className="flex min-w-0 flex-1 items-center">
						{chrome}
					</div>
				</WindowHeader>
				{content}
			</>
		) : (
			<>
				{/* macOS：标题栏就是窗口的顶行，红绿灯在它里面居中（主进程把灯摆在这一行）。 */}
				<header data-panel-window-chrome="" className={`flex shrink-0 items-center pr-2 ${DRAG}`} style={{ height: TOP_ROW_HEIGHT, paddingLeft: start }}>
					{chrome}
				</header>
				{content}
			</>
		);
	}
	return (
		<PanelSurface layout={`${arrangement}:${maximized}`} contentId={`panel-content:${active}`}>
			<header
				data-toolbar-inset=""
				className={`relative flex shrink-0 items-center gap-1 will-change-transform ${stacked ? "pr-1.5" : PANEL_TOGGLE_ROOM} ${CARD_DRAG}`}
				style={{ height: MAIN_TOOLBAR_HEIGHT, paddingLeft: underToolbar ? Math.max(10, overlap) : 10 }}
			>
				{/*
				 * 横排时左端竖一小截线，和下面对话、面板区之间那道分隔线在同一列，把顶上这一条分成对话、面板两段（侧栏那一道见 SidebarTopRow）。
				 * Windows、Linux 上这一行是卡片里的第一行：底下横一道线和身子隔开，竖的那道由下面的 `data-panel-body-divider` 从顶通到底。
				 */}
				{arrangement === "row" && !HEADER_BAR && (
					<span aria-hidden data-panel-divider="" className="absolute top-1/2 left-0 h-5 w-px -translate-y-1/2 bg-line-float" />
				)}
				{heading}
				{HEADER_BAR && <span aria-hidden data-title-divider="" className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line-float" />}
			</header>
			{/* 标签行在身子上面，和对话的标题栏连成窗口顶上的一条。身子透明，外沿是底下那一块画的；横排时那道 1px 分隔线画在下面单独的细条上，避免把整块身子并进全高合成层。 */}
			<div data-frame-body="" className="relative flex min-h-0 flex-1 flex-col overflow-hidden border border-transparent">
				<FrameRound>{content}</FrameRound>
			</div>
			<span
				aria-hidden
				data-panel-body-divider=""
				className="pointer-events-none absolute bottom-0 left-0 z-10 hidden w-px bg-line-float will-change-transform"
				style={{ top: HEADER_BAR ? 0 : MAIN_TOOLBAR_HEIGHT }}
			/>
		</PanelSurface>
	);
}

/** 后台标签也订阅自己的会话，不能借用窗口当前会话的视图。 */
function usePanelSession(scope: string): SessionView | undefined {
	const current = useAppPick((app) => (scope === app.currentId ? app.view : undefined));
	const currentId = useAppPick((app) => app.currentId);
	const live = useLiveSession(scope && scope !== currentId ? scope : undefined);
	return scope === currentId ? current : scope ? (live ?? parked.get(scope)) : undefined;
}

/** 同 `usePanelSession`，只取摘要：屏上那个会话的摘要在草稿、输出变化时不换引用。 */
function usePanelSummary(scope: string): SessionSummary | undefined {
	const current = useAppPick((app) => (scope === app.currentId ? app.view?.summary : undefined));
	const currentId = useAppPick((app) => app.currentId);
	const live = useLiveSession(scope && scope !== currentId ? scope : undefined);
	return scope === currentId ? current : scope ? (live ?? parked.get(scope))?.summary : undefined;
}

function panelCwd(app: Chrome, scope: string, session?: SessionSummary): string | undefined {
	const summary = session ?? app.sessions.find((entry) => entry.id === scope);
	if (summary) return summary.cwd ?? app.projects.find((entry) => entry.id === summary.project)?.path;
	if (scope) return undefined;
	const target = app.target;
	return app.projects.find((entry) => entry.id === target.project)?.path ?? target.cwd;
}

/** 恢复文件时只保存路径，仍由 agent 按原会话的工作目录校验并读内容。 */
// 面板区滑动、侧栏开合时外层每一帧都换尺寸：内容只跟这几样和自己订阅的状态走，不跟着每帧重画（终端、浏览器这些插件面板不便宜）。
const PanelContents = memo(function PanelContents({ panel, tab, scope, shown }: { panel: PanelEntry; tab: PanelTab; scope: string; shown: boolean }) {
	const app = useChrome();
	const view = usePanelSession(scope);
	const hasView = useAppPick((current) => current.view !== undefined);
	const cwd = panelCwd(app, scope, view?.summary);
	const [restoring, setRestoring] = useState(Boolean(tab.file && !fileOf(tab.id).path));
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!tab.file || fileOf(tab.id).path) return;
		let gone = false;
		void openFileIn(tab.id, tab.file.sessionId, tab.file.path).then((ok) => {
			if (!gone) {
				setFailed(!ok);
				setRestoring(false);
			}
		});
		return () => {
			gone = true;
		};
	}, [tab.id, tab.file]);
	if (panelWindow && !hasView) return <p className="p-6 text-detail text-ink-muted">{translate("common.loadingShort")}</p>;
	if (restoring) return <p className="p-6 text-detail text-ink-muted">{translate("common.loadingShort")}</p>;
	if (failed) return <p className="p-6 text-detail text-danger">{translate("filePanel.unreadable")}</p>;
	return (
		<PanelSlot
			panel={panel}
			owner={tab.sessionId}
			props={{ ...(view ? { session: view } : {}), ...(cwd ? { cwd } : {}), tab: tab.id, shown, ...handlesOf(tab.id) }}
		/>
	);
});

/** 取快捷键的尾键（小写），给「+」菜单打开时的单键直达用。 */
function panelShortcutKey(shortcut: string | undefined): string | undefined {
	const tail = shortcut?.split("+").at(-1)?.trim().toLowerCase();
	return tail || undefined;
}

/**
 * 「+」弹出的面板菜单：图标、名字、快捷键；单实例已打开的面板灰显不可重复添加。
 * 打开时支持方向键 / Home / End 在可用项之间切换焦点，以及直接按对应面板快捷键的尾键打开。
 */
function PanelAddMenu({
	anchor,
	panels,
	openedKeys,
	onClose,
	onSelect,
}: {
	anchor: HTMLElement | { x: number; y: number } | null;
	panels: readonly PanelEntry[];
	openedKeys: ReadonlySet<string>;
	onClose: () => void;
	onSelect: (key: string) => void;
}) {
	const { t, resolvedLocale } = useI18n();
	const listRef = useRef<HTMLDivElement>(null);
	const restoreFocus = useRef(false);
	const latest = useRef({ panels, openedKeys, onSelect });
	latest.current = { panels, openedKeys, onSelect };

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || composingKey(event)) return;
			if (event.key === "Escape") {
				restoreFocus.current = true;
				return;
			}
			const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
			if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
				if (items.length === 0) return;
				event.preventDefault();
				event.stopPropagation();
				const current = document.activeElement instanceof HTMLButtonElement ? items.indexOf(document.activeElement) : -1;
				const next =
					event.key === "Home"
						? 0
						: event.key === "End"
							? items.length - 1
							: event.key === "ArrowDown"
								? (current + 1) % items.length
								: current <= 0
									? items.length - 1
									: current - 1;
				items[next]?.focus();
				return;
			}
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const pressed = shortcutLetter(event) ?? event.key.toLowerCase();
			if (!pressed) return;
			const { panels: currentPanels, openedKeys: opened, onSelect: pick } = latest.current;
			const match = currentPanels.find((panel) => (panel.multiple || !opened.has(panel.key)) && panelShortcutKey(panel.shortcut) === pressed);
			if (!match) return;
			event.preventDefault();
			event.stopPropagation();
			pick(match.key);
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, []);

	return (
		<Popover
			anchor={anchor}
			onClose={() => {
				onClose();
				if (restoreFocus.current && anchor instanceof HTMLElement && anchor.isConnected) anchor.focus();
			}}
			placement="bottom"
			align="start"
			width="default"
			maxHeight={MENU_MAX_HEIGHT}
			label={t("pane.addTab")}
		>
			<MenuBody insetIcons>
				<div ref={listRef}>
					{panels.map((panel) => {
						const Icon = panel.icon ?? PanelRight;
						const title = localized(panel.title, resolvedLocale);
						const description = panel.description && localized(panel.description, resolvedLocale);
						const disabled = !panel.multiple && openedKeys.has(panel.key);
						return (
							<MenuItem
								key={panel.key}
								data-panel-launch={panel.key}
								icon={<Icon size={15} />}
								hint={panel.shortcut ? acceleratorLabel(panel.shortcut) : undefined}
								title={disabled ? undefined : description}
								disabled={disabled}
								className="focus-visible:bg-card-hover"
								onClick={() => onSelect(panel.key)}
							>
								{title}
							</MenuItem>
						);
					})}
				</div>
			</MenuBody>
		</Popover>
	);
}

/** 开始页列到这么多个以上，面板够宽时分两列；少的时候分两列会空出半行。 */
const PANEL_START_TWO_COLUMNS = 6;

/**
 * 开始页：所有面板列在一张卡片里，一项一行，图标、名字、一句说明，有快捷键的写在右边。点一行这个标签就变成那个面板。
 * 内容放得下时上下居中；放不下时贴顶往下滚——`justify-center` 溢出时顶上那截滚不到，所以用 `my-auto`。
 */
function PanelStart({ panels, onLaunch }: { panels: readonly PanelEntry[]; onLaunch: (key: string) => void }) {
	const { t, resolvedLocale } = useI18n();
	const many = panels.length > PANEL_START_TWO_COLUMNS;
	return (
		<div className="@container flex min-h-full flex-col px-5 py-8">
			<div className={`mx-auto my-auto flex w-full max-w-[400px] flex-col items-center gap-3.5 ${many ? "@lg:max-w-[640px]" : ""}`}>
				<div className={`flex items-center text-detail text-ink-faint ${many ? "gap-1.5" : "flex-col gap-2"}`}>
					<Compass size={many ? 14 : 28} strokeWidth={many ? 2 : 1.4} aria-hidden />
					<span>{t("panel.startHeading")}</span>
				</div>
				<div className="w-full overflow-hidden rounded-panel border border-line bg-card">
					{/* 每项自带底线，整列往下挪 1px 让最后一行的底线藏到卡片边框底下。 */}
					<ul className={`-mb-px grid grid-cols-1 ${many ? "@lg:grid-cols-2" : ""}`}>
						{panels.map((panel) => {
							const Icon = panel.icon ?? PanelRight;
							const title = localized(panel.title, resolvedLocale);
							const description = panel.description && localized(panel.description, resolvedLocale);
							return (
								<li key={panel.key} className={`min-w-0 border-b border-line-soft ${many ? "@lg:odd:border-r" : ""}`}>
									<button
										type="button"
										data-panel-launch={panel.key}
										title={description ? `${title}\n${description}` : title}
										onClick={() => onLaunch(panel.key)}
										className="flex h-full w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-[var(--plume-t-quick)] hover:bg-card-hover active:bg-elevated"
									>
										<span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-dim text-accent">
											<Icon size={16} />
										</span>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate text-label text-ink">{title}</span>
											{description && <span className="truncate text-caption text-ink-muted">{description}</span>}
										</span>
										{panel.shortcut && (
											<span className="flex shrink-0 gap-0.5">
												{panel.shortcut.split("+").map((part) => (
													<kbd
														key={part}
														className="grid h-5 min-w-5 place-items-center rounded-md border border-b-2 border-line px-1 font-sans text-caption text-ink-muted"
													>
														{acceleratorLabel(part)}
													</kbd>
												))}
											</span>
										)}
									</button>
								</li>
							);
						})}
					</ul>
				</div>
			</div>
		</div>
	);
}

export function ProjectFiles(props: PanelProps) {
	const { projects } = useChrome();
	return <FileBrowser {...props} projects={projects} />;
}

export function ProjectFilePanel(props: PanelProps) {
	return <FilePanel {...props} projects={useAppPick((current) => current.projects)} />;
}
