import type { SessionView } from "@plume/contract";
import type { PanelProps } from "@plume/contract/ui";
import { acceleratorLabel, ClosableTab, IconButton, ResizeHandle, Sideways, translate, useI18n } from "@plume/ui";
import { AppWindow, Compass, Maximize2, Minimize2, SquareArrowOutUpRight, PanelRight, Pin, PinOff, Plus } from "@plume/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PanelSurface } from "../panel-surface.tsx";
import { TOP_ROW_HEIGHT } from "../../shared/window-chrome.ts";
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
import { ToolbarButton, WindowHeader } from "../window-controls.tsx";
import { panelGeometry } from "../panel-layout.ts";
import { type Chrome, type PanelTab, type PanelTabs, panelWindow, state, update, useAppPick, useChrome } from "./state.ts";
import { closeTab, handlesOf, launch, openStartTab, popOutTab, scopeOf, selectTab, setPanel, tabsOf, togglePanel } from "./panels.ts";
import { CARD_DRAG, DRAG, HEADER_BAR, NO_DRAG } from "./shell-classes.ts";
import { parked } from "./sessions.ts";

/** 弹出去的标签不占这一屏的位置，当前标签移交给仍留在屏内的一个。 */
function panelGroup(app: Chrome, scope: string): PanelTabs {
	const group = tabsOf(app, scope);
	const tabs = group.tabs.filter((tab) => !app.panelWindows.some((entry) => entry.tab === tab.id));
	return { tabs, active: tabs.some((tab) => tab.id === group.active) ? group.active : (tabs.at(-1)?.id ?? "") };
}

export function panelLayout(app: Chrome, size: { width: number; height: number }, share: number) {
	const scope = scopeOf(app);
	const group = panelGroup(app, scope);
	const shown = listPanels().length > 0 && group.tabs.length > 0 && app.panelOpen;
	return {
		shown,
		...panelGeometry({
			...size,
			preferred: app.panelWidth,
			share,
			compact: layoutMode(app.windowWidth) === "compact",
			maximized: app.panelMaximized[scope] === true,
			shown,
		}),
	};
}

export const PANEL_MOTION = "transition-[right,bottom,width,height,translate] duration-[var(--plume-t-base)] ease-out";

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

export function PanelIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
			<rect x="2" y="3" width="12" height="10" rx="2" />
			<path d="M10 3v10" />
		</svg>
	);
}

/** 把手放在两张卡片的缝内，独立于面板的溢出裁切。 */
export function PanelResizer({ width, windowWidth, max }: { width: number; windowWidth: number; max: number }) {
	const { t } = useI18n();
	const resize = (next: number) => setPanel({ width: clamp(Math.round(next), PANEL_MIN, max) });
	return (
		<div className="absolute inset-y-0 w-0" style={{ left: windowWidth - width - 1 }}>
			<ResizeHandle edge="start" width={width} min={PANEL_MIN} max={max} onResize={resize} onReset={() => resize(windowWidth / 2)} label={t("panel.resize")} />
		</div>
	);
}

/** 内容按首次挂载的顺序追加，切换会话不能让 React 移动 webview 的 DOM。 */
export function PanelLayer({ layout }: { layout: ReturnType<typeof panelLayout> }) {
	const app = useChrome();
	usePluginUis();
	const found: { tab: PanelTab; scope: string; panel: PanelEntry }[] = [];
	for (const [scope, group] of Object.entries(app.panelTabs)) {
		for (const tab of group.tabs) {
			const panel = tab.panel ? panelEntry(tab.panel) : undefined;
			if (panel && !app.panelWindows.some((entry) => entry.tab === tab.id) && (panel.keepAlive || (app.screen === "chat" && scopeOf(app) === scope)))
				found.push({ tab, scope, panel });
		}
	}
	const order = useRef<string[]>([]);
	const ids = new Set(found.map(({ tab }) => tab.id));
	order.current = [...order.current.filter((id) => ids.has(id)), ...[...ids].filter((id) => !order.current.includes(id))];
	found.sort((a, b) => order.current.indexOf(a.tab.id) - order.current.indexOf(b.tab.id));
	return (
		<div className="contents" data-panel-kept="">
			{found.map(({ tab, scope, panel }) => (
				<PanelLayerTab key={tab.id} tab={tab} scope={scope} panel={panel} layout={layout} />
			))}
		</div>
	);
}

