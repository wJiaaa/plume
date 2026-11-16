/**
 * 产品界面：侧栏列会话、底部显示当前模型，正文卡片里画对话（流式草稿、工具卡片、审批）。
 * 所有状态都在 agent 进程里，这里只订阅它推来的事件、把用户的操作转成 AgentService 调用。
 * 工具卡片和审批卡先给插件画（见 plugins.tsx），没有插件注册的用这里的通用卡片。
 * 右边的面板区是产品的，里面每个面板都由插件注册；没有插件注册面板时，面板区和它的开关都不出现。
 */

import type { SessionSummary } from "@plume/contract";
import { composingKey, macKeyboard, shortcutLetter, useI18n } from "@plume/ui";
import { AppWindow } from "@plume/ui/icons";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CARD_INSET, MAIN_TOOLBAR_HEIGHT, TOP_ROW_HEIGHT } from "../shared/window-chrome.ts";
import { useTitlebar } from "./titlebar.ts";
import { layoutMode, RAIL_WIDTH, sidebarWidthFor } from "./layout.ts";
import { ImageViewerHost } from "./image/index.ts";
import { Toaster } from "./toast/index.ts";
import { InputMenu } from "./composer/InputMenu.tsx";
import { useManagedSkin } from "./appearance-settings.ts";
import { checkPanels, listPages, listPanels, matchesShortcut, PageSlot, pageToolbar, usePluginUis } from "./plugins.tsx";
import { MarketScreen } from "./market/market.tsx";
import { NavButtons, SidebarIcon, ToolbarButton, ToolbarOverlap, toolbarReserved, WindowHeader } from "./window-controls.tsx";
import { nextTurnCwd, panelWindow, sessionWindow, state, update, useAppPick, useChrome } from "./app/state.ts";
import { DRAG, HEADER_BAR, NO_DRAG, SLIDE_MOTION } from "./app/shell-classes.ts";
import { finishPanelLeave, panelOpenIn, scopeOf, setPanel, setSidebar, showPanel, tabsOf, togglePanel } from "./app/panels.ts";
import { canStep, go, openNoticeSession } from "./app/sessions.ts";
import { KeepOnTopButton, PanelArea } from "./app/PanelArea.tsx";
import { investigate, openSettingsSection, tryPrompt } from "./app/actions.ts";
import { SidebarContent, SidebarResizer, SidebarTopRow } from "./app/Sidebar.tsx";
import { hasSidebar, Rail } from "./app/Rail.tsx";
import { ChatScreen, CurrentChat, CurrentSessionToolbar, pageProps, ScreenCard, TitleBar } from "./app/Chat.tsx";
import { SettingsScreen } from "./app/SettingsScreen.tsx";

export function App() {
	return (
		<>
			{sessionWindow ? <SessionWindowShell /> : <Shell />}
			{/* 文字框的右键菜单整个窗口一份，主窗口、会话窗口、面板窗口都有。 */}
			<InputMenu />
		</>
	);
}

function Shell() {
	const { t } = useI18n();
	const managedSkin = useManagedSkin();
	const app = useChrome();
	const { fatal, fullScreen, windowWidth, sidebarOpen, sidebarWidth, drawerOpen, screen, panelWidth } = app;
	const [verticalShares, setVerticalShares] = useState<Record<string, number>>({});
	const compact = layoutMode(windowWidth) === "compact";
	// 窗口回到前台重问已知目录：终端里可能刚执行过 git init。当前会话的目录与轮次变化由 PanelArea 处理。
	useEffect(() => {
		const recheck = () => void checkPanels();
		window.addEventListener("focus", recheck);
		return () => window.removeEventListener("focus", recheck);
	}, []);
	// 插件市场和插件的页面没有侧栏：侧栏开没开的偏好留着，回到对话、设置时照旧。切过去不滑，整个界面一下换掉。
	const sided = hasSidebar(screen);
	const navOpen = (compact ? drawerOpen : sidebarOpen) && sided;
	const pushed = !compact && sidebarOpen && sided;
	const drawerWidth = Math.min(sidebarWidth, windowWidth - RAIL_WIDTH - 48);
	const width = sidebarWidthFor(sidebarWidth, windowWidth);
	const titlebar = useTitlebar(window.plume.platform, fullScreen);
	// 面板只跟着工作区，设置页不画。工作区里收起时也挂着，只是藏起来：面板里的状态留着，开合才有东西可滑。
	// 插件运行中装卸时面板跟着出现、消失。
	usePluginUis();
	const panelInWorkspace = screen === "chat" && listPanels().length > 0;
	// 插件的页面放在后退、前进后面的按钮（`ui.usePageToolbar`）；页面没有侧栏，和侧栏开关不会同时出现。
	const pageTools = screen.startsWith("page:") ? pageToolbar(screen.slice("page:".length)) : undefined;
	/*
	 * 侧栏收起时红绿灯和前进、后退浮在卡片左上角，顶行从它们右边开始放东西（`ToolbarOverlap`，卡片里的顶行取用）；
	 * 有顶上那条带子时它们在带子里，卡片不用让。开合时它和侧栏宽度一起滑，见 styles.css 的 `[data-sidebar-sliding]`。
	 */
	const overlap = pushed || HEADER_BAR ? 0 : Math.max(0, toolbarReserved(titlebar.start, (sided ? 1 : 0) + (pageTools?.buttons.length ?? 0)) - RAIL_WIDTH - 1);
	const available = windowWidth - RAIL_WIDTH - (pushed ? width : 0);
	useLayoutEffect(() => {
		if (!panelWindow && panelWidth === 0) setPanel({ width: available * 0.4 });
	}, [available, panelWidth]);
	useEffect(() => {
		if (!app.panelLeaving) return;
		// 减少动态效果、切页或窗口缩放可能取消 transitionend，资源仍必须收掉。
		const token = getComputedStyle(document.documentElement).getPropertyValue("--plume-t-slow").trim();
		const duration = parseFloat(token) * (token.endsWith("ms") ? 1 : 1000);
		const timer = setTimeout(finishPanelLeave, Number.isFinite(duration) ? duration + 50 : 0);
		return () => clearTimeout(timer);
	}, [app.panelLeaving]);
	// 只在点开关的那一下加动画，动画结束就撤掉，见 SLIDE_MOTION。
	const [moving, setMoving] = useState(false);

	const toggle = () => {
		if (!sided) return;
		setMoving(true);
		if (compact) update({ drawerOpen: !drawerOpen });
		else setSidebar({ open: !sidebarOpen });
	};

	// ⌘B 开合侧栏，设置页里开合的是章节列表；没有侧栏的界面不接，留给页面自己。
	useEffect(() => {
		if (panelWindow) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.repeat || composingKey(event)) return;
			if (sided && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && shortcutLetter(event) === "b") {
				event.preventDefault();
				toggle();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	/*
	 * 后退、前进：macOS 上 ⌘[ ⌘]，别处 Alt+← Alt+→，还有鼠标的侧键。打字时不接：在输入框里这些键归输入框，
	 * 选个词就离开了正在写的会话会丢掉位置。
	 */
	useEffect(() => {
		if (panelWindow) return;
		const mac = macKeyboard();
		const typing = (target: EventTarget | null) =>
			target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA");
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.repeat || typing(event.target)) return;
			const back = mac
				? event.metaKey && !event.altKey && !event.shiftKey && event.code === "BracketLeft"
				: event.altKey && !event.ctrlKey && event.key === "ArrowLeft";
			const forward = mac
				? event.metaKey && !event.altKey && !event.shiftKey && event.code === "BracketRight"
				: event.altKey && !event.ctrlKey && event.key === "ArrowRight";
			if (!back && !forward) return;
			event.preventDefault();
			void go(back ? -1 : 1);
		};
		// 3、4 是鼠标侧键；在 mouseup 上接，按下本身不拦。
		const onMouse = (event: MouseEvent) => {
			if (event.button !== 3 && event.button !== 4) return;
			event.preventDefault();
			void go(event.button === 3 ? -1 : 1);
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("mouseup", onMouse);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mouseup", onMouse);
		};
	}, []);

	useEffect(() => {
		if (!compact || !navOpen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") update({ drawerOpen: false });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [compact, navOpen]);

	/*
	 * 面板的快捷键：没开或在看别的就切到它，正在看它就收起面板区。在捕获阶段接：焦点在终端里时，xterm 会
	 * 把按键吃掉、不再冒泡，而从终端里按同一个键收起它正是最常用的那一下。
	 */
	useEffect(() => {
		if (panelWindow || !panelInWorkspace) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.repeat || composingKey(event)) return;
			const panel = listPanels(nextTurnCwd(state, state.view?.summary), state.currentId !== undefined).find(
				(entry) => entry.shortcut && matchesShortcut(event, entry.shortcut),
			);
			if (!panel) return;
			event.preventDefault();
			event.stopPropagation();
			const { tabs, active } = tabsOf(state);
			if (panelOpenIn(state) && tabs.find((tab) => tab.id === active)?.panel === panel.key) togglePanel(false);
			else showPanel(panel.key);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [panelInWorkspace]);

	if (panelWindow)
		return (
			<div className="plume-panel flex h-full flex-col bg-shell">
				<PanelArea detached titlebar={titlebar} />
				<ImageViewerHost />
				<Toaster onInvestigate={investigate} />
			</div>
		);

	const toolbar = (
		<>
			<NavButtons
				labels={{ back: t("toolbar.back"), forward: t("toolbar.forward") }}
				canBack={canStep(app, -1)}
				canForward={canStep(app, 1)}
				onBack={() => void go(-1)}
				onForward={() => void go(1)}
			/>
			{sided && (
				<ToolbarButton
					label={
						screen === "settings"
							? t(navOpen ? "app.hideSettingsNavigation" : "app.showSettingsNavigation", { shortcut: "⌘B" })
							: t(navOpen ? "shell.hideSidebar" : "shell.showSidebar")
					}
					onClick={toggle}
					active={compact && navOpen}
				>
					<SidebarIcon open={navOpen} />
				</ToolbarButton>
			)}
			{pageTools?.buttons.map(({ id, label, icon: Icon }) => (
				<ToolbarButton key={id} label={label} onClick={() => pageTools.click(id)}>
					<Icon size={15} strokeWidth={1.9} />
				</ToolbarButton>
			))}
		</>
	);

	const body = (
		<ToolbarOverlap.Provider value={overlap}>
			{/*
			 * 侧栏、对话、面板区底下那一整块：外沿的圆角描边和对话的底色只由它画，各栏的身子透明（侧栏只在里面铺自己的底色）。
			 * 外沿交给不随开合变的一层：侧栏收起时最后露出来的是对话的身子，它滑着时为了和侧栏拼平是直角，滑完才圆回来；
			 * 身子自己画外沿的话，左上角会在滑完那一下从直角跳成圆角。
			 */}
			<div
				aria-hidden
				data-frame=""
				className="pointer-events-none absolute rounded-panel border border-line-float bg-shell"
				style={{ left: RAIL_WIDTH, top: MAIN_TOOLBAR_HEIGHT, right: CARD_INSET, bottom: CARD_INSET }}
			/>
			<Rail />
			{/*
			 * 抽屉从活动栏右边抽出来：外面这层裁掉收着的那一截，抽屉不从活动栏底下滑过；收着时整层不接指针，点得到下面的卡片。
			 * 宽窗口里这层是 `contents`，不占盒子：两种形状同一棵树，窗口跨过分档时侧栏不重挂。
			 */}
			<div
				className={compact ? "pointer-events-none absolute inset-y-0 z-20 overflow-hidden" : "contents"}
				style={compact ? { left: RAIL_WIDTH, width: drawerWidth } : undefined}
			>
				<aside
					aria-label={t("app.sidebar")}
					inert={!navOpen}
					// 抽屉自己铺侧栏色，吸顶的标题跟着它，不跟外圈（styles.css 的 `[data-plume-head]`）。
					data-plume-drawer={compact || undefined}
					// 只认侧栏自己的：里面的行悬停也有 transition，结束事件会冒泡上来。
					onTransitionEnd={(event) => event.target === event.currentTarget && setMoving(false)}
					className={`${moving ? `${SLIDE_MOTION} duration-[var(--plume-t-slow)]` : ""} ${
						compact
							? `sidebar-surface pointer-events-auto absolute inset-y-0 left-0 border-r border-line ${navOpen ? "" : "-translate-x-full"}`
							: "relative shrink-0 overflow-hidden"
					}`}
					style={{ width: compact ? drawerWidth : pushed ? width : 0 }}
				>
					{/*
					 * 里面定宽：收起时只是被裁掉，文字不跟着宽度一起挤。停靠时侧栏是底下那一块（`data-frame`）的左边一截：
					 * 上、左、下的描边透明、底色不铺到描边下面，透出那一块的外沿；右边那道描边就是两栏之间的分隔线。
					 * 底色比窗口外圈亮一档（`.sidebar-surface`），会话列表不和窗口底色糊成一片。抽屉整条铺同一个底色。
					 */}
					<div className="flex h-full flex-col" style={{ width: compact ? drawerWidth : width }}>
						<SidebarTopRow divider={!compact && !moving} />
						<div
							className={`flex min-h-0 flex-1 flex-col ${compact ? "" : "sidebar-surface overflow-hidden rounded-l-panel border border-transparent border-r-line-float bg-clip-padding"}`}
							style={compact ? undefined : { marginBottom: CARD_INSET }}
						>
							<SidebarContent />
						</div>
					</div>
				</aside>
			</div>
			{compact && navOpen && <div className="absolute inset-0 z-10 bg-ink/20" aria-hidden onClick={() => update({ drawerOpen: false })} />}
			{/*
			 * 工作区贴着活动栏、侧栏和窗口顶，只离窗口右边、底边 4px。侧栏停靠着（收起滑走的那一路也算）时身子的左边不圆、不描边，
			 * 和侧栏连成一块；滑完收起才圆回来，不在半路豁开一个角。
			 */}
			<div
				data-frame-left={pushed || (moving && !compact) || undefined}
				className="relative isolate min-h-0 min-w-0 flex-1 overflow-hidden"
				style={{ marginRight: CARD_INSET, marginBottom: CARD_INSET }}
			>
				{/* 设置页只盖住工作区，常驻网页仍留在同一层、同一节点。 */}
				<div inert={screen !== "chat"} className={`absolute inset-0 flex ${screen === "chat" ? "" : "invisible"}`}>
					<ChatScreen
						fatal={fatal}
						slideWidth={moving && !compact ? available - CARD_INSET : undefined}
						share={verticalShares[scopeOf(app)] ?? 0.4}
						onShare={(share) => setVerticalShares((current) => ({ ...current, [scopeOf(app)]: share }))}
					/>
				</div>
				{screen !== "chat" && (
					<main className="absolute inset-0 flex flex-col">
						<ScreenCard header={<TitleBar />} fatal={fatal}>
							<Main />
						</ScreenCard>
					</main>
				)}
			</div>
			{pushed && <SidebarResizer width={width} max={sidebarWidthFor(Number.POSITIVE_INFINITY, windowWidth)} />}
		</ToolbarOverlap.Provider>
	);
	/*
	 * 窗口外圈（活动栏、顶上那一条）不开毛玻璃时和对话同一个底色，底下那一块靠描边和外圈分开；侧栏一栏比两边都亮一档。
	 * 外圈铺侧栏色时它比侧栏还亮，会话列表夹在外圈和对话中间、不上不下，看着发灰。
	 */
	const fill = managedSkin ? "bg-root" : window.plume.vibrancy ? "bg-window-tint" : "bg-shell";

	/*
	 * Windows、Linux：顶上一条横贯的带子，后退、前进、侧栏开关在左端，系统按钮在右端，侧栏和卡片都在它下面。
	 * 带子自己就是拖拽区，下面不再铺设置页的拖拽条，也没有浮在卡片角上的按钮。
	 */
	if (HEADER_BAR)
		return (
			<div className={`flex h-full flex-col overflow-hidden ${fill}`} data-plume-head-fill={managedSkin ? "root" : "window"}>
				<WindowHeader fill={managedSkin ? "bg-root" : "bg-sidebar"} insets={titlebar}>
					<div className={`flex items-center gap-0.5 ${NO_DRAG}`}>{toolbar}</div>
				</WindowHeader>
				<div className="relative flex min-h-0 flex-1 overflow-hidden">
					{body}
					<ImageViewerHost />
					<Toaster onInvestigate={investigate} onOpenSession={openNoticeSession} />
				</div>
			</div>
		);

	return (
		<div
			className={`relative flex h-full overflow-hidden ${fill}`}
			data-sidebar-sliding={(moving && !compact) || undefined}
			// 停靠的侧栏透明，吸顶的标题要铺和这一层一样的底（styles.css 的 `[data-plume-head]`）。
			data-plume-head-fill={managedSkin ? "root" : "window"}
		>
			{body}
			{/* 设置页顶上整条都能拖窗口，连同卡片上方和侧栏、卡片之间的缝。放在侧栏开关前面：拖拽区按文档顺序合成，开关的洞要后挖。 */}
			{screen === "settings" && <div aria-hidden className={`absolute inset-x-0 top-0 z-30 ${DRAG}`} style={{ height: MAIN_TOOLBAR_HEIGHT }} />}
			<div className={`absolute z-30 flex items-center gap-0.5 ${NO_DRAG}`} style={{ left: titlebar.start, top: 0, height: MAIN_TOOLBAR_HEIGHT }}>
				{toolbar}
			</div>
			<ImageViewerHost />
			<Toaster onInvestigate={investigate} onOpenSession={openNoticeSession} />
		</div>
	);
}

/**
 * 会话窗口：只有这一段对话。侧栏和面板区都留在主窗口，这里剩下标题、转录、输入框和一条回去的路；
 * 要开的面板交给主窗口（见 `showPanel`）。它是一份文档，不是第二个工作区：整面是对话的底色，没有浮起的卡片，
 * 标题栏贴着窗口顶。
 */
function SessionWindowShell() {
	const { t } = useI18n();
	const managedSkin = useManagedSkin();
	const { fatal, fullScreen, sessions } = useChrome();
	// 视图只交给对话和会话的工具栏；窗口外壳只要摘要，草稿每一拍换视图时它不跟着重画。
	const current = useAppPick((app) => app.view?.summary);
	const titlebar = useTitlebar(window.plume.platform, fullScreen);
	const title = current?.title || t("sessionOps.newSession");
	useEffect(() => {
		document.title = title;
	}, [title]);
	// 会话被删了，或者刚在别处归档：这个窗口只为它而开，没有东西可显示了。本来就归档的（从归档页开出来看的）不赶人。
	const summary = sessions.find((session) => session.id === sessionWindow);
	const seen = useRef<SessionSummary>(undefined);
	useEffect(() => {
		const before = seen.current;
		seen.current = summary;
		if (before && (!summary || (summary.archived && !before.archived))) window.close();
	}, [summary]);
	const heading = (
		<>
			<span data-plume-screen-title="" className="min-w-0 flex-1 truncate text-label font-semibold text-ink select-none">
				{title}
			</span>
			<div className={`ml-auto flex shrink-0 items-center gap-0.5 ${NO_DRAG}`}>
				<CurrentSessionToolbar />
				<KeepOnTopButton keepOnTop={window.plume.sessionWindows.keepOnTop} />
				<ToolbarButton label={t("sessionMenu.openInMainWindow")} onClick={() => void window.plume.sessionWindows.openInMain()}>
					<span data-open-in-main="" className="flex items-center justify-center">
						<AppWindow size={13} strokeWidth={1.9} />
					</span>
				</ToolbarButton>
			</div>
		</>
	);
	return (
		<div className="flex h-full flex-col bg-shell">
			{/* Windows、Linux：标题和按钮放进顶上那条带子，和系统按钮同一行。 */}
			{HEADER_BAR && (
				<WindowHeader fill={managedSkin ? "bg-root" : "bg-sidebar"} insets={{ start: titlebar.start + 10, end: titlebar.end + 8 }}>
					<div data-session-window-chrome="" className="flex min-w-0 flex-1 items-center">
						{heading}
					</div>
				</WindowHeader>
			)}
			<main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
				{!HEADER_BAR && (
					<>
						{/* macOS：标题栏就是窗口的顶行，红绿灯在它里面居中（主进程的 `session-windows.ts` 把灯摆在这一行）。 */}
						<header
							data-session-window-chrome=""
							className={`absolute inset-x-0 top-0 z-10 flex items-center pr-2 ${DRAG}`}
							style={{ height: TOP_ROW_HEIGHT, paddingLeft: titlebar.start + 10 }}
						>
							{heading}
						</header>
						<div aria-hidden className="shrink-0" style={{ height: TOP_ROW_HEIGHT }} />
					</>
				)}
				{fatal && (
					<p className="bg-danger px-6 py-2 text-detail text-shell" role="alert">
						{fatal}
					</p>
				)}
				<div className="flex min-h-0 flex-1 flex-col" style={{ "--plume-top-row-height": `${HEADER_BAR ? 0 : TOP_ROW_HEIGHT}px` } as CSSProperties}>
					<CurrentChat />
				</div>
			</main>
			<ImageViewerHost />
			<Toaster />
		</div>
	);
}

/** 工作区以外的页面：设置、市场、插件的页面。对话由 `ChatScreen` 画。 */
function Main() {
	const { screen, target, projects } = useChrome();
	usePluginUis();
	const page = screen.startsWith("page:") ? listPages().find((entry) => `page:${entry.key}` === screen) : undefined;
	// 只有插件的页面要会话视图：停在设置、市场时，后台那个会话每输出一拍，这里不跟着重画。
	const view = useAppPick((current) => (current.screen.startsWith("page:") ? current.view : undefined));
	// 插件在它的页面上被停用、卸下：页面跟着没了，回到工作区，不留一块空白。
	const pageGone = screen.startsWith("page:") && !page;
	useEffect(() => {
		if (pageGone) update({ screen: "chat" });
	}, [pageGone]);
	if (screen === "settings") return <SettingsScreen />;
	if (screen === "market") return <MarketScreen onOpenSettings={openSettingsSection} onTry={tryPrompt} projects={projects} />;
	if (page) return <PageSlot key={page.key} page={page} props={pageProps(view, target)} />;
	return null;
}