function PanelLayerTab({ tab, scope, panel, layout }: { tab: PanelTab; scope: string; panel: PanelEntry; layout: ReturnType<typeof panelLayout> }) {
	const app = useChrome();
	const current = scopeOf(app) === scope;
	// 后台标签保留最后的尺寸，切换会话不改变其内部布局。
	const last = useRef(layout);
	if (current) last.current = layout;
	const shown = current && layout.shown && app.screen === "chat" && panelGroup(app, scope).active === tab.id;
	const motion = app.panelMoving && current ? PANEL_MOTION : "";
	return (
		<div
			data-panel-layer={scope}
			data-panel-tab-id={tab.id}
			inert={!shown}
			className={`pointer-events-none absolute inset-0 overflow-hidden ${!shown && !(app.panelMoving && current && panelGroup(app, scope).active === tab.id) ? "invisible" : ""}`}
		>
			<div className={`plume-panel plume-freeze absolute ${motion}`} style={last.current.panel}>
				<div className="absolute inset-0 overflow-hidden rounded-panel">
					<div
						id={`panel-content:${tab.id}`}
						data-panel={panel.key}
						inert={!shown}
						className="plume-dock-pane pointer-events-auto absolute overflow-auto origin-top-left"
						style={{ top: TOP_ROW_HEIGHT + 1, left: 1, right: 1, bottom: 1 }}
					>
						<PanelContents panel={panel} tab={tab} scope={scope} shown={shown} />
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * 面板区：一张和正文一样的浮起卡片，顶上一排标签，每个开着的面板一个，后面的「+」开一个开始页标签。
 * 这个会话的标签都挂着，只有当前那个看得见：后台的终端、计划切回来不重来。右端收起面板区。
 */
export function PanelArea({
	scope = scopeOf(state),
	maximized = false,
	compact = false,
	inset,
	detached = false,
	titlebar,
	arrangement = "row",
}: {
	scope?: string;
	maximized?: boolean;
	compact?: boolean;
	inset?: number;
	detached?: boolean;
	/** 弹出的窗口顶行两端让给系统多少；Windows、Linux 上标题栏就画在窗口顶上那条带子里。 */
	titlebar?: TitlebarInsets;
	arrangement?: string;
}) {
	const { t, resolvedLocale } = useI18n();
	const app = useChrome();
	const managedSkin = useManagedSkin();
	usePluginUis();
	const panels = detached && panelWindow ? [panelEntry(panelWindow.panel)].filter((entry): entry is PanelEntry => Boolean(entry)) : listPanels();
	const view = usePanelSession(scope);
	const cwd = panelCwd(app, scope, view);
	const running = view?.summary.running ?? false;
	useLayoutEffect(() => setPanelScope(cwd, scope !== ""), [cwd, scope, running]);
	const available = listPanels(cwd, scope !== "");
	const group = tabsOf(app, scope, panels);
	const tabs = group.tabs.filter((tab) => !app.panelWindows.some((entry) => entry.tab === tab.id));
	const active = tabs.some((tab) => tab.id === group.active) ? group.active : tabs.at(-1)?.id;
	const current = tabs.find((tab) => tab.id === active);
	const definition = panels.find((entry) => entry.key === current?.panel);
	const track = useRef<HTMLDivElement>(null);
	const addable = available.filter((entry) => entry.listed && (entry.multiple || !tabs.some((tab) => tab.panel === entry.key)));
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
									<Icon size={13} className="shrink-0" />
									<span className="max-w-40 truncate">{label}</span>
								</span>
							</ClosableTab>
						);
					})}
				</Sideways>
				{addable.length > 0 && (
					<IconButton size="sm" data-panel-add="" label={t("pane.addTab")} icon={<Plus size={13} strokeWidth={2} />} onClick={() => openStartTab(scope)} />
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
				<IconButton label={t("panel.hide")} icon={<PanelIcon />} onClick={() => togglePanel(false, scope)} />
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
				className={`flex shrink-0 items-center gap-1 pl-2.5 pr-1.5 ${CARD_DRAG}`}
				style={{ height: TOP_ROW_HEIGHT, ...(inset === undefined ? {} : { paddingLeft: inset }) }}
			>
				{heading}
			</header>
			{content}
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

function panelCwd(app: Chrome, scope: string, view?: SessionView): string | undefined {
	const summary = view?.summary ?? app.sessions.find((entry) => entry.id === scope);
	if (summary) return summary.cwd ?? app.projects.find((entry) => entry.id === summary.project)?.path;
	if (scope) return undefined;
	const target = app.target;
	return app.projects.find((entry) => entry.id === target.project)?.path ?? target.cwd;
}

/** 恢复文件时只保存路径，仍由 agent 按原会话的工作目录校验并读内容。 */
function PanelContents({ panel, tab, scope, shown }: { panel: PanelEntry; tab: PanelTab; scope: string; shown: boolean }) {
	const app = useChrome();
	const view = usePanelSession(scope);
	const hasView = useAppPick((current) => current.view !== undefined);
	const cwd = panelCwd(app, scope, view);
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
