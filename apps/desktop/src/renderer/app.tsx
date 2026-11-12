/**
 * 产品界面：侧栏列会话、底部显示当前模型，正文卡片里画对话（流式草稿、工具卡片、审批）。
 * 所有状态都在 agent 进程里，这里只订阅它推来的事件、把用户的操作转成 AgentService 调用。
 * 工具卡片和审批卡先给插件画（见 plugins.tsx），没有插件注册的用这里的通用卡片。
 * 右边的面板区是产品的，里面每个面板都由插件注册；没有插件注册面板时，面板区和它的开关都不出现。
 */

import type {
	AgentEvent,
	AgentService,
	AssistantMessage,
	CommandExpansion,
	Message,
	OutgoingMessage,
	ProjectEntry,
	QueuedMessage,
	SessionSummary,
	SessionTarget,
	SessionView,
	SettingsView,
	UserMessage,
} from "@plume/contract";
import type { ConversationProps, PageProps, PanelProps } from "@plume/contract/ui";
import type { Remote } from "@plume/rpc";
import { type EditorView, keymap } from "@codemirror/view";
import {
	acceleratorLabel,
	ActionSpinner,
	Button,
	ClosableTab,
	composingKey,
	DURATION,
	ErrorBoundary,
	IconButton,
	macKeyboard,
	motionReduced,
	ResizeHandle,
	Scroller,
	formatList,
	shortcutLetter,
	Sideways,
	Splitter,
	touchWorkingTree,
	translate,
	useI18n,
	useConfirmer,
	usePopover,
} from "@plume/ui";
import {
	AppWindow,
	Compass,
	FileText,
	Folder,
	MoreHorizontal,
	Maximize2,
	Minimize2,
	SquareArrowOutUpRight,
	PanelRight,
	Pin,
	PinOff,
	Plus,
	SquarePen,
} from "@plume/ui/icons";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PanelWindowTarget } from "../shared/panel-window.ts";
import { PanelSurface } from "./panel-surface.tsx";
import { CARD_INSET, hasHeaderBar, ROW_OFFSET, TOP_ROW_HEIGHT } from "../shared/window-chrome.ts";
import { type TitlebarInsets, useTitlebar } from "./titlebar.ts";
import { Arrival, useArrival } from "./markdown/useSmoothText.ts";
import {
	clamp,
	layoutMode,
	PANEL_MIN,
	panelWidthFor,
	readPanelPrefs,
	readPanelTabs,
	readSidebarPrefs,
	SIDEBAR_DEFAULT,
	SIDEBAR_MIN,
	sidebarWidthFor,
	writePanelPrefs,
	writePanelTabs,
	writeSidebarPrefs,
} from "./layout.ts";
import { ChatBackdrop } from "./chat-backdrop.tsx";
import { ImageViewerHost } from "./image/index.ts";
import { notify, Toaster } from "./toast/index.ts";
import { ComposerSend, ComposerShell } from "./composer/index.ts";
import { useComposerAttachments } from "./composer/useComposerAttachments.tsx";
import { InputMenu } from "./composer/InputMenu.tsx";
import { parseInvocation, resolveCommand } from "./composer/commands.ts";
import { useMentions } from "./composer/useMentions.tsx";
import { withSessionReferences, type SessionReference } from "./composer/session-references.ts";
import { SessionReferences, sessionReferences, setSessionReferences, useSessionReferences } from "./composer/SessionReferences.tsx";
import { useCommands } from "./composer/useCommands.tsx";
import { useInputHistory } from "./composer/useInputHistory.ts";
import { useManagedSkin } from "./appearance-settings.ts";
import { QueuedMessages } from "./composer/QueuedMessages.tsx";
import { Transcript } from "./conversation/Transcript.tsx";
import type { MessageEdits } from "./conversation/message-edits.ts";
import type { TaskActions } from "./conversation/TaskStrip.tsx";
import { draftFromMessage, editedContent } from "./conversation/revert-draft.ts";
import type { DraftAttachment } from "./composer/attachments/read.ts";
import { type DraftQuote, withQuotes } from "./conversation/quote.ts";
import { QuoteChip } from "./composer/QuoteChip.tsx";
import { PermissionChip } from "./composer/PermissionPicker.tsx";
import { ProjectPicker } from "./composer/ProjectPicker.tsx";
import { conversationDescendants } from "./conversation/descendants.ts";
import { ApprovalOverlay } from "./conversation/ApprovalOverlay.tsx";
import { HandedOffStrip } from "./conversation/HandedOffStrip.tsx";
import { noteSessionDoing } from "./conversation/handed-off.ts";
import { Welcome } from "./composer/Welcome.tsx";
import { type ComposerSession, EffortTrigger, ModelTrigger } from "./models/index.ts";
import { effectiveModel } from "./models/session.ts";
import { appendConversationDraft, conversationDraftTarget } from "./plugin-navigation.ts";
import { connectModels, refreshModels, settingsView, subscribeModels, useModels } from "./models/store.ts";
import { ArrowLeft, Settings } from "./icons.tsx";
import {
	checkPanels,
	ComposerAbove,
	ComposerChips,
	composerHint,
	ComposerItems,
	connectPluginHost,
	ConversationCards,
	listPages,
	pageBadge,
	listPanels,
	panelEntry,
	listSettingsSections,
	localized,
	matchesShortcut,
	PageSlot,
	type PanelEntry,
	PanelSlot,
	registerHostPanel,
	setPanelScope,
	SessionToolbar,
	usePluginUis,
	useQueueActions,
} from "./plugins.tsx";
import { FileBrowser } from "./files/FileBrowser.tsx";
import { FilePanel } from "./files/FilePanel.tsx";
import {
	connectFiles,
	dropFile,
	fileOf,
	isFolder,
	type LineRange,
	openFileIn,
	setFileOpener,
	setFileMovedHandler,
	setFileRemovedHandler,
	removeFiles,
	moveFiles,
	movedPath,
	shownPath,
} from "./files/open-file.ts";
import { FileScope, type FileScopeValue, touchedPaths } from "./files/scope.ts";
import { MarketNavItem, MarketScreen, MarketToolbar } from "./market/market.tsx";
import { NavItem } from "./nav-item.tsx";
import { applyLive, connectLiveSessions, peekLiveSession, readSessionView, reloadLive, useLiveSession, viewChange } from "./session-live.ts";
import { ChildConversation } from "./conversation/ChildConversation.tsx";
import { dropChildDraft, flushChildDrafts, seedChildQuote } from "./conversation/child-drafts.ts";
import { publishSessionChanges } from "./plugin-session-changes.ts";
import { EMPTY_HISTORY, type NavEntry, type NavHistory, record, type Screen, sameEntry, step } from "./nav-history.ts";
import { pluginsChanged, startMarket } from "./market/store.ts";
import { PageHeader } from "./settings/layout.tsx";
import { ModelSettings } from "./settings/models/ModelSettings.tsx";
import { ArchivedSettings } from "./settings/ArchivedSettings.tsx";
import { UpdateBadge } from "./update/UpdateBadge.tsx";
import { check as checkUpdates } from "./update/store.ts";
import { AboutSettings, AppearanceSettings, GeneralSettings, type SettingsSection, SettingsNav } from "./settings/pages.tsx";
import { AgentsSettings } from "./settings/agents.tsx";
import { PersonalizationSettings } from "./settings/personalization.tsx";
import { StorageSettings } from "./settings/StorageSettings.tsx";
import { NavButtons, SidebarIcon, ToolbarButton, toolbarReserved, WindowHeader } from "./window-controls.tsx";
import { SidebarTools } from "./sidebar/SidebarTools.tsx";
import { approvalChanged, outcome, sessionRead, sessionsChanged } from "./sidebar/activity.ts";
import { projectSessions } from "./sidebar/grouping.ts";
import { ProjectList } from "./sidebar/ProjectList.tsx";
import type { SidebarActions } from "./sidebar/actions.ts";
import { deleteSessionQuestion } from "./sidebar/delete-session.tsx";
import { SessionMenu } from "./sidebar/SessionMenu.tsx";
import { sessionWindows } from "./session-windows.ts";
import { panelGeometry } from "./panel-layout.ts";

interface AppState {
	sessions: SessionSummary[];
	projects: ProjectEntry[];
	currentId?: string;
	view?: SessionView;
	/** 刚点下、还在读的会话：侧栏那一行先亮起来，读到了（或等够了）再换屏，见 `select`。 */
	pendingId?: string;
	/** 屏上的会话还没读完：view 只有侧栏里那份摘要，对话区转圈，标题和输入框照常在。 */
	loading: boolean;
	settings?: SettingsView;
	/** 空白会话只留在界面里，第一次发送才落盘。 */
	target: SessionTarget;
	blankModel?: string;
	blankThinking?: SessionSummary["thinking"];
	drafts: Record<string, string>;
	/** 输入框里还没发出去的附件，键和 `drafts` 一样：换个会话再回来，挂上的附件还在。只在内存里。 */
	draftAttachments: Record<string, DraftAttachment[]>;
	/** 从对话里划下来、挂在草稿上的引文，键和 `drafts` 一样；发出去那一刻才拼回正文，见 `withQuotes`。只在内存里。 */
	quotes: Record<string, DraftQuote[]>;
	/** 撤回、分叉放回输入框的附件，键和 `drafts` 一样；那个输入框挂上时收走，见 `restoreDraft`。 */
	restored: Record<string, DraftAttachment[]>;
	/** 插件接在草稿后面的图片（`ui.draftInSession`），键和 `drafts` 一样；那个输入框挂上时追加到它的附件后面、收走。 */
	appended: Record<string, DraftAttachment[]>;
	/** 插件请这个输入框（键和 `drafts` 一样）把交来的字和图直接发出去（`ui.draftInSession` 的 `send`）：附件挂上以后发一次、撤掉。 */
	autoSend?: string;
	sending?: string;
	screen: Screen;
	/** 设置页停在哪一章；离开设置页再回来还是这一章。 */
	settingsSection: SettingsSection;
	/** agent 进程退出后整个界面不可用，顶部常驻提示。 */
	fatal?: string;
	/** macOS 原生全屏：红绿灯不画，顶行左端不用再给它们留位置。 */
	fullScreen: boolean;
	windowWidth: number;
	windowHeight: number;
	panelMaximized: Record<string, boolean>;
	panelWindows: PanelWindowTarget[];
	/** 推开模式下侧栏开着没有，和它的宽度偏好；见 layout.ts。 */
	sidebarOpen: boolean;
	sidebarWidth: number;
	/** 窄窗口下抽屉开着没有。和 sidebarOpen 分开：抽屉是临时的，关掉它不等于想收起侧栏。 */
	drawerOpen: boolean;
	/** 面板区开着没有、宽度偏好（见 layout.ts）。 */
	panelOpen: boolean;
	panelWidth: number;
	/** 标签按会话保存；只有声明可恢复的面板落盘，空白会话首次发送时交给新会话。 */
	panelTabs: Record<string, PanelTabs>;
	/** 人刚点了开关，面板区正滑进滑出：只在这一下加动画，滑完撤掉，见 SLIDE_MOTION。 */
	panelMoving: boolean;
	panelLeaving?: { id: string; scope: string };
	/** 后退、前进的记录，见 nav-history.ts。 */
	nav: NavHistory;
}

/**
 * 排进来那一刻输入框里的草稿，按排着的那一条（`QueuedMessage.id`）记着：「编辑」拿它回填。排着的那份里引文已经拼进正文、
 * 命令已经展开，从它拆不回人当时打的样子。队伍落在 agent 进程里，草稿只在这个窗口的内存里：重开以后、插件经格子替人发的
 * 那种没有草稿，编辑时从要发的那份还原。
 */
const queuedDrafts = new Map<string, { sessionId: string; draft: QueuedDraft }>();

interface QueuedDraft {
	sessionRefs?: SessionReference[];
	text: string;
	attachments: DraftAttachment[];
	quotes: DraftQuote[];
}

/** 面板区的一个标签：panel 是 `插件名/id`，没有就是开始页；title 是面板自己设的字。 */
interface PanelTab {
	id: string;
	panel?: string;
	title?: string;
	/** 子会话打开的辅助面板仍放在父会话旁边，但读取子会话自己的数据。 */
	sessionId?: string;
	file?: { path: string; sessionId: string };
}

interface PanelTabs {
	tabs: PanelTab[];
	active: string;
}

// ── 状态 ────────────────────────────────────────────────────────────

const sidebarPrefs = readSidebarPrefs();
const panelPrefs = readPanelPrefs();
const panelWindow = window.plume.panelWindows.boot;
/** 会话菜单「新窗口」开出来的窗口：只有这一段对话，没有侧栏和面板区。 */
const sessionWindow = window.plume.sessionWindows.boot;
let state: AppState = {
	sessions: [],
	projects: [],
	target: {},
	currentId: sessionWindow ?? (panelWindow?.scope || undefined),
	drafts: {},
	draftAttachments: {},
	quotes: {},
	restored: {},
	appended: {},
	loading: false,
	screen: "chat",
	settingsSection: "general",
	fullScreen: false,
	windowWidth: window.innerWidth,
	windowHeight: window.innerHeight,
	panelMaximized: {},
	panelWindows: [],
	sidebarOpen: sidebarPrefs.open,
	sidebarWidth: sidebarPrefs.width,
	drawerOpen: false,
	panelOpen: panelWindow ? true : panelPrefs.open,
	panelWidth: panelPrefs.width,
	panelTabs: panelWindow
		? {
				[panelWindow.scope]: {
					tabs: [{ id: panelWindow.tab, panel: panelWindow.panel, title: panelWindow.title, sessionId: panelWindow.owner, file: panelWindow.file }],
					active: panelWindow.tab,
				},
			}
		: readPanelTabs(),
	panelMoving: false,
	nav: record(EMPTY_HISTORY, { screen: "chat", sessionId: null }),
};
const listeners = new Set<() => void>();
let agent: Remote<AgentService>;

/**
 * 除了屏上那个会话的视图以外的状态。流式输出时草稿每 50ms、命令输出每 100ms 换一次 `view`，别的都没变；侧栏、标题栏、面板区这些
 * 不读视图的地方订阅它，就不跟着每一拍重画。就是 `state` 本身，只在 `view` 以外有字段变了时才换成新的那份；类型上拿掉 `view`，
 * 读不到可能过时的那份视图。
 */
type Chrome = Omit<AppState, "view">;
let chrome: Chrome = state;

function sameChrome(before: AppState, after: AppState): boolean {
	for (const key of Object.keys(after) as (keyof AppState)[]) if (key !== "view" && !Object.is(before[key], after[key])) return false;
	return true;
}

function update(patch: Partial<AppState> | ((current: AppState) => Partial<AppState>)): void {
	const previous = state;
	state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
	// 换了界面或会话就记一笔，不靠每个调用方报告：会话从侧栏、新建、事件流里都会打开，漏报一处历史就缺一块。
	if (!arriving && (state.screen !== previous.screen || state.currentId !== previous.currentId)) state = { ...state, nav: record(state.nav, here(state)) };
	if (!sameChrome(previous, state)) chrome = state;
	for (const listener of listeners) listener();
}

function subscribeApp(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 视图以外的状态。要屏上会话的视图的，单独用 `useAppPick` 取：流式输出时只有取了它的地方每一拍重画。 */
function useChrome(): Chrome {
	return useSyncExternalStore(subscribeApp, () => chrome);
}

/** 状态里的一样东西，它变了才重画。`pick` 只能交回状态里原有的引用或原始值，不能每次新造一个对象。 */
function useAppPick<T>(pick: (current: AppState) => T): T {
	return useSyncExternalStore(subscribeApp, () => pick(state));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 改一个会话的视图：屏上那个，或停在缓存里的那个——停着的也照样跟着事件走，切回来才是新的。 */
function updateView(sessionId: string, change: (view: SessionView) => Partial<SessionView>): void {
	const held = parked.get(sessionId);
	if (held) {
		parked.set(sessionId, { ...held, ...change(held) });
		return;
	}
	update((current) => (current.view?.summary.id === sessionId ? { view: { ...current.view, ...change(current.view) } } : {}));
}

/**
 * 正在重问（编辑重发、重试）的会话；`keep` 是截断到了、还没画的那一刀（留几条）。
 *
 * 截掉旧的那几轮和新问的那句落进会话是两次事件，中间隔着插件的 prompt.submit 钩子。照收到的先截，被重问的那个气泡先没了再回来，
 * 重问的是第一句时整屏还回一下欢迎页。所以这期间截断先不画，旧的留在屏上，新问的那句到了一起换：`message` 按位置放回，
 * 本身就截掉了它后面的。这一轮没收下那句就收了场（钩子拦下、出错），或者重问没发出去，再补上这一刀，见 `settleReask`。
 */
let reasking: { sessionId: string; keep?: number } | undefined;

function apply(event: AgentEvent): void {
	applyLive(event);
	if (event.type === "message" && reasking?.sessionId === event.sessionId) reasking = undefined;
	else if (event.type === "sessions" && reasking) {
		// 跑过又停下了。截断时那次 `sessions` 还没开始跑，不算。
		const id = reasking.sessionId;
		const before = state.sessions.find((session) => session.id === id);
		const after = event.sessions.find((session) => session.id === id);
		if (before?.running && !after?.running) settleReask(id);
	}
	publishSessionChanges(event, state.sessions);
	noteSessionDoing(event);
	if (event.type === "approval") approvalChanged(event.sessionId, event.approval);
	// 发出去、被拿走的那几条，排进来时记下的草稿也用不着了。
	if (event.type === "queue")
		for (const [id, held] of queuedDrafts) if (held.sessionId === event.sessionId && !event.queue.some((entry) => entry.id === id)) queuedDrafts.delete(id);
	switch (event.type) {
		case "fileRemoved":
			removeFiles(event.paths);
			return;
		case "fileMoved":
			moveFiles(event.from, event.to);
			return;
		case "sessions":
			announceFinished(state.sessions, event.sessions);
			sessionsChanged(state.sessions, event.sessions, state.currentId);
			for (const [id, view] of parked) {
				const summary = event.sessions.find((session) => session.id === id);
				if (summary) parked.set(id, { ...view, summary });
				else parked.delete(id);
			}
			update((current) => {
				const summary = current.view && event.sessions.find((session) => session.id === current.view?.summary.id);
				// 删掉了、或刚从未归档变成归档，就离开它，停在原页的新对话上；本来就归档的（从归档页打开来看）不赶人。
				const next = current.currentId === undefined ? undefined : event.sessions.find((session) => session.id === current.currentId);
				const justArchived = next?.archived === true && current.sessions.some((session) => session.id === next.id && !session.archived);
				const gone = current.currentId !== undefined && (!next || justArchived);
				return {
					sessions: event.sessions,
					...(gone
						? { currentId: undefined, view: undefined, loading: false }
						: summary && current.view
							? {
									view: { ...current.view, summary },
									// 项目移动和摘要一起到达，新对话不能沿用移动前的目标。
									target: summary.project && current.projects.some((project) => project.id === summary.project) ? { project: summary.project } : {},
								}
							: {}),
					...(current.pendingId && !event.sessions.some((session) => session.id === current.pendingId) ? { pendingId: undefined } : {}),
				};
			});
			return;
		case "projects":
			update((current) => ({
				projects: event.projects,
				...(current.target.project && !event.projects.some((project) => project.id === current.target.project) ? { target: {} } : {}),
			}));
			return;
		case "rewound":
			if (reasking?.sessionId === event.sessionId) {
				reasking.keep = event.count;
				const change = viewChange(event)!;
				updateView(event.sessionId, (view) => ({ ...change(view), messages: view.messages }));
				return;
			}
			updateView(event.sessionId, viewChange(event)!);
			return;
		case "message":
		case "draft":
		case "toolStart":
		case "progress":
		case "approval":
		case "hiccups":
		case "queue":
		case "tasks":
		case "compaction": {
			const change = viewChange(event);
			if (change) updateView(event.sessionId, change);
			return;
		}
		case "notice":
			// 带 level 的（插件说的、循环在恢复）不分是不是当前会话：后台那个会话停下了，人也该知道。
			if (event.level) notify(event.text, event.level);
			else if (state.currentId === event.sessionId) notify(event.text, "error");
			return;
		case "plugins":
			pluginsChanged(event.plugins);
	}
}

/** 正在重新拉状态（`refresh`）：手上的视图都错过了断流期间的事件，不借给订阅会话的插件，见 `heldView`。 */
let resyncing = false;

async function refresh(): Promise<void> {
	// 流断过，停着的会话错过了这期间的事件，都不能再用；屏上这个重读一遍。先作废再等别的：等的期间别处也可能来要。
	resyncing = true;
	parked.clear();
	// 重读回来的视图已经是截过的，没有要补的那一刀。
	reasking = undefined;
	reloadLive();
	try {
		const [sessions, projects] = await Promise.all([agent.listSessions(), agent.listProjects(), refreshModels()]);
		update({ sessions, projects });
		if (state.currentId) await select(state.currentId, true);
	} finally {
		resyncing = false;
	}
}

/**
 * 一直跟着 agent 的事件流；流断了隔一会儿重新订阅，并把状态重新拉一遍。先订阅再拉：拉的期间的事件攒在流里，拉完再合，
 * 其中拉回来的状态已经含着的那些重收一遍也落回原样（见 `viewChange`）。先拉再订阅的话，中间那段的事件就丢了。
 */
async function follow(): Promise<void> {
	while (!state.fatal) {
		const stream = agent.watch();
		try {
			await refresh();
			for await (const event of stream) apply(event);
		} catch (error) {
			console.error("事件流中断：", error);
		} finally {
			// 拉状态失败时流还没开始读：不撤掉的话 agent 那头一直往里推，这边一直攒着。
			stream.cancel();
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
}

/**
 * 离开过的会话停在这里，切回来当场换屏、不用再读；按最近离开的先后排，只留最近 `PARKED_LIMIT` 个。
 * 事件照样合进来（`updateView`、`sessions`），所以停着的一直是新的；事件流断过就整个作废（`refresh`）。
 */
const parked = new Map<string, SessionView>();
const PARKED_LIMIT = 12;

/**
 * 没停在缓存里的会话，最多等这么久再换屏。
 *
 * 先换屏再读的话，读只要十几毫秒，屏上却先画出一帧没有对话的页面，下一帧内容才整块出现，看上去整页闪了一下。
 * 先读、读到了再换就没有那一帧。上限要短：大会话读得久，一直停在上一页就是「点了没反应」，等够了照旧先换屏、
 * 对话区转圈，读完再补上。
 */
const COLD_OPEN_WAIT_MS = 120;

/** 每次换会话、去空白页都加一；读回来时号变了，说明人已经点了别处，这份结果不再换屏。 */
let selection = 0;

type SessionRead = { view: SessionView } | { error: unknown };

/** 正在读的那一份：连点同一行时接着等它，不再读第二遍。 */
let reading: { id: string; read: Promise<SessionRead> } | undefined;

function readSession(sessionId: string, again: boolean): Promise<SessionRead> {
	if (!again && reading?.id === sessionId) return reading.read;
	const read = readSessionView(agent, sessionId).then(
		(view) => ({ view }),
		(error: unknown) => ({ error }),
	);
	const entry = { id: sessionId, read };
	reading = entry;
	void read.then(() => {
		if (reading === entry) reading = undefined;
	});
	return read;
}

/**
 * 手上已有的一个会话的视图：正在读的那一份、屏上读完了的、停在缓存里的（后两者都跟着事件流走）。订阅会话的插件、面板
 * 从这里拿，不再整份读一遍，见 `connectLiveSessions`。正在读的排在前面：事件流断过后重读屏上这个时，屏上的还是断流前那份。
 */
function heldView(sessionId: string): SessionView | Promise<SessionView> | undefined {
	if (reading?.id === sessionId)
		return reading.read.then((result) => {
			if ("view" in result) return result.view;
			throw result.error;
		});
	if (resyncing) return undefined;
	if (state.view?.summary.id === sessionId && !state.loading) return state.view;
	return parked.get(sessionId);
}

/** 屏上的会话要被换下去了：有内容、已经读完的停进缓存。 */
function park(): void {
	const view = state.view;
	if (!view || state.loading || view.messages.length === 0) return;
	parked.delete(view.summary.id);
	parked.set(view.summary.id, view);
	for (const id of parked.keys()) {
		if (parked.size <= PARKED_LIMIT) break;
		parked.delete(id);
	}
}

/** 把一个会话换上屏；`loading` 时 view 只是摘要，读完再由 `select` 换成整份。 */
function show(view: SessionView, loading: boolean): void {
	const sessionId = view.summary.id;
	if (state.currentId !== sessionId) park();
	parked.delete(sessionId);
	const project = view.summary.project;
	update({
		currentId: sessionId,
		view,
		loading,
		pendingId: undefined,
		screen: "chat",
		drawerOpen: false,
		target: project && state.projects.some((entry) => entry.id === project) ? { project } : {},
	});
}

/**
 * 人没在看的会话跑完、出错了，在提示条上说一声，卡片上能跳过去。屏上那个不说：结果就在眼前。
 * 子会话（侧边聊天、子 Agent）不说：它们的结果回到父会话里，人在那边看；插件的独立会话也不说，它画在插件自己的页面里。只有主窗口说，别的窗口各说一遍就成了重复。
 */
function announceFinished(previous: readonly SessionSummary[], next: readonly SessionSummary[]): void {
	if (panelWindow || sessionWindow) return;
	const before = new Map(previous.map((session) => [session.id, session]));
	for (const session of next) {
		if (session.running || !before.get(session.id)?.running || session.kind !== "top" || session.id === state.currentId) continue;
		const result = outcome(session.stop?.reason);
		if (!result) continue;
		const title = session.title || translate("sessionOps.newSession");
		if (result === "done") notify(translate("toaster.sessionDone", { title }), "info", { sessionId: session.id });
		else notify(translate("toaster.sessionFailed", { title }), "error", { sessionId: session.id });
	}
}

/** 提示条上的「跳转到该会话」：会话还在才打开，打开了卡片才收起。 */
async function openNoticeSession(sessionId: string): Promise<boolean> {
	if (!state.sessions.some((session) => session.id === sessionId)) return false;
	await select(sessionId);
	return state.currentId === sessionId;
}

/** 打开一个会话。`again`：屏上就是它也重读一遍（事件流断过，见 `refresh`）。 */
async function select(sessionId: string, again = false): Promise<void> {
	sessionRead(sessionId);
	// 只在人选中时清手动未读，缓存命中也一样；后台刷新和标记当前会话都不替人读掉。
	if (!again && state.sessions.some((session) => session.id === sessionId && session.unread)) {
		void agent.setSessionUnread(sessionId, false).catch((error: unknown) => notify(errorText(error), "error"));
	}
	const epoch = ++selection;
	composerArrival = undefined;
	// 后台面板也订阅会话；有现成视图时直接复用。
	const held = again ? undefined : state.currentId === sessionId && !state.loading ? state.view : (parked.get(sessionId) ?? peekLiveSession(sessionId));
	if (held) {
		show(held, false);
		return;
	}
	update({ pendingId: sessionId });
	const read = readSession(sessionId, again);
	const early = await Promise.race([read, new Promise<undefined>((resolve) => setTimeout(resolve, COLD_OPEN_WAIT_MS))]);
	if (epoch !== selection) return;
	const summary = state.sessions.find((session) => session.id === sessionId);
	// 等够了还没读到：先换屏，标题和输入框先到，对话区转圈。屏上本来就是它（重读）就不用换，接着显示旧的。
	if (!early && summary && state.currentId !== sessionId)
		show({ summary, messages: [], progress: {}, startedAt: {}, hiccups: [], compactions: [], compactionRuns: [], compacting: false, queue: [] }, true);
	const result = await read;
	if (epoch !== selection) return;
	if ("view" in result) show(result.view, false);
	else {
		update((current) => ({ pendingId: undefined, ...(current.currentId === sessionId ? { currentId: undefined, view: undefined, loading: false } : {}) }));
		notify(errorText(result.error), "error");
	}
}

/** 只切到空白页：反复点新对话不生成空记录，也不丢掉该项目的草稿。 */
function openNew(target: SessionTarget = state.target): void {
	selection++;
	composerArrival = undefined;
	park();
	update({ target: { ...target }, currentId: undefined, view: undefined, loading: false, pendingId: undefined, screen: "chat", drawerOpen: false });
	focusComposer();
}

/**
 * 提示条上「新开一个对话来排查」：在当前项目里开一个空白对话，把错误写成一段草稿，不发出去——问不问由人定。
 * 空白页的草稿按项目留着，那里已经写了东西就接在后面，不覆盖。
 */
function investigate(message: string): void {
	const project = state.projects.find((entry) => entry.id === (state.view?.summary.project ?? state.target.project));
	openNew(project ? { project: project.id } : {});
	const prompt = [
		translate("toaster.investigate"),
		"",
		translate("toaster.errorLabel"),
		message,
		...(project ? ["", translate("toaster.project", { name: project.name })] : []),
	].join("\n");
	const scope = draftScope();
	const held = state.drafts[scope]?.trim();
	setDraft(scope, held ? `${held}\n\n${prompt}` : prompt);
}

/** 把项目里还列在侧栏上的会话都归档。一个一个来：每次都要改同一份会话索引。出错只提示，不往外抛。 */
async function archiveProject(projectId: string): Promise<void> {
	const targets = projectSessions(state.sessions, projectId);
	if (targets.length === 0) return;
	try {
		for (const session of targets) await agent.setSessionArchived(session.id, true);
		notify(translate("workspace.archived", { n: targets.length }));
	} catch (error) {
		notify(translate("workspace.archiveFailed", { reason: errorText(error) }), "error");
	}
}

/** 侧栏上的动作。出错写进提示条，侧栏不等结果。 */
const sidebarActions: SidebarActions = {
	open: (sessionId) => void select(sessionId),
	newSession: openNew,
	// 建好就在里面开第一段对话：刚建的项目是空的，人建它就是要在里面做事。
	createProject: (name, path, folders) =>
		void agent
			.createProject(name, path, folders)
			.then((project) => openNew({ project: project.id }))
			.catch((error: unknown) => notify(errorText(error), "error")),
	stats: async (id) => await agent.sessionStats(id),
	reorderProjects: async (source, target, placement) => await agent.reorderProjects(source, target, placement),
	reorderSessions: async (project, ids) => await agent.reorderProjectSessions(project, ids),
	updateProject: (projectId, name, path, folders) =>
		void agent.updateProject(projectId, name, path, folders).catch((error: unknown) => notify(errorText(error), "error")),
	// 先把它的聊天归档，再忘掉登记：归档失败只提示，登记照样删掉——项目还挂着才是人要删的那件事没办成。
	removeProject: (projectId) =>
		void archiveProject(projectId)
			.then(async () => await agent.removeProject(projectId))
			.catch((error: unknown) => notify(errorText(error), "error")),
	archiveProject: (projectId) => void archiveProject(projectId),
	archive: (sessionId, archived = true) => void agent.setSessionArchived(sessionId, archived).catch((error: unknown) => notify(errorText(error), "error")),
	rename: async (sessionId, title) => {
		await agent.renameSession(sessionId, title);
	},
	pin: async (sessionId, pinned) => {
		await agent.setSessionPinned(sessionId, pinned);
	},
	unread: async (sessionId, unread) => {
		await agent.setSessionUnread(sessionId, unread);
	},
	move: async (sessionId, projectId) => {
		await agent.moveSessionProject(sessionId, projectId);
	},
	export: async (sessionId, format) => {
		const title = state.sessions.find((session) => session.id === sessionId)?.title || translate("sessionOps.newSession");
		// 标题不是路径；按最严的文件名规则清洗，也不把表情截成半个。
		let name = title
			.replace(/\s+/g, " ")
			.replace(/[\u0000-\u001f\u007f]/g, "")
			.replace(/[<>:\x22/\\|?*]/g, "_")
			.trim();
		name =
			Array.from(name)
				.slice(0, 120)
				.join("")
				.replace(/[. ]+$/, "") || translate("sessionOps.newSession");
		if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) name = `_${name}`;
		const markdown = format === "markdown";
		const file = await window.plume.sessionsExportPath(
			translate(markdown ? "sessionMenu.exportMarkdown" : "sessionMenu.exportRecords"),
			`${name}.${markdown ? "md" : "db"}`,
			format,
		);
		if (!file) return;
		await agent.exportSession(sessionId, file, format);
		notify(translate(markdown ? "sessionMenu.markdownExported" : "sessionMenu.recordsExported"), "info", { reveal: file });
	},
	newWindow: openInNewWindow,
};

function openInNewWindow(sessionId: string): void {
	void window.plume.sessionWindows.open(sessionId).catch((error: unknown) => notify(errorText(error), "error"));
}

// ── 后退、前进 ──────────────────────────────────────────────────────

function here(current: AppState): NavEntry {
	return { screen: current.screen, sessionId: current.currentId ?? null };
}

function canStep(current: AppState, direction: -1 | 1): boolean {
	return (
		step(current.nav, direction, { currentId: current.currentId ?? null, exists: (id) => current.sessions.some((session) => session.id === id), hasPage }) !==
		null
	);
}

function hasPage(screen: `page:${string}`): boolean {
	return listPages().some((page) => `page:${page.key}` === screen);
}

/** 后退、前进正在落地：这期间的状态变化是这一步本身，不是新去了一个地方，记下来会把前面的都截掉。 */
let arriving = false;

async function go(direction: -1 | 1): Promise<void> {
	const next = step(state.nav, direction, { currentId: state.currentId ?? null, exists: (id) => state.sessions.some((session) => session.id === id), hasPage });
	if (!next) return;
	arriving = true;
	try {
		update({ nav: next.history });
		if (next.entry.screen === "chat" && next.entry.sessionId && next.entry.sessionId !== state.currentId) await select(next.entry.sessionId);
		update({ screen: next.entry.screen });
	} finally {
		arriving = false;
		// 最后停在哪里，记录就站在哪里，打开失败也一样。
		update((current) => {
			const at = current.nav.entries[current.nav.index];
			const landed = here(current);
			return at && sameEntry(at, landed) ? {} : { nav: record(current.nav, landed) };
		});
	}
}

/**
 * 插件往输入框里放字（`ui.draftInSession`）：`append` 时接在后面、图片作为附件挂上，不然换掉草稿。
 * `send` 时输入框原本是空的就直接发出去。面板窗口里没有输入框：交给主窗口，放进来源会话的。
 */
function pluginDraft(draft: {
	text: string;
	append: boolean;
	images: { data: string; mimeType: string; name?: string; from?: string }[];
	send?: boolean;
}): void {
	if (panelWindow) {
		void window.plume.panelWindows.reveal({ draft }).catch((error: unknown) => notify(errorText(error), "error"));
		return;
	}
	const scope = draftScope(state.view);
	// 只在输入框原本是空的时候直接发：人写了一半的话不能被一起发出去，那时照草稿落进去，等人自己发。
	const send =
		draft.send &&
		draft.text.trim() &&
		!(state.drafts[scope] ?? "").trim() &&
		!state.appended[scope]?.length &&
		!state.restored[scope]?.length &&
		!state.quotes[scope]?.length &&
		!sessionReferences(scope).length &&
		!state.draftAttachments[scope]?.length;
	const files = draft.images.map((image): DraftAttachment => ({
		id: crypto.randomUUID(),
		name: image.name ?? translate("composer.regionShot"),
		mimeType: image.mimeType,
		kind: "image",
		data: image.data,
		isText: false,
		...(image.from ? { from: image.from } : {}),
	}));
	update((now) => {
		const current = now.drafts[scope] ?? "";
		const text = draft.append && current.trim() ? `${current.trimEnd()}\n\n${draft.text}` : draft.text;
		return {
			drafts: { ...now.drafts, [scope]: text },
			...(files.length > 0 ? { appended: { ...now.appended, [scope]: [...(now.appended[scope] ?? []), ...files] } } : {}),
		};
	});
	if (send) update({ autoSend: scope });
	focusComposer();
}

/**
 * 插件要把一个会话摆到人面前（`ui.draftInSession`、`ui.revealToolCall`）：换到对话屏、选中它，等它读完。打不开时抛错。
 * 面板窗口里没有转录和输入框，不接这件事。
 */
async function openSessionFor(sessionId: string): Promise<void> {
	if (panelWindow) throw new Error(translate("plugin.mainWindowOnly"));
	if (!state.sessions.some((session) => session.id === sessionId)) throw new Error(translate("plugin.sessionGone"));
	await select(sessionId);
	if (state.currentId !== sessionId) throw new Error(translate("plugin.sessionGone"));
}

function quoteInPanel(key: string, sessionId: string, quote: DraftQuote): void {
	if (panelWindow || sessionWindow) {
		void window.plume.panelWindows.reveal({ quote: { panel: key, sessionId, quote } }).catch((error: unknown) => notify(errorText(error), "error"));
		return;
	}
	if (!state.sessions.some((session) => session.id === sessionId)) return;
	const scope = panelScope(sessionId);
	const layout = tabsOf(state, scope);
	const current = state.screen === "chat" && state.panelOpen && scopeOf(state) === scope ? layout.tabs.find((tab) => tab.id === layout.active) : undefined;
	const reuse = current?.panel === key && !state.panelWindows.some((entry) => entry.tab === current.id);
	const tab = reuse ? current.id : crypto.randomUUID();
	seedChildQuote(tab, quote);
	showPanel(key, false, sessionId, { tab });
}

export function start(service: Remote<AgentService>): void {
	agent = service;
	connectModels(service);
	connectLiveSessions(service, heldView);
	connectFiles(service);
	setFileOpener(openFileTab);
	setFileMovedHandler((from, to) => {
		const panelTabs = Object.fromEntries(
			Object.entries(state.panelTabs).map(([scope, layout]) => [
				scope,
				{
					...layout,
					tabs: layout.tabs.map((tab) => (tab.file ? { ...tab, file: { ...tab.file, path: movedPath(tab.file.path, from, to) } } : tab)),
				},
			]),
		);
		update({ panelTabs });
		persistTabs(panelTabs);
	});
	setFileRemovedHandler((paths) => {
		for (const [scope, layout] of Object.entries(state.panelTabs)) {
			const removed = layout.tabs.filter((tab) => {
				const path = shownPath(tab.id) ?? tab.file?.path;
				return path && paths.some((gone) => path === gone || path.startsWith(`${gone}/`) || path.startsWith(`${gone}\\`));
			});
			if (!removed.length) continue;
			const tabs = layout.tabs.filter((tab) => !removed.includes(tab));
			setTabs(scope, tabs.length ? { tabs, active: tabs.some((tab) => tab.id === layout.active) ? layout.active : tabs.at(-1)!.id } : undefined);
			if (panelWindow && removed.some((tab) => tab.id === panelWindow.tab)) void window.plume.panelWindows.close();
		}
	});
	connectPluginHost({
		openPanel: (key, sessionId, options) => showPanel(key, false, sessionId, options),
		quoteInPanel,
		closePanel: (key, sessionId, only) => {
			const scope = sessionId ? panelScope(sessionId) : scopeOf(state);
			const owner = sessionId && sessionId !== scope ? sessionId : undefined;
			for (const tab of tabsOf(state, scope).tabs) if (tab.panel === key && tab.sessionId === owner && (!only || tab.id === only)) void closeTab(tab.id, scope);
		},
		openConversationDraft: async (options) => {
			const target = conversationDraftTarget(options, state.projects);
			openNew(target);
			const scope = draftScope();
			setDraft(scope, appendConversationDraft(state.drafts[scope], options.text));
		},
		draftInSession: async (sessionId, draft) => {
			// 面板窗口只能交给自己来源的那个会话：主窗口先选中来源会话，再放进它的输入框。不给会话是眼前的输入框。
			if (panelWindow) {
				if (sessionId !== undefined && sessionId !== panelWindow.scope) throw new Error(translate("plugin.mainWindowOnly"));
			} else if (sessionId !== undefined) await openSessionFor(sessionId);
			pluginDraft({ text: draft.text, append: !draft.replace, images: draft.images, send: draft.send });
		},
		openSession: openSessionFor,
		openSettings: (key) => update({ screen: "settings", settingsSection: `plugin:${key}`, drawerOpen: false }),
		openPage: (key) => update({ screen: `page:${key}`, drawerOpen: false }),
		Conversation: PluginConversation,
		useProjects: () => useAppPick((current) => current.projects),
		useSessionModel: () => {
			const { currentId, sessions } = useChrome();
			return sessions.find((summary) => summary.id === currentId)?.model;
		},
		openModelSettings: () => update({ screen: "settings", settingsSection: "models" }),
		queueTask: async (sessionId, instruction) => await agent.queueTask(sessionId, instruction),
	});
	// ⌘P 开文件树，⌥⌘P（Windows、Linux 上 Ctrl+P、Ctrl+Alt+P）开文件本身：同一个字母，加 ⌥ 表示「另一个」。
	registerHostPanel("file", ProjectFilePanel, {
		title: () => translate("dock.fileContents"),
		icon: FileText,
		shortcut: "CommandOrControl+Alt+P",
		multiple: true,
		restore: true,
		detachable: true,
	});
	registerHostPanel(
		"files",
		ProjectFiles,
		{
			title: () => translate("fileTree.projectFiles"),
			icon: Folder,
			shortcut: "CommandOrControl+P",
			restore: true,
			available: ({ cwd, session }) => Boolean(cwd && session),
		},
		true,
	);
	startMarket(service);
	// 模型设置由 models/store.ts 管：哪里改了都经它重新取一次，这里跟着换。
	subscribeModels(() => update({ settings: settingsView() }));
	window.plume.onAgentExit((code) => update({ fatal: translate("app.agentExited", { code }) }));
	window.plume.onFullScreenChange((fullScreen) => update({ fullScreen }));
	window.addEventListener("resize", () => {
		update({ windowWidth: window.innerWidth, windowHeight: window.innerHeight, panelMoving: false });
	});
	window.plume.panelWindows.onChanged(async ({ target, reason }) => {
		if (panelWindow) {
			if (reason === "closing") await closeTab(panelWindow.tab, panelWindow.scope);
			return;
		}
		if (reason === "opened") {
			const panelWindows = [...state.panelWindows.filter((entry) => entry.tab !== target.tab), target];
			const remaining = state.panelTabs[target.scope]?.tabs.some((tab) => !panelWindows.some((entry) => entry.tab === tab.id));
			update({ panelWindows, ...(!remaining && target.scope === scopeOf(state) ? { panelOpen: false } : {}) });
			return;
		}
		if (reason === "closing") return;
		update({ panelWindows: state.panelWindows.filter((entry) => entry.tab !== target.tab) });
		if (reason === "closed") removeTab(target.tab, target.scope);
		else {
			const saved = state.panelTabs[target.scope];
			if (saved) setTabs(target.scope, { ...saved, active: target.tab });
			void select(target.scope).then(() => togglePanel(true));
		}
	});
	if (!panelWindow && !sessionWindow) {
		// 开在独立窗口里的会话：侧栏把它们点亮；那边点「在主窗口中打开」时回到主窗口。
		void window.plume.sessionWindows.list().then((ids) => sessionWindows.set(ids));
		window.plume.sessionWindows.onChanged((ids) => sessionWindows.set(ids));
		window.plume.sessionWindows.onShow((sessionId) => void select(sessionId));
		// 菜单栏图标的菜单和 plume:// 链接（main/tray.ts、main/deep-link.ts）。
		window.plume.onCommand((command) => {
			if (command.startsWith("open-session:")) void select(command.slice("open-session:".length));
			else if (command === "new-session") openNew();
			else if (command === "settings") update({ screen: "settings", drawerOpen: false });
			else if (command === "updates") {
				update({ screen: "settings", settingsSection: "about", drawerOpen: false });
				void checkUpdates(true);
			}
		});
		void window.plume.panelWindows.list().then((panelWindows) => update({ panelWindows }));
		window.plume.panelWindows.onReveal(({ scope, request }) => {
			void select(scope)
				.then(async () => {
					if ("file" in request) await openFileTab(request.file.path, request.file.lines, request.file.sessionId);
					else if ("quote" in request) quoteInPanel(request.quote.panel, request.quote.sessionId, request.quote.quote);
					else if ("draft" in request) pluginDraft(request.draft);
					else showPanel(request.panel, false, request.sessionId ?? scope);
				})
				.catch((error: unknown) => notify(errorText(error), "error"));
		});
	}
	void follow();
}

// ── 外壳 ────────────────────────────────────────────────────────────
//
// 窗口底色上放侧栏，旁边是一张浮起的正文卡片，离窗口边和侧栏各 4px。macOS 上窗口底下是系统材质，
// 底色是半透明的一层，从侧栏和卡片四周的缝里透出来；卡片是实色的。
//
// 顶行：侧栏顶行和卡片里的标题栏都是 44px，比窗口顶边低 5px（见 shared/window-chrome.ts），红绿灯、侧栏开关在同一条线上。
// 这两行可以拖动窗口，里面能点的东西标 no-drag。Electron 按文档顺序合成拖拽区，排在后面的 drag 会把前面挖的洞重新盖上，
// 所以浮在顶行上的侧栏开关和拖宽度的把手放在最后。

const DRAG = "[app-region:drag]";
const NO_DRAG = "[app-region:no-drag]";
/**
 * Windows、Linux 上窗口顶上另有一条带子（`WindowHeader`），拖窗口、侧栏开关、系统按钮都在它上面。卡片里的标题栏就只是
 * 卡片的一行，不拖窗口：在那里拖等于在 Windows 的标题栏上拖，右键弹系统菜单、双击最大化、拖到屏幕边就贴边。
 */
const HEADER_BAR = hasHeaderBar(window.plume.platform);
/** 卡片里的标题栏：有那条带子时不拖窗口。 */
const CARD_DRAG = HEADER_BAR ? "" : DRAG;
/** 侧栏、面板区收起和展开时的动画。拖宽度和窗口缩放时不加，否则每一帧都在追上一帧。 */
const SLIDE_MOTION = "transition-[width,translate] ease-out";

function setSidebar(patch: { open?: boolean; width?: number }): void {
	update(
		patch.open === undefined ? { sidebarWidth: patch.width } : { sidebarOpen: patch.open, ...(patch.width === undefined ? {} : { sidebarWidth: patch.width }) },
	);
	writeSidebarPrefs({ open: state.sidebarOpen, width: state.sidebarWidth });
}

function setPanel(patch: { open?: boolean; width?: number }): void {
	update({
		...(patch.open === undefined ? {} : { panelOpen: patch.open }),
		// 手动调宽立即接管，不能沿用尚未结束的开合动画。
		...(patch.width === undefined ? {} : { panelWidth: patch.width, panelMoving: false }),
	});
	writePanelPrefs({ open: state.panelOpen, width: state.panelWidth });
}

/** 人打开或收起面板区：开关、收起按钮、Esc、点外面都走这里，只有这几下带动画。 */
function togglePanel(open: boolean, scope = scopeOf(state)): void {
	if (open && state.panelLeaving) finishPanelLeave();
	update({ panelMoving: true, ...(!open ? { panelMaximized: { ...state.panelMaximized, [scope]: false } } : {}) });
	setPanel({ open });
}

const scopeOf = (current: Chrome): string => current.currentId ?? "";
const panelScope = (sessionId: string): string => state.sessions.find((session) => session.id === sessionId)?.parentId ?? sessionId;

/** 下一轮在哪个目录跑：会话保留自己的工作目录，新对话取选中项目的目录。插件的格子、面板都按它画。 */
function nextTurnCwd(current: Chrome, session: SessionSummary | undefined): string | undefined {
	if (session) return session.cwd ?? current.projects.find((entry) => entry.id === session.project)?.path;
	const target = current.target;
	return current.projects.find((entry) => entry.id === target.project)?.path ?? target.cwd;
}

/** 某个会话的标签：插件停用了的面板不算；一个都没有时是一个开始页。 */
function tabsOf(current: Chrome, scope = scopeOf(current), panels = listPanels()): PanelTabs {
	const saved = current.panelTabs[scope];
	const tabs = saved?.tabs.filter((tab) => !tab.panel || panels.some((panel) => panel.key === tab.panel)) ?? [];
	if (!saved || tabs.length === 0) return { tabs: [{ id: `start:${scope}` }], active: `start:${scope}` };
	return { tabs, active: tabs.some((tab) => tab.id === saved.active) ? saved.active : tabs[tabs.length - 1]!.id };
}

function persistTabs(all: Record<string, PanelTabs>): void {
	if (panelWindow || sessionWindow) return;
	const saved: Record<string, PanelTabs> = {};
	for (const [scope, group] of Object.entries(all)) {
		const tabs = group.tabs.filter((tab) => tab.panel && panelEntry(tab.panel)?.restore);
		if (tabs.length) saved[scope] = { tabs, active: tabs.some((tab) => tab.id === group.active) ? group.active : tabs.at(-1)!.id };
	}
	writePanelTabs(saved);
}

function setTabs(scope: string, next: PanelTabs | undefined): void {
	const { [scope]: _, ...rest } = state.panelTabs;
	const panelTabs = next ? { ...rest, [scope]: next } : rest;
	update({ panelTabs });
	persistTabs(panelTabs);
}

function selectTab(id: string, scope: string): void {
	setTabs(scope, { tabs: tabsOf(state, scope).tabs, active: id });
}

/** 成功打开独立窗口才交接，失败时保留原标签及资源。 */
async function popOutTab(tab: PanelTab, scope: string): Promise<void> {
	if (!scope || !tab.panel || !panelEntry(tab.panel)?.detachable) return;
	const file = fileOf(tab.id);
	const target: PanelWindowTarget = {
		scope,
		tab: tab.id,
		panel: tab.panel,
		...(tab.title ? { title: tab.title } : {}),
		...(tab.sessionId ? { owner: tab.sessionId } : {}),
		...(file.path && file.sessionId ? { file: { path: file.path, sessionId: file.sessionId } } : {}),
	};
	try {
		flushChildDrafts();
		if (!(await window.plume.panelWindows.open(target))) notify(translate("pane.openFailed"), "error");
	} catch {
		notify(translate("pane.openFailed"), "error");
	}
}

/**
 * 开始页标签 `tabId` 变成面板 `key`。换一个新 id：面板按 id 认自己的东西，开始页的 id 可能被用过。
 * 只能开一个的面板已经开着，就切过去，这个开始页关掉。
 */
function launch(tabId: string, key: string, scope = scopeOf(state), sessionId?: string): void {
	const entry = listPanels().find((panel) => panel.key === key);
	if (!entry) return;
	const { tabs } = tabsOf(state, scope);
	const open = entry.multiple ? undefined : tabs.find((tab) => tab.panel === key && tab.sessionId === sessionId);
	if (open) return setTabs(scope, { tabs: tabs.filter((tab) => tab.id !== tabId), active: open.id });
	const id = crypto.randomUUID();
	setTabs(scope, { tabs: tabs.map((tab) => (tab.id === tabId ? { id, panel: key, ...(sessionId ? { sessionId } : {}) } : tab)), active: id });
}

/** 「+」：开一个开始页标签；已经有开始页就切过去，不并排留几个空的。 */
function openStartTab(scope = scopeOf(state)): void {
	const { tabs } = tabsOf(state, scope);
	const start = tabs.find((tab) => !tab.panel);
	if (start) return setTabs(scope, { tabs, active: start.id });
	const id = crypto.randomUUID();
	setTabs(scope, { tabs: [...tabs, { id }], active: id });
}

/**
 * 快捷键：切到这个面板的标签；没开着就开一个，正看着开始页就用它。面板区没开顺带打开。
 * `fresh`：能开好几个的面板不切到开着的，新开一个（`/btw` 问到一个新的侧边聊天里）。
 * `tab`：能开好几个的面板开 id 为它的标签，没有就用这个 id 新开；`background` 只加标签，不切过去、不展开面板区。
 */
function showPanel(key: string, fresh = false, sessionId?: string, options: { tab?: string; background?: boolean } = {}): void {
	// 面板窗口、会话窗口里没有面板区：交给主窗口，开在来源会话旁边。
	if (panelWindow || sessionWindow) {
		// 点名标签的是插件替逻辑入口开的（网页）：每个窗口的界面入口都收到同一个通知，由主窗口开，这里不再叫一遍。
		if (options.tab) return;
		void window.plume.panelWindows
			.reveal({ panel: key, sessionId: sessionId ?? panelWindow?.scope ?? sessionWindow ?? undefined })
			.catch((error: unknown) => notify(errorText(error), "error"));
		return;
	}
	const scope = sessionId ? panelScope(sessionId) : scopeOf(state);
	const owner = sessionId && sessionId !== scope ? sessionId : undefined;
	const { tabs, active } = tabsOf(state, scope);
	const current = tabs.find((tab) => tab.id === active);
	const multiple = listPanels().find((panel) => panel.key === key)?.multiple === true;
	if (multiple && options.tab) {
		const named = tabs.find((tab) => tab.id === options.tab);
		if (named && named.panel !== key) return;
		// 一个标签都没开过时 `tabsOf` 给的是一张临时的开始页，不并排留着。
		const next = named ? tabs : [...(state.panelTabs[scope] ? tabs : []), { id: options.tab, panel: key, ...(owner ? { sessionId: owner } : {}) }];
		const stay = options.background && next.some((tab) => tab.id === active);
		setTabs(scope, { tabs: next, active: stay ? active : options.tab });
		if (!options.background && scope === scopeOf(state) && !state.panelOpen) togglePanel(true);
		return;
	}
	const open =
		fresh && multiple
			? undefined
			: current?.panel === key && current.sessionId === owner
				? current
				: tabs.findLast((tab) => tab.panel === key && tab.sessionId === owner);
	const detached = open && state.panelWindows.find((entry) => entry.tab === open.id);
	if (detached) {
		void window.plume.panelWindows.open(detached);
		return;
	}
	if (open) setTabs(scope, { tabs, active: open.id });
	else if (current && !current.panel) launch(current.id, key, scope, owner);
	else {
		const id = crypto.randomUUID();
		setTabs(scope, { tabs: [...tabs, { id }], active: id });
		launch(id, key, scope, owner);
	}
	if (scope === scopeOf(state) && !state.panelOpen) togglePanel(true);
}

/** 本体的文件面板，见 `openFileTab`。 */
const FILE_PANEL = "plume/file";

/** 同一个文件只开一个标签。Windows 上不分大小写、两种斜杠是同一个文件。 */
function samePath(a: string, b: string): boolean {
	const norm = (path: string) => (window.plume.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path);
	return norm(a) === norm(b);
}

/**
 * 按路径打开文件（`openFile` 的实现）：这个会话已经有标签看着它就切过去，不然新开一个文件标签。
 *
 * 先读再开：读不到的不留一个空标签，已经开着的标签也照旧显示原来的；读不到在这里说一声，说清读的是哪儿。
 */
async function openFileTab(path: string, lines?: LineRange | null, owner?: string): Promise<void> {
	const sessionId = owner ?? state.currentId;
	if (!sessionId) return;
	if (!state.sessions.some((session) => session.id === sessionId)) throw new Error(translate("plugin.sessionGone"));
	if (panelWindow || sessionWindow) {
		await window.plume.panelWindows.reveal({ file: { path, sessionId, ...(lines ? { lines } : {}) } });
		return;
	}
	const scope = owner ? panelScope(owner) : scopeOf(state);
	const same = tabsOf(state, scope).tabs.find((tab) => {
		const shown = tab.panel === FILE_PANEL ? shownPath(tab.id) : null;
		return shown !== null && samePath(shown, path);
	});
	const id = same?.id ?? crypto.randomUUID();
	if (!(await openFileIn(id, sessionId, same ? shownPath(id)! : path, lines))) {
		if (!same) dropFile(id);
		/*
		 * 回复里指着文件夹的链接（`plugins/`）当文件读只会读成空。它是目录就交给系统文件管理器打开；
		 * 打不开、或者本来就不是目录，才说读不到。
		 */
		if (await isFolder(sessionId, path)) {
			const opened = await window.plume.files.open(path).catch(() => "failed" as const);
			if (opened !== "failed") return;
		}
		notify(translate("filePanel.unreadableAt", { path }), "error");
		return;
	}
	// 读的途中可能换了会话、开关了别的标签，按现在的算。
	const { tabs } = tabsOf(state, scope);
	if (tabs.some((tab) => tab.id === id)) setTabs(scope, { tabs, active: id });
	// 一个标签都没开过时 `tabsOf` 给的是一张临时的开始页，文件标签替掉它，不并排留着。
	else setTabs(scope, { tabs: [...(state.panelTabs[scope] ? tabs : []), { id, panel: FILE_PANEL, file: { path, sessionId } }], active: id });
	if (scope === scopeOf(state) && !state.panelOpen) togglePanel(true);
}

/** 标签 ✕ 前先问的，见 PanelProps.onClose。 */
const closeGuards = new Map<string, () => boolean | Promise<boolean>>();

/** 关一个标签：面板设了 onClose 先问它。一个不剩就收起面板区，下次打开是新的开始页。 */
async function closeTab(id: string, scope = scopeOf(state)): Promise<void> {
	const guard = closeGuards.get(id);
	try {
		if (guard && !(await guard())) return;
	} catch (error) {
		// 插件自己出错不该让标签关不掉。
		console.error("[panel] 关标签前的检查出错：", error);
	}
	dropChildDraft(id);
	if (panelWindow) {
		await window.plume.panelWindows.close();
		return;
	}
	if (
		scope === scopeOf(state) &&
		state.panelOpen &&
		!state.panelMaximized[scope] &&
		layoutMode(state.windowWidth) !== "compact" &&
		tabsOf(state).tabs.filter((tab) => !state.panelWindows.some((entry) => entry.tab === tab.id)).length === 1
	) {
		update({ panelLeaving: { id, scope } });
		togglePanel(false);
	} else removeTab(id, scope);
}

function finishPanelLeave(): void {
	const leaving = state.panelLeaving;
	if (!leaving) return;
	update({ panelLeaving: undefined });
	removeTab(leaving.id, leaving.scope);
}

function removeTab(id: string, scope: string): void {
	closeGuards.delete(id);
	tabHandles.delete(id);
	dropFile(id);
	// 问的时候可能换了会话、开关了别的标签，按现在的算。
	const { tabs, active } = state.panelTabs[scope] ?? tabsOf(state, scope);
	const index = tabs.findIndex((tab) => tab.id === id);
	if (index < 0) return;
	const rest = tabs.filter((tab) => tab.id !== id);
	if (rest.length === 0) {
		update({ panelMaximized: { ...state.panelMaximized, [scope]: false } });
		setTabs(scope, undefined);
		if (scope === scopeOf(state) && state.panelOpen) togglePanel(false);
		return;
	}
	setTabs(scope, { tabs: rest, active: active === id ? (rest[index] ?? rest[index - 1])!.id : active });
}

/** 每个标签给面板的 setTitle、onClose，同一个标签一直是同一对函数：面板拿它们进 effect 的依赖也不会反复重跑。 */
const tabHandles = new Map<string, Pick<PanelProps, "setTitle" | "onClose">>();

function handlesOf(id: string): Pick<PanelProps, "setTitle" | "onClose"> {
	let handles = tabHandles.get(id);
	if (!handles) {
		handles = {
			setTitle: (title) =>
				update((current) => {
					const scope = Object.keys(current.panelTabs).find((key) => current.panelTabs[key]!.tabs.some((tab) => tab.id === id && tab.title !== title));
					if (scope === undefined) return {};
					const entry = current.panelTabs[scope]!;
					const tabs = entry.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab));
					const panelTabs = { ...current.panelTabs, [scope]: { ...entry, tabs } };
					persistTabs(panelTabs);
					return { panelTabs };
				}),
			onClose: (handler) => {
				closeGuards.set(id, handler);
				return () => {
					if (closeGuards.get(id) === handler) closeGuards.delete(id);
				};
			},
		};
		tabHandles.set(id, handles);
	}
	return handles;
}

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
	const navOpen = compact ? drawerOpen : sidebarOpen;
	const pushed = !compact && sidebarOpen;
	const width = sidebarWidthFor(sidebarWidth, windowWidth);
	const titlebar = useTitlebar(window.plume.platform, fullScreen);
	// 面板只跟着工作区，设置页不画。工作区里收起时也挂着，只是藏起来：面板里的状态留着，开合才有东西可滑。
	// 插件运行中装卸时面板跟着出现、消失。
	usePluginUis();
	const panelInWorkspace = screen === "chat" && listPanels().length > 0;
	// 页面自己画顶行（PageOptions.topRow）时，标题栏和它下面的占位都让给页面，见下面的 --plume-top-row-*。
	const ownTopRow = screen.startsWith("page:") && listPages().some((entry) => `page:${entry.key}` === screen && entry.topRow);
	// 侧栏收起时红绿灯和前进、后退浮在卡片左上角，顶行从它们右边开始放东西；有顶上那条带子时它们在带子里，卡片不用让。
	const topInset = pushed || HEADER_BAR ? undefined : toolbarReserved(titlebar.start) - CARD_INSET - 1;
	const available = windowWidth - (pushed ? width : 0);
	useLayoutEffect(() => {
		if (!panelWindow && panelWidth === 0) setPanel({ width: available * 0.4 });
	}, [available, panelWidth]);
	useEffect(() => {
		if (!app.panelLeaving) return;
		// 减少动态效果、切页或窗口缩放可能取消 transitionend，资源仍必须收掉。
		const token = getComputedStyle(document.documentElement).getPropertyValue("--plume-t-base").trim();
		const duration = parseFloat(token) * (token.endsWith("ms") ? 1 : 1000);
		const timer = setTimeout(finishPanelLeave, Number.isFinite(duration) ? duration + 50 : 0);
		return () => clearTimeout(timer);
	}, [app.panelLeaving]);
	// 只在点开关的那一下加动画，动画结束就撤掉，见 SLIDE_MOTION。
	const [moving, setMoving] = useState(false);

	const toggle = () => {
		setMoving(true);
		if (compact) update({ drawerOpen: !drawerOpen });
		else setSidebar({ open: !sidebarOpen });
	};

	// ⌘B 开合侧栏，设置页里开合的是章节列表。
	useEffect(() => {
		if (panelWindow) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.repeat || composingKey(event)) return;
			if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && shortcutLetter(event) === "b") {
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
		if (!compact || !drawerOpen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") update({ drawerOpen: false });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [compact, drawerOpen]);

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
			if (state.panelOpen && tabs.find((tab) => tab.id === active)?.panel === panel.key) togglePanel(false);
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
		</>
	);

	const body = (
		<>
			<aside
				aria-label={t("app.sidebar")}
				inert={!navOpen}
				// 抽屉自己铺侧栏色，吸顶的标题跟着它，不跟外圈（styles.css 的 `[data-plume-head]`）。
				data-plume-drawer={compact || undefined}
				// 只认侧栏自己的：里面的行悬停也有 transition，结束事件会冒泡上来。
				onTransitionEnd={(event) => event.target === event.currentTarget && setMoving(false)}
				className={`${moving ? `${SLIDE_MOTION} duration-[var(--plume-t-slow)]` : ""} ${
					compact
						? `absolute inset-y-0 left-0 z-20 border-r border-line bg-sidebar ${drawerOpen ? "" : "-translate-x-full"}`
						: "relative shrink-0 overflow-hidden"
				}`}
				style={{ width: compact ? Math.min(sidebarWidth, windowWidth - 48) : pushed ? width : 0 }}
			>
				{/* 里面定宽：收起时只是被裁掉，文字不跟着宽度一起挤。 */}
				<div className="flex h-full flex-col" style={{ width: compact ? Math.min(sidebarWidth, windowWidth - 48) : width }}>
					<SidebarContent />
				</div>
			</aside>
			{compact && drawerOpen && <div className="absolute inset-0 z-10 bg-ink/20" aria-hidden onClick={() => update({ drawerOpen: false })} />}
			<div className="relative isolate min-h-0 min-w-0 flex-1 overflow-hidden" style={{ margin: CARD_INSET }}>
				{/* 设置页只盖住工作区，常驻网页仍留在同一层、同一节点。 */}
				<div inert={screen !== "chat"} className={`absolute inset-0 flex ${screen === "chat" ? "" : "invisible"}`}>
					<ChatScreen
						inset={topInset}
						fatal={fatal}
						share={verticalShares[scopeOf(app)] ?? 0.4}
						onShare={(share) => setVerticalShares((current) => ({ ...current, [scopeOf(app)]: share }))}
					/>
				</div>
				{screen !== "chat" && (
					<main className="absolute inset-0 flex flex-col">
						<ScreenCard header={ownTopRow ? undefined : <TitleBar inset={topInset} />} fatal={fatal} topInset={topInset}>
							<Main />
						</ScreenCard>
					</main>
				)}
			</div>
			{pushed && <SidebarResizer width={width} max={sidebarWidthFor(Number.POSITIVE_INFINITY, windowWidth)} />}
		</>
	);
	const fill = managedSkin ? "bg-root" : window.plume.vibrancy ? "bg-window-tint" : "bg-sidebar";

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
			// 停靠的侧栏透明，吸顶的标题要铺和这一层一样的底（styles.css 的 `[data-plume-head]`）。
			data-plume-head-fill={managedSkin ? "root" : "window"}
		>
			{body}
			{/* 设置页顶上整条都能拖窗口，连同卡片上方和侧栏、卡片之间的缝。放在侧栏开关前面：拖拽区按文档顺序合成，开关的洞要后挖。 */}
			{screen === "settings" && <div aria-hidden className={`absolute inset-x-0 top-0 z-30 ${DRAG}`} style={{ height: TOP_ROW_HEIGHT }} />}
			<div className={`absolute z-30 flex items-center gap-0.5 ${NO_DRAG}`} style={{ left: titlebar.start, top: ROW_OFFSET, height: TOP_ROW_HEIGHT }}>
				{toolbar}
			</div>
			<ImageViewerHost />
			<Toaster onInvestigate={investigate} onOpenSession={openNoticeSession} />
		</div>
	);
}

/** 弹出去的标签不占这一屏的位置，当前标签移交给仍留在屏内的一个。 */
function panelGroup(app: Chrome, scope: string): PanelTabs {
	const group = tabsOf(app, scope);
	const tabs = group.tabs.filter((tab) => !app.panelWindows.some((entry) => entry.tab === tab.id));
	return { tabs, active: tabs.some((tab) => tab.id === group.active) ? group.active : (tabs.at(-1)?.id ?? "") };
}

function panelLayout(app: Chrome, size: { width: number; height: number }, share: number) {
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

const PANEL_MOTION = "transition-[right,bottom,width,height,translate] duration-[var(--plume-t-base)] ease-out";

/** 对话和面板共用工作区尺寸；常驻标签不随会话切换搬动 DOM。 */
function ChatScreen({ inset, fatal, share, onShare }: { inset?: number; fatal?: string; share: number; onShare(share: number): void }) {
	const app = useChrome();
	const { t } = useI18n();
	usePluginUis();
	const scope = scopeOf(app);
	const root = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	useLayoutEffect(() => {
		const element = root.current;
		if (!element) return;
		const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const layout = panelLayout(app, size, share);
	const motion = app.panelMoving ? PANEL_MOTION : "";
	useEffect(() => {
		if (app.screen !== "chat" || !layout.shown || !layout.single) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || composingKey(event)) return;
			if (app.panelMaximized[scope]) update({ panelMaximized: { ...state.panelMaximized, [scope]: false } });
			else togglePanel(false, scope);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [app.screen, layout.shown, layout.single, app.panelMaximized, scope]);
	return (
		<div ref={root} data-panel-layout={layout.arrangement} className="relative min-h-0 flex-1 overflow-hidden rounded-panel">
			<main
				inert={layout.single && layout.shown}
				style={layout.chat}
				className={`absolute left-0 top-0 flex min-h-0 min-w-0 flex-col ${motion} ${layout.single && layout.shown ? "invisible" : ""}`}
			>
				<ScreenCard header={<TitleBar inset={inset} />} fatal={fatal}>
					<CurrentChat />
				</ScreenCard>
			</main>
			{listPanels().length > 0 && (
				<aside
					aria-label={t("panel.area")}
					data-panel-area={scope}
					inert={!layout.shown}
					className={`plume-panel plume-freeze absolute flex flex-col ${motion} ${layout.single && !layout.shown ? "invisible" : ""}`}
					style={layout.panel}
					onTransitionEnd={(event) => {
						if (event.target === event.currentTarget) {
							update({ panelMoving: false });
							finishPanelLeave();
						}
					}}
				>
					<PanelArea
						scope={scope}
						maximized={app.panelMaximized[scope]}
						compact={layoutMode(app.windowWidth) === "compact"}
						arrangement={layout.arrangement}
						inset={layout.single ? inset : undefined}
					/>
				</aside>
			)}
			<PanelLayer layout={layout} />
			{layout.shown && !layout.single && !layout.stacked && (
				<PanelResizer width={layout.panelWidth} windowWidth={size.width} max={panelWidthFor(Number.POSITIVE_INFINITY, size.width - CARD_INSET, 0)} />
			)}
			{layout.shown && layout.stacked && (
				<Splitter
					containerRef={root}
					handle={{
						dir: "col",
						path: [],
						index: 0,
						left: 0,
						top: 1 - layout.panelHeight / size.height,
						width: 1,
						height: 0,
						share: 1 - layout.panelHeight / size.height,
						pair: 1,
						split: { left: 0, top: 0, width: 1, height: 1 },
					}}
					onResize={(value) => onShare(1 - value)}
					onEven={() => onShare(0.5)}
				/>
			)}
		</div>
	);
}

/** 标题栏只盖住对话那一栏；自己画顶行的页面不传 header。 */
function ScreenCard({ header, fatal, topInset, children }: { header?: ReactNode; fatal?: string; topInset?: number; children: ReactNode }) {
	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-line-float bg-shell">
			{header}
			{header && <div aria-hidden className="shrink-0" style={{ height: TOP_ROW_HEIGHT }} />}
			{fatal && (
				<p className="bg-danger px-6 py-2 text-detail text-shell" role="alert">
					{fatal}
				</p>
			)}
			{/*
			 * 自己画顶行的页面从卡片顶边开始，顶行的高度、左边要让出的宽度经这两个变量给它：页面里的两栏才能
			 * 像侧栏一样从顶边通到底，分隔线不在半空起头。不是 token，皮肤改不了。
			 */}
			<div
				className="flex min-h-0 flex-1 flex-col"
				style={{ "--plume-top-row-height": `${TOP_ROW_HEIGHT}px`, "--plume-top-row-inset": `${topInset ?? 0}px` } as CSSProperties}
			>
				{children}
			</div>
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

/** 独立窗口浮在别的应用上面：查资料、对着别的窗口干活时，这段对话或这块面板一直在手边。 */
function KeepOnTopButton({ keepOnTop }: { keepOnTop: (enabled?: boolean) => Promise<boolean> }) {
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

/** 把手独立定位在侧栏右边界，避免被侧栏的溢出裁切。 */
function SidebarResizer({ width, max }: { width: number; max: number }) {
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

/** 把手放在两张卡片的缝内，独立于面板的溢出裁切。 */
function PanelResizer({ width, windowWidth, max }: { width: number; windowWidth: number; max: number }) {
	const { t } = useI18n();
	const resize = (next: number) => setPanel({ width: clamp(Math.round(next), PANEL_MIN, max) });
	return (
		<div className="absolute inset-y-0 w-0" style={{ left: windowWidth - width - 1 }}>
			<ResizeHandle edge="start" width={width} min={PANEL_MIN} max={max} onResize={resize} onReset={() => resize(windowWidth / 2)} label={t("panel.resize")} />
		</div>
	);
}

/** 内容按首次挂载的顺序追加，切换会话不能让 React 移动 webview 的 DOM。 */
function PanelLayer({ layout }: { layout: ReturnType<typeof panelLayout> }) {
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
function PanelArea({
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

/** 侧栏里放什么：工作区是会话列表，设置页是章节列表。开关、拖宽度、抽屉两边共用。 */
function SidebarContent() {
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

/**
 * 卡片的顶行：会话标题和操作菜单，有插件注册了面板时右端是面板开关，其余界面只是一条可拖动的空行。
 */
function TitleBar({ inset }: { inset?: number }) {
	const { t } = useI18n();
	const app = useChrome();
	const { screen, panelOpen, panelMoving } = app;
	usePluginUis();
	// 只要摘要：草稿每一拍换的是视图，摘要还是同一个对象，标题栏不跟着重画。会话自己的工具栏单独订阅视图。
	const session = useAppPick((current) => current.view?.summary);
	const chat = screen === "chat" && session;
	// 开始页上有东西可开，或者这个会话已经开着面板标签（本体的文件标签不在开始页上）。
	const panelToggle =
		screen === "chat" &&
		!panelOpen &&
		(listPanels(nextTurnCwd(app, session), app.currentId !== undefined).some((panel) => panel.listed) || tabsOf(app).tabs.some((tab) => tab.panel));
	return (
		<header
			className={`absolute inset-x-0 top-0 z-10 flex items-center ${chat ? "gap-1.5 pl-2.5" : "gap-3 pl-6"} ${panelToggle ? "pr-3" : "pr-6"} ${CARD_DRAG}`}
			style={{ height: TOP_ROW_HEIGHT, ...(inset === undefined ? {} : { paddingLeft: inset }) }}
		>
			{chat && <SessionTitle key={session.id} session={session} />}
			{chat && (
				<div className={`ml-auto flex shrink-0 items-center gap-0.5 ${NO_DRAG}`}>
					<CurrentSessionToolbar />
				</div>
			)}
			{screen === "market" && (
				<div className="flex min-w-0 flex-1 items-center">
					<MarketToolbar onCreate={createPlugin} />
				</div>
			)}
			{panelToggle && (
				<div className={`${chat ? "" : "ml-auto"} flex shrink-0 items-center gap-0.5 ${NO_DRAG}`}>
					{/* 刚收起时等面板滑走再淡入开关。 */}
					<span data-panel-toggle="" className={panelMoving ? "plume-panel-toggle-in" : ""}>
						<IconButton label={t("panel.show")} expanded={false} icon={<PanelIcon />} onClick={() => togglePanel(true)} />
					</span>
				</div>
			)}
		</header>
	);
}

/** 按会话挂载，切换时不把上一段会话的菜单或未保存标题带过去。 */
function SessionTitle({ session }: { session: SessionSummary }) {
	const { t, resolvedLocale } = useI18n();
	const { projects, sessions } = useChrome();
	const menu = usePopover();
	const confirm = useConfirmer();
	const remove = (sessionIds: string[]) =>
		void (async () => {
			for (const id of sessionIds) await agent.deleteSession(id);
		})().catch((error: unknown) => notify(errorText(error), "error"));
	return (
		<>
			<Folder size={15} strokeWidth={1.7} aria-hidden className="shrink-0 text-ink-faint" />
			<span data-plume-screen-title className="min-w-0 shrink-[1000] truncate text-label text-ink select-none">
				{session.title || t("sessionOps.newSession")}
			</span>
			<div className={`flex shrink-0 ${NO_DRAG}`}>
				<ToolbarButton label={t("sessionMenu.actions")} onClick={menu.toggle} active={menu.open} menu={menu.open}>
					<MoreHorizontal size={15} strokeWidth={2} />
				</ToolbarButton>
			</div>
			{menu.open && (
				<SessionMenu
					anchor={menu.anchor}
					below
					session={session}
					onClose={menu.close}
					onRequestDelete={() => void deleteSessionQuestion(session, sessions, resolvedLocale, remove).then(confirm.ask)}
					projects={projects}
					actions={sidebarActions}
				/>
			)}
			{confirm.element}
		</>
	);
}

/**
 * 跟着会话的卡片（`ui.conversationCard`）浮得下：对话那一列放得下 320px 的卡片、离边 32px，还剩 420px 正文。
 * 量的是这一列不是窗口：面板区开着时，宽窗口里的正文也可能只剩一条，卡片就该回到输入框上方。
 */
const CARD_FLOAT_WIDTH = 320 + 32 + 420;
/**
 * 右边那一列（`lane` 的卡片，环境卡片）：卡片 300 宽，右边距 12，和正文之间再留 12。
 * 让出这一列以后正文还有 520px 时停靠，正文和输入框整体往左让，卡片不盖住字；不够宽就浮在转录上，这时让位会把正文挤成一条缝。
 */
const LANE_WIDTH = 300 + 24;
const LANE_DOCK_WIDTH = LANE_WIDTH + 520;

/** 卡片上的按钮（暂停、继续）做的事，和输入框的停止按钮、转录底下的「继续」是同一件。 */
function cardActions(sessionId: string): { stop(): void; carryOn(text: string): void } {
	return {
		stop: () => void agent.stop(sessionId),
		carryOn: (text) => carryOn(sessionId, String(text)),
	};
}

function useCardRoom(column: HTMLElement | null): { float: boolean; dock: boolean } {
	const [room, setRoom] = useState({ float: false, dock: false });
	useEffect(() => {
		if (!column) return;
		const measure = () => {
			const width = column.clientWidth;
			const float = width >= CARD_FLOAT_WIDTH;
			const dock = width >= LANE_DOCK_WIDTH;
			setRoom((before) => (before.float === float && before.dock === dock ? before : { float, dock }));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(column);
		return () => observer.disconnect();
	}, [column]);
	return room;
}

/**
 * 右边那一列里有没有卡片：`lane` 的卡片没东西可说时返回 null，宿主事先不知道，只能看画出来没有。
 * 只数卡片本身，排在它们下面的别的卡片（`data-lane-others`）不算，否则「有卡片才把别的搬进来」会自己撑住自己。
 */
function useLaneOpen(lane: HTMLElement | null): boolean {
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		if (!lane) return;
		const measure = () => setOpen(Array.from(lane.children).some((child) => !child.hasAttribute("data-lane-others")));
		measure();
		const observer = new MutationObserver(measure);
		observer.observe(lane, { childList: true });
		return () => observer.disconnect();
	}, [lane]);
	return open;
}

/** 插件页面收到的：打开着的会话，和当前工作区（打开着的会话的，没打开时是空白页选着的项目或目录）。 */
function pageProps(view: SessionView | undefined, target: SessionTarget): PageProps {
	if (view) return { session: view, workspace: { ...(view.summary.project ? { project: view.summary.project } : {}), cwd: view.summary.cwd } };
	return target.project || target.cwd ? { workspace: target } : {};
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

/** 一屏的正文：没有会话、或者会话里还没说过话时是欢迎页，否则是转录和输入框。 */
function ChatBody({ view, loading }: { view?: SessionView; loading: boolean }) {
	const app = useChrome();
	const { projects, windowWidth } = app;
	const [column, setColumn] = useState<HTMLElement | null>(null);
	const room = useCardRoom(column);
	const roomToFloat = room.float;
	const [lane, setLane] = useState<HTMLElement | null>(null);
	const laneOpen = useLaneOpen(lane);
	const docked = laneOpen && room.dock;
	// Windows、Linux 的会话窗口里，标题在窗口顶上那条带子里，卡片顶上没有标题栏。
	const headerHeight = sessionWindow && HEADER_BAR ? 0 : TOP_ROW_HEIGHT;
	if (!view || (!loading && view.messages.length === 0 && !view.draft)) {
		if (!view && loading) return <ChatLoading />;
		const scope = draftScope(view);
		return (
			<section data-screen="empty" className="relative isolate flex min-h-0 flex-1 flex-col">
				<ChatBackdrop empty headerHeight={headerHeight} />
				<Welcome
					project={projects.find((project) => project.id === (view?.summary.project ?? app.target.project))}
					compact={layoutMode(windowWidth) === "compact"}
					onDraft={(value) => {
						setDraft(scope, value);
						focusComposer();
					}}
				>
					<Composer key={scope} view={view} centered />
				</Welcome>
			</section>
		);
	}
	/*
	 * 右边那一列：停靠时挂在整块上（从顶到底，正文和输入框让出它的宽度），浮着时挂在转录那一块里（不压输入框）。
	 * 换地方会重挂卡片，只在宽度跨过停靠线时发生。卡片自己不挡点击，空处点下去还是转录；卡片太长自己滚。
	 * 这一列有卡片、别的卡片也浮得下时，别的卡片排到它下面，不各占一个角互相压着。
	 */
	const laneCards = !loading && (
		<div
			ref={setLane}
			data-conversation-lane={docked ? "docked" : "floating"}
			className={`pointer-events-none absolute top-3 right-3 z-20 flex w-[300px] flex-col gap-3 empty:hidden [&>*]:pointer-events-auto bottom-3`}
		>
			<ConversationCards lane session={view} placement="floating" {...cardActions(view.summary.id)} />
			{laneOpen && roomToFloat && (
				<div data-lane-others="" className="flex shrink-0 flex-col gap-2">
					<ConversationCards lane={false} session={view} placement="floating" {...cardActions(view.summary.id)} />
				</div>
			)}
		</div>
	);
	return (
		// relative isolate：背景图那一层是 z-index: -1，隔离之后压在这一区的底色之上、内容之下。
		<section ref={setColumn} data-screen="chat" className="relative isolate flex min-h-0 flex-1 flex-col">
			<ChatBackdrop empty={!loading && view.messages.length === 0 && !view.draft} headerHeight={headerHeight} />
			{docked && laneCards}
			<div className={`relative flex min-h-0 flex-1 flex-col${docked ? " mr-[324px]" : ""}`}>
				{loading ? <ChatLoading /> : <Conversation view={view} />}
				{!docked && laneCards}
				{/* 浮着的卡片自己不挡点击：卡片之间、卡片旁边的空处点下去还是转录。 */}
				{roomToFloat && !laneOpen && !loading && (
					<div
						data-conversation-cards="floating"
						className="pointer-events-none absolute top-3 right-4 z-20 flex w-[320px] flex-col gap-2 [&>*]:pointer-events-auto"
					>
						<ConversationCards lane={false} session={view} placement="floating" {...cardActions(view.summary.id)} />
					</div>
				)}
			</div>
			<div className={`flex shrink-0 flex-col${docked ? " mr-[324px]" : ""}`}>
				<Composer key={view.summary.id} view={view} cards={!roomToFloat && !loading} />
			</div>
		</section>
	);
}

/** 屏上那个会话的对话。单独订阅视图：草稿每一拍换视图时，重画从这里往下，不从窗口的外壳开始。 */
function CurrentChat() {
	const view = useAppPick((current) => current.view);
	const loading = useAppPick((current) => current.loading);
	if (!view && sessionWindow) return <ChatLoading />;
	return <ChatBody view={view} loading={loading} />;
}

/** 顶行上插件给会话加的按钮：它们拿的是整份视图，跟着视图重画，标题栏的其余部分不用。 */
function CurrentSessionToolbar() {
	const view = useAppPick((current) => current.view);
	return view ? <SessionToolbar session={view} /> : null;
}

/** 只在读得比 select 肯等的久时出现；延迟淡入，刚过那条线就读完的不闪一下转圈。 */
function ChatLoading() {
	return (
		<div role="status" aria-busy="true" className="plume-defer-in flex flex-1 items-center justify-center">
			<ActionSpinner size={20} className="text-ink-faint" />
		</div>
	);
}

// ── 对话 ────────────────────────────────────────────────────────────

function Conversation({ view }: { view: SessionView }) {
	const id = view.summary.id;
	const arrival = useArrival(id);
	// 回复里的文件签按这个会话找文件、读文件，见 `files/scope.ts`。
	const files = useMemo(() => ({ sessionId: id, cwd: view.summary.cwd, touched: touchedPaths(view.messages) }), [id, view.summary.cwd, view.messages]);
	const onCarryOn = useCallback((prompt: string) => carryOn(id, prompt), [id]);
	const onSend = useCallback(
		async (text: string, displayText?: string) => {
			const session = state.sessions.find((item) => item.id === id);
			if (!session) throw new Error("Session no longer exists");
			await enqueue(
				id,
				{ content: [{ type: "text", text }], ...(displayText === undefined ? {} : { displayText }) },
				(displayText ?? text).replace(/\s+/g, " "),
			);
		},
		[id],
	);
	const onOpenSettings = useCallback(() => update({ screen: "settings", settingsSection: "models" }), []);
	const edits = useMemo<MessageEdits>(
		() => ({
			edit: (index, message, text, files) => editMessage(id, index, message, text, files),
			retry: (index, message) => retryMessage(id, index, message),
			revert: (index, message, files) => revertMessage(id, index, message, files),
			revertPlan: async (index, message) => agent.revertPlan(id, index, { timestamp: message.timestamp }),
			fork: (index, message) => forkFrom(id, index, message),
			attachImage: (dataUrl) => attachToComposer(id, dataUrl),
		}),
		[id],
	);
	// 引文挂到这个会话的草稿上，光标回到框里：划下来的是材料，问什么还得人自己说。
	const onQuote = useCallback(
		(quote: DraftQuote) => {
			setQuotes(id, (quotes) => [...quotes, quote]);
			focusComposer();
		},
		[id],
	);
	return (
		<TranscriptScope arrival={arrival} files={files}>
			<Transcript
				view={view}
				onSend={onSend}
				onCarryOn={onCarryOn}
				onOpenSettings={onOpenSettings}
				onQuote={onQuote}
				{...(view.summary.owner ? {} : { edits })}
			/>
		</TranscriptScope>
	);
}

/** 对话里的 Markdown 要的两样上下文：刚露面（`Arrival`）和文件签的会话（`FileScope`）。 */
function TranscriptScope({ arrival, files, children }: { arrival: { fresh: boolean }; files: FileScopeValue; children: ReactNode }) {
	return (
		<Arrival.Provider value={arrival}>
			<FileScope.Provider value={files}>{children}</FileScope.Provider>
		</Arrival.Provider>
	);
}

/** 从队里拿走一条（删除、编辑、交给插件），连同排进来时记下的草稿。已经发出去了就什么都拿不到。 */
async function takeQueued(sessionId: string, id: string): Promise<{ entry: QueuedMessage; draft?: QueuedDraft } | undefined> {
	try {
		const entry = await agent.removeQueued(sessionId, id);
		const draft = queuedDrafts.get(id)?.draft;
		queuedDrafts.delete(id);
		return entry ? { entry, ...(draft ? { draft } : {}) } : undefined;
	} catch (error) {
		notify(errorText(error), "error");
		return undefined;
	}
}

/** 拖动、↑↓ 改排着的先后：`id` 那一条挪到 `targetId` 前面或后面。先在屏上挪好，拖完不弹回去；队伍随后经 `queue` 事件对上。 */
function moveQueued(sessionId: string, id: string, targetId: string, placement: "before" | "after"): void {
	updateView(sessionId, (view) => {
		const moving = view.queue.find((item) => item.id === id);
		const rest = view.queue.filter((item) => item.id !== id);
		const at = rest.findIndex((item) => item.id === targetId);
		if (!moving || at < 0) return {};
		return { queue: rest.toSpliced(at + (placement === "after" ? 1 : 0), 0, moving) };
	});
	void agent.moveQueued(sessionId, id, targetId, placement).catch((error: unknown) => notify(errorText(error), "error"));
}

/**
 * 排进这个会话的队尾。队在 agent 进程里、落盘（`AgentService.queue`）：这一轮以完成结束时由它发下一条，会话空着时排进去
 * 就推起队伍；排上的那一行经 `queue` 事件画出来。排不上时说一声，不悄悄丢掉；返回排没排上，排不上的草稿由调用方放回去。
 */
async function enqueue(sessionId: string, outgoing: OutgoingMessage, preview: string, draft?: QueuedDraft): Promise<boolean> {
	try {
		const entry = await agent.queue(sessionId, outgoing, preview);
		if (draft) queuedDrafts.set(entry.id, { sessionId, draft });
		return true;
	} catch (error) {
		notify(errorText(error), "error");
		return false;
	}
}

/**
 * 没排上的那句整份放回它那个输入框：字、附件、引文、会话引用。只在那个输入框还空着时放——人已经接着打了新的，
 * 不拿旧的盖掉（排不上已经说过一声）。附件的标记和清单出自同一份草稿，原样放回就对得上，不用重新编号。
 */
function restoreUnqueued(scope: string, draft: QueuedDraft): void {
	const empty =
		!(state.drafts[scope] ?? "").trim() &&
		!(state.draftAttachments[scope]?.length ?? 0) &&
		!(state.quotes[scope]?.length ?? 0) &&
		sessionReferences(scope).length === 0;
	if (!empty) return;
	update((current) => ({
		drafts: { ...current.drafts, [scope]: draft.text },
		draftAttachments: { ...current.draftAttachments, [scope]: draft.attachments },
		quotes: { ...current.quotes, [scope]: draft.quotes },
	}));
	setSessionReferences(scope, draft.sessionRefs ?? []);
}

/** 「继续」：以界面的名义发那句话，不画成人的气泡。 */
function carryOn(sessionId: string, prompt: string): void {
	void agent.send(sessionId, { content: [{ type: "text", text: prompt }], synthetic: true }).catch((error: unknown) => notify(errorText(error), "error"));
}

/**
 * 编辑重发：附件原样带上，换的只是人打的那句。截完就回来，新的一轮经事件流到。`files` 为真时先把截掉的那几轮改过的文件退回去，
 * 退回的文件不是一轮写的，改动统计和 Git 面板闲着时不轮询，得叫它们重读。
 */
async function editMessage(sessionId: string, index: number, message: UserMessage, text: string, files = false): Promise<void> {
	reasking = { sessionId };
	try {
		await agent.editMessage(
			sessionId,
			index,
			{
				...withSessionReferences({ content: editedContent(message, text), displayText: text }, message.sessionRefs ?? []),
				displayText: text,
				...(message.attachments?.length ? { attachments: message.attachments } : {}),
			},
			{ files, timestamp: message.timestamp },
		);
	} catch (error) {
		settleReask(sessionId);
		notify(translate("turn.resendFailed", { reason: errorText(error) }), "error");
		return;
	}
	if (files) touchWorkingTree();
}

/** 重试：这条原样再发一遍，正文（含附件正文、会话引用那段）、气泡里的字、附件签都照旧。 */
async function retryMessage(sessionId: string, index: number, message: UserMessage): Promise<void> {
	reasking = { sessionId };
	try {
		await agent.editMessage(
			sessionId,
			index,
			{
				content: message.content,
				...(message.displayText === undefined ? {} : { displayText: message.displayText }),
				...(message.attachments?.length ? { attachments: message.attachments } : {}),
				...(message.sessionRefs?.length ? { sessionRefs: message.sessionRefs } : {}),
			},
			{ timestamp: message.timestamp },
		);
	} catch (error) {
		settleReask(sessionId);
		notify(translate("turn.resendFailed", { reason: errorText(error) }), "error");
	}
}

/** 重问收了场、那句没落进会话：补上压着的那一刀。 */
function settleReask(sessionId: string): void {
	if (reasking?.sessionId !== sessionId) return;
	const { keep } = reasking;
	reasking = undefined;
	if (keep !== undefined) updateView(sessionId, (view) => ({ messages: view.messages.slice(0, keep) }));
}

/** 撤回：截掉这条和之后的，这条连同附件放回输入框。`files` 同编辑重发。 */
async function revertMessage(sessionId: string, index: number, message: UserMessage, files = false): Promise<void> {
	try {
		await agent.revertMessage(sessionId, index, { files, timestamp: message.timestamp });
	} catch (error) {
		notify(translate("turn.revertFailed", { reason: errorText(error) }), "error");
		return;
	}
	if (files) touchWorkingTree();
	await restoreDraft(sessionId, message);
}

/** 分叉：新会话开在这一屏；在问题上分叉的，问题放回新会话的输入框，在回复上分叉的输入框是空的。 */
async function forkFrom(sessionId: string, index: number, message: UserMessage | AssistantMessage): Promise<void> {
	const source = state.sessions.find((session) => session.id === sessionId);
	let forked: SessionSummary;
	try {
		forked = await agent.forkSession(sessionId, index, message.timestamp, translate("messageActions.forkTitle", { title: source?.title ?? "" }));
	} catch (error) {
		notify(`${translate("messageActions.forkFailed")}: ${errorText(error)}`, "error");
		return;
	}
	await select(forked.id);
	if (message.role === "user") await restoreDraft(forked.id, message);
}

/** 一条消息放回这个会话的输入框：字换掉草稿，附件等那个输入框收走（它的附件在它自己手里）。 */
async function restoreDraft(scope: string, message: UserMessage): Promise<void> {
	setSessionReferences(scope, message.sessionRefs ?? []);
	const draft = await draftFromMessage(message);
	update((current) => ({ drafts: { ...current.drafts, [scope]: draft.text }, restored: { ...current.restored, [scope]: draft.attachments } }));
	if (state.currentId === scope) focusComposer();
}

function draftScope(view?: SessionView): string {
	const target = state.target;
	return view?.summary.id ?? `blank:${target.project ?? target.cwd ?? ""}`;
}

function setDraft(scope: string, value: string): void {
	update((current) => ({ drafts: { ...current.drafts, [scope]: value } }));
}

/** 一条要发的话里，放回输入框时要带上的两样：人打的原文和附件清单。 */
function pickSent(outgoing: OutgoingMessage): Pick<UserMessage, "displayText" | "attachments" | "sessionRefs"> {
	return {
		...(outgoing.displayText !== undefined ? { displayText: outgoing.displayText } : {}),
		...(outgoing.attachments ? { attachments: outgoing.attachments } : {}),
		...(outgoing.sessionRefs ? { sessionRefs: outgoing.sessionRefs } : {}),
	};
}

/** 空白页没有消息时的同一个空数组：输入历史按它算，每次新建一个就每次重算。 */
const NO_MESSAGES: Message[] = [];
const NO_QUEUE: QueuedMessage[] = [];

/** 没挂附件时的同一个空数组：附件清单按引用比较，每次新建一个就每次都「变了」。 */
const NO_FILES: DraftAttachment[] = [];

/** 没有引文时的同一个空数组：发送完拿它比引文变没变，每次新建一个就永远「变了」。 */
const NO_QUOTES: DraftQuote[] = [];

function setQuotes(scope: string, change: (quotes: DraftQuote[]) => DraftQuote[]): void {
	update((current) => ({ quotes: { ...current.quotes, [scope]: change(current.quotes[scope] ?? []) } }));
}

/** 光标放回当前对话的输入框。 */
/** 看图器里标注完的图（`data:` URL）挂到这个会话的输入框上，光标回到框里。 */
function attachToComposer(sessionId: string, dataUrl: string): void {
	const file: DraftAttachment = {
		id: crypto.randomUUID(),
		name: translate("annotate.attachmentName"),
		mimeType: /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/png",
		kind: "image",
		data: dataUrl.slice(dataUrl.indexOf(",") + 1),
		isText: false,
	};
	update((now) => ({ appended: { ...now.appended, [sessionId]: [...(now.appended[sessionId] ?? []), file] } }));
	focusComposer();
}

function focusComposer(): void {
	requestAnimationFrame(() => document.querySelector<HTMLElement>("main .cm-content")?.focus());
}

/** 只给刚从欢迎页发出消息的那个会话播放入场，切换会话不能借用这个标记。 */
let composerArrival: { sessionId: string; at: number } | undefined;
const COMPOSER_ARRIVAL_WINDOW = 1000;

/** `cards`：跟着会话的卡片放不下浮在转录上，画在输入框正上方。 */
function Composer({ view, centered = false, cards = false }: { view?: SessionView; centered?: boolean; cards?: boolean }) {
	const { t } = useI18n();
	const app = useChrome();
	const { drafts, target, projects, settings, sending, blankModel, blankThinking, windowWidth } = app;
	const scope = draftScope(view);
	const value = drafts[scope] ?? "";
	const running = view?.summary.running ?? false;
	const project = projects.find((entry) => entry.id === (view?.summary.project ?? app.target.project));
	const cwd = nextTurnCwd(app, view?.summary);
	// 格子里写明了要发什么的按钮（工作树的「交给这个对话解决」）：以人的身份发，和人打字发的一样排队。
	const sendFromChip = (said: string) => {
		const typed = String(said).trim();
		if (view && typed) void enqueue(view.summary.id, { content: [{ type: "text", text: typed }] }, typed.replace(/\s+/g, " "));
	};
	const chip = { ...(view ? { sessionId: view.summary.id } : {}), ...(cwd ? { cwd } : {}), running, send: sendFromChip };
	const model = effectiveModel(useModels(), view?.summary.model ?? blankModel);
	const item = {
		...(view ? { sessionId: view.summary.id } : {}),
		running,
		...(model ? { model: { id: model.id, name: model.name, contextWindow: model.contextWindow } } : {}),
	};
	// 插件给的灰字建议（`ui.composerHint`）：输入框空着时代替占位文字，按 Tab 整段填进去。
	usePluginUis();
	const hint = composerHint(view);
	const hintRef = useRef(hint);
	hintRef.current = hint;
	const hintKey = useMemo(
		() =>
			keymap.of([
				{
					key: "Tab",
					run: (target) => {
						const text = hintRef.current;
						if (!text || target.state.doc.length > 0) return false;
						target.dispatch({ changes: { from: 0, insert: text }, selection: { anchor: text.length } });
						return true;
					},
				},
			]),
		[],
	);
	useEffect(focusComposer, [scope]);
	const column = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (centered) return;
		const arrival = composerArrival;
		composerArrival = undefined;
		if (arrival?.sessionId === scope && performance.now() - arrival.at < COMPOSER_ARRIVAL_WINDOW) column.current?.classList.add("plume-composer-arrive");
	}, [centered, scope]);
	const editor = useRef<EditorView | null>(null);
	const references = useSessionReferences(scope);
	const attachments = useComposerAttachments({
		setText: (change) => setDraft(scope, change(state.drafts[scope] ?? "")),
		editor,
		documentText: async (name, data) => await agent.documentText(name, data),
		notify: (text) => notify(text, "warn"),
		cwd: view?.summary.cwd,
		state: {
			attachments: app.draftAttachments[scope] ?? NO_FILES,
			setAttachments: (files) => update((current) => ({ draftAttachments: { ...current.draftAttachments, [scope]: files } })),
		},
	});
	const history = useInputHistory({
		messages: view?.messages ?? NO_MESSAGES,
		attachments: attachments.attachments.length + references.length,
		onPick: (text, files, refs) => {
			setSessionReferences(scope, refs ?? []);
			setDraft(scope, text);
			attachments.restore(files);
		},
		editor,
		resetKey: scope,
		value,
	});
	/**
	 * 排队条上编辑的那一条整份退回输入框：字、附件接在草稿后面，引文回到引文签。没有草稿的（插件替人发的）
	 * 从要发的那份还原：字是人打的原文（`displayText`），附件连同像素读回来。
	 */
	const takeBackQueued = async (entry: QueuedMessage, saved?: QueuedDraft) => {
		const draft = saved ?? {
			...(await draftFromMessage({ role: "user", content: entry.message.content, timestamp: 0, ...pickSent(entry.message) })),
			quotes: [],
		};
		attachments.takeBack(draft.text, draft.attachments);
		setSessionReferences(scope, [...sessionReferences(scope), ...(draft.sessionRefs ?? entry.message.sessionRefs ?? [])]);
		if (draft.quotes.length > 0) setQuotes(scope, (current) => [...current, ...draft.quotes]);
		focusComposer();
	};
	const quoted = app.quotes[scope] ?? NO_QUOTES;
	// 撤回、分叉放回来的附件：整份换上，收走。
	const restored = app.restored[scope];
	useEffect(() => {
		if (!restored) return;
		attachments.restore(restored);
		update((current) => {
			const { [scope]: _taken, ...rest } = current.restored;
			return { restored: rest };
		});
		// `attachments` 每次渲染都是新的；只在有东西要放回时做一次。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, [restored, scope]);
	// 插件接在草稿后面的图片：追加，标记落在正文最后。
	const appended = app.appended[scope];
	useEffect(() => {
		if (!appended) return;
		attachments.append(appended);
		update((current) => {
			const { [scope]: _taken, ...rest } = current.appended;
			return { appended: rest };
		});
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 同上，只在插件接来图片时追加一次
	}, [appended, scope]);
	// 只带附件、或者只带引文、没打字的也能发：它同样是一条消息。
	const canSend = Boolean(value.trim()) || attachments.attachments.length > 0 || quoted.length > 0 || references.length > 0;
	// 插件请这个输入框直接发（`ui.draftInSession`）：等交来的附件挂上了再发，见 `autoSend`。
	const sendNow = app.autoSend === scope && !appended && Boolean(value.trim());
	const queued = view?.queue ?? NO_QUEUE;
	const queueActions = useQueueActions();
	const commands = useCommands({
		editor,
		...(cwd ? { cwd } : {}),
		...(view ? { sessionId: view.summary.id } : {}),
		list: async (context) => await agent.listCommands(context),
		onSubmit: () => void send(),
		onError: (message) => notify(message, "error"),
	});
	const mentions = useMentions({
		editor,
		agent,
		cwd,
		sessionId: view?.summary.id,
		target,
		sessions: app.sessions,
		projects,
		onSession: (ref) => setSessionReferences(scope, [...sessionReferences(scope), ref]),
	});

	const expanding = useRef(false);
	/**
	 * 行首是一条认得的命令时先办它：产品自己的动作就地做掉、不发消息（null）；插件的交给插件展开成要发的话。
	 * 名单在这一刻重新问一遍；问的时候草稿改了、换了对话，这一下作废（null），不误发。不是命令就是 undefined，原文照发。
	 */
	const runCommand = async (): Promise<CommandExpansion | null | undefined> => {
		const invocation = parseInvocation(value.trim());
		if (!invocation) return undefined;
		const stillCurrent = () => (state.drafts[draftScope(state.view)] ?? "") === value && draftScope(state.view) === scope;
		const command = resolveCommand(await commands.fresh(), invocation.name);
		if (!stillCurrent()) return null;
		if (command?.action === "clear") {
			if (attachments.attachments.length > 0 || quoted.length > 0 || references.length > 0) notify(t("command.noFiles"), "warn");
			else if (invocation.rest) notify(t("command.noArgs"), "warn");
			else {
				setDraft(scope, "");
				openNew(view ? (view.summary.project ? { project: view.summary.project } : {}) : state.target);
			}
			return null;
		}
		if (!command?.plugin) return undefined;
		if (command.name === "compact" && (attachments.attachments.length || quoted.length || references.length)) {
			notify(t("command.noFiles"), "warn");
			return null;
		}
		const result = await agent.expandCommand(command.plugin, command.name, invocation.rest, {
			...(cwd ? { cwd } : {}),
			...(view ? { sessionId: view.summary.id } : {}),
		});
		if (!stillCurrent()) return null;
		// 插件自己办掉了（`/btw` 问到侧边聊天里）：这句话不进当前对话，输入框清空，要开面板、设置的开它（只开它自己注册的）。
		if ("handled" in result) {
			setDraft(scope, "");
			if (result.openPanel) showPanel(`${command.plugin}/${result.openPanel}`, true);
			const settingsKey = `${command.plugin}/${result.openSettings}`;
			if (result.openSettings && listSettingsSections().some((section) => section.key === settingsKey))
				update({ screen: "settings", settingsSection: `plugin:${settingsKey}`, drawerOpen: false });
			return null;
		}
		return result;
	};
	const send = async () => {
		if (!canSend || state.sending || !settings?.defaultModel || expanding.current) return;
		let command: CommandExpansion | null | undefined;
		expanding.current = true;
		try {
			command = await runCommand();
		} catch (error) {
			notify(errorText(error), "error");
			return;
		} finally {
			expanding.current = false;
		}
		if (command === null) return;
		// 发给模型的是展开后的话，引文接在它后面；排队条上写的是人打的原文。
		const said = withQuotes(command?.text ?? value.trim(), quoted);
		const typed = withQuotes(value.trim(), quoted);
		const outgoing = withSessionReferences(
			command?.displayText === undefined ? attachments.outgoing(said) : { ...attachments.outgoing(said), displayText: withQuotes(command.displayText, quoted) },
			references,
		);
		/*
		 * 忙的时候排队；队里还有前面的也排，否则这句会越过前面那几句先到。命令自己声明了 `steer` 的除外：写命令的人说清楚了
		 * 「这条就是要插进正在跑的那一轮」，队列不该替他改主意。
		 */
		const steering = command?.deliver === "steer";
		if (view && !steering && (running || queued.length > 0)) {
			// 先清空再等排队的结果：连按两下回车不会把同一句排两遍；排不上再放回来。
			const draft: QueuedDraft = { text: value, attachments: attachments.attachments, quotes: quoted, sessionRefs: references };
			void enqueue(
				view.summary.id,
				outgoing,
				typed || formatList([...attachments.attachments.map((item) => item.name), ...references.map((ref) => ref.title)]),
				draft,
			).then((queuedOk) => {
				if (!queuedOk) restoreUnqueued(scope, draft);
			});
			setDraft(scope, "");
			setQuotes(scope, () => []);
			setSessionReferences(scope, []);
			attachments.clear();
			return;
		}
		if (running && !steering) return;
		update({ sending: scope });
		let id = view?.summary.id;
		try {
			if (!id) {
				const summary = await agent.createSession(target);
				id = summary.id;
				setDraft(id, value);
				// 创建期间可以离开；迟到的结果不能把人从另一个会话拉回来。
				if (!state.currentId && state.target === target && state.screen === "chat") {
					const draftTabs = state.panelTabs[""];
					if (draftTabs) {
						for (const tab of draftTabs.tabs) tabHandles.delete(tab.id);
						setTabs("", undefined);
						setTabs(id, draftTabs);
					}
					update({
						currentId: id,
						view: { summary, messages: [], progress: {}, startedAt: {}, hiccups: [], compactions: [], compactionRuns: [], compacting: false, queue: [] },
					});
				}
				if (blankModel) await agent.setSessionModel(id, blankModel);
				if (blankThinking) await agent.setSessionThinking(id, blankThinking);
			}
			if (centered && state.currentId === id && state.screen === "chat") composerArrival = { sessionId: id, at: performance.now() };
			// 空闲时带着它也只是开新的一轮；一直带上，界面晚一拍才知道会话又跑起来了的时候也插得进去。
			await agent.send(id, steering ? { ...outgoing, steer: true } : outgoing);
			if (sessionReferences(scope) === references) setSessionReferences(scope, []);
			if (state.drafts[scope] === value) {
				setDraft(scope, "");
				attachments.clear();
			}
			// 发送期间又引了一段的，留给下一句。
			if ((state.quotes[scope] ?? NO_QUOTES) === quoted) setQuotes(scope, () => []);
			if (id !== scope && state.drafts[id] === value) setDraft(id, "");
		} catch (error) {
			if (composerArrival?.sessionId === id) composerArrival = undefined;
			notify(errorText(error), "error");
		} finally {
			update({ sending: undefined });
		}
	};
	useEffect(() => {
		if (!sendNow) return;
		update({ autoSend: undefined });
		void send();
		// `send` 每次渲染都是新的；只在该发的那一刻发一次。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, [sendNow]);
	return (
		<div
			className="plume-composer-dock shrink-0"
			data-center={centered || undefined}
			data-compact={(!centered && layoutMode(windowWidth) === "compact") || undefined}
		>
			{/* 外层管离窗格的边距，这一层把内容收进对话那一列，和上面的消息左右对齐。 */}
			<div ref={column} className="mx-auto w-full max-w-[var(--plume-content)]">
				{/* 从这个会话交出去的会话此刻怎么样了，排在清单卡片上面，见 `HandedOffStrip`。 */}
				{view && !centered && <HandedOffStrip parentId={view.summary.id} sessions={app.sessions} />}
				{view && cards && (
					<div data-conversation-cards="inline" className="flex flex-col gap-2 pb-2 empty:hidden">
						<ConversationCards lane={false} session={view} placement="inline" {...cardActions(view.summary.id)} />
					</div>
				)}
				{view && <ComposerAbove session={view} />}
				{/* 等人决定的那一次调用压在输入框正上方，对话在它上面照样能翻。 */}
				{view && (
					<ApprovalOverlay
						request={view.approval}
						queued={view.queuedApprovals}
						sessionId={view.summary.id}
						compact={layoutMode(windowWidth) === "compact"}
						respond={async (decision) => {
							if (view.approval) await agent.respond(view.summary.id, view.approval.toolCallId, decision);
						}}
						answer={async (value) => {
							if (view.approval) await agent.answer(view.summary.id, view.approval.toolCallId, value);
						}}
					/>
				)}
				{view && <ChildApprovals parentId={view.summary.id} sessions={app.sessions} compact={layoutMode(windowWidth) === "compact"} />}
				{settings && !settings.defaultModel && (
					<div data-warning="no-model" className="mb-2 flex flex-wrap items-center gap-2 text-detail text-ink-muted">
						<span>{t("chat.noModel")}</span>
						<Button onClick={() => update({ screen: "settings", settingsSection: "models" })}>{t("settings.models")}</Button>
					</div>
				)}
				{view && (
					<QueuedMessages
						items={queued}
						running={running}
						onSendNow={(id) => void agent.sendQueued(view.summary.id, id).catch((error: unknown) => notify(errorText(error), "error"))}
						onRemove={(id) => void takeQueued(view.summary.id, id)}
						onEdit={async (id) => {
							const taken = await takeQueued(view.summary.id, id);
							if (taken) await takeBackQueued(taken.entry, taken.draft);
						}}
						onMove={(id, targetId, placement) => moveQueued(view.summary.id, id, targetId, placement)}
						actions={queueActions}
						onAction={async (id, action) => {
							const taken = await takeQueued(view.summary.id, id);
							if (taken) action.run(taken.entry.message, view.summary.id);
						}}
					/>
				)}
				{/* 菜单贴着整个输入框的上沿往上长，和它一样宽。 */}
				<div className="plume-composer-tray relative">
					{commands.menu}
					{mentions.menu}
					<ProjectPicker project={project} projects={projects} actions={sidebarActions} onChoose={openNew} disabled={sending !== undefined}>
						<ComposerChips side="start" {...chip} />
						<div className="min-w-2 flex-1" />
						<ComposerChips side="end" {...chip} />
					</ProjectPicker>
					<ComposerShell
						value={value}
						onChange={(next) => {
							setDraft(scope, next);
							attachments.reconcile(next);
						}}
						onSubmit={() => void send()}
						placeholder={hint ?? t("composer.plumePlaceholder")}
						// 两张菜单不会同时开：`@` 开着就说它，否则说 `/` 那张。
						combobox={mentions.combobox.open ? mentions.combobox : commands.combobox}
						top={
							<>
								{quoted.length > 0 && (
									<div className="plume-composer-attachments">
										<QuoteChip quotes={quoted} onRemove={(id) => setQuotes(scope, (quotes) => quotes.filter((quote) => quote.id !== id))} />
									</div>
								)}
								{references.length > 0 && (
									<div className="plume-composer-attachments">
										<SessionReferences
											references={references}
											onRemove={(id) =>
												setSessionReferences(
													scope,
													references.filter((ref) => ref.id !== id),
												)
											}
										/>
									</div>
								)}
								{attachments.tray}
							</>
						}
						extensions={[attachments.extension, commands.extension, mentions.extension, history.extension, hintKey]}
						historyPosition={history.position}
						editorRef={editor}
						onFiles={(picked) => void attachments.addFiles(picked)}
						left={
							<>
								{attachments.addButton}
								<PermissionChip onError={(message) => notify(message, "error")} />
								<ComposerItems side="start" {...item} />
							</>
						}
						right={
							<>
								<ComposerItems side="end" {...item} />
								<ComposerModels view={view} disabled={sending !== undefined} />
								<ComposerSend
									running={running}
									disabled={!canSend || sending !== undefined || !settings?.defaultModel}
									onSend={() => void send()}
									onStop={() => {
										if (view) void agent.stop(view.summary.id);
									}}
								/>
							</>
						}
					/>
				</div>
				{attachments.menu}
			</div>
		</div>
	);
}

/**
 * 这个会话的子会话（侧边聊天、子 Agent）在等人批准：卡片照样压在主输入框上方，人的视线在这里；卡上写明是哪个子会话在问。
 * 只看正在跑的：没在跑的不会在等。
 */
function ChildApprovals({ parentId, sessions, compact }: { parentId: string; sessions: readonly SessionSummary[]; compact: boolean }) {
	const children = useMemo(() => conversationDescendants(parentId, sessions).filter((session) => session.running), [sessions, parentId]);
	return children.map((child) => <ChildApproval key={child.id} sessionId={child.id} compact={compact} />);
}

function ChildApproval({ sessionId, compact }: { sessionId: string; compact: boolean }) {
	const view = useLiveSession(sessionId);
	const approval = view?.approval;
	if (!view || !approval) return null;
	return (
		<ApprovalOverlay
			request={approval}
			queued={view.queuedApprovals}
			sessionId={sessionId}
			compact={compact}
			from={view.summary.title}
			respond={async (decision) => await agent.respond(sessionId, approval.toolCallId, decision)}
			answer={async (value) => await agent.answer(sessionId, approval.toolCallId, value)}
		/>
	);
}

/** 回执条上的操作：「立即执行」「撤回」就是父会话排队条上的「现在就发」和拿掉那一条。 */
const TASK_ACTIONS: TaskActions = {
	runNow: (parentId, taskId) => void agent.sendQueued(parentId, taskId).catch((error: unknown) => notify(errorText(error), "error")),
	withdraw: async (parentId, taskId) => {
		const entry = await agent.removeQueued(parentId, taskId).catch((error: unknown) => {
			notify(errorText(error), "error");
			return undefined;
		});
		return entry && (entry.message.displayText ?? entry.preview);
	},
	retry: (sideId, taskId) => void agent.retryTask(sideId, taskId).catch((error: unknown) => notify(errorText(error), "error")),
	dismiss: (sideId, taskId) => void agent.dismissTask(sideId, taskId).catch((error: unknown) => notify(errorText(error), "error")),
};

/** 插件的 `ui.Conversation`：引用到的是当前对话的输入框，「去设置」去模型设置。 */
function PluginConversation(props: ConversationProps) {
	const onOpenSettings = useCallback(() => update({ screen: "settings", settingsSection: "models" }), []);
	const onQuote = useCallback((quote: DraftQuote) => {
		setQuotes(draftScope(state.view), (quotes) => [...quotes, quote]);
		focusComposer();
	}, []);
	// 插件开了 `reask` 时，人在子会话里说的最后一句能编辑重问；截掉的那几轮没碰主对话的文件，不问要不要退。
	const { sessionId, reask } = props;
	const edits = useMemo<MessageEdits | undefined>(
		() =>
			reask && sessionId
				? {
						aside: true,
						edit: async (index, message, text) => await editMessage(sessionId, index, message, text),
						retry: async (index, message) => await retryMessage(sessionId, index, message),
					}
				: undefined,
		[reask, sessionId],
	);
	return (
		<ChildConversation
			{...props}
			{...(edits ? { edits } : {})}
			tasks={TASK_ACTIONS}
			documentText={async (name, data) => await agent.documentText(name, data)}
			onOpenSettings={onOpenSettings}
			onQuote={onQuote}
			respond={async (id, toolCallId, decision) => await agent.respond(id, toolCallId, decision)}
			answer={async (id, toolCallId, value) => await agent.answer(id, toolCallId, value)}
		/>
	);
}

/** 输入框右下角、发送按钮左边：这个会话用哪个模型、想多久。选择记在会话上，下一轮生效；显示的是实际会用的那个。 */
function ComposerModels({ view, disabled }: { view?: SessionView; disabled?: boolean }) {
	const { blankModel, blankThinking } = useChrome();
	const session: ComposerSession = view
		? { ...view.summary, said: view.messages.length > 0 }
		: {
				id: null,
				said: false,
				model: blankModel,
				thinking: blankThinking,
				setModel: (model) => update({ blankModel: model }),
				setThinking: (thinking) => update({ blankThinking: thinking }),
			};
	const onError = (message: string) => notify(message, "error");
	return (
		<div className="flex min-w-0 items-center gap-0.5">
			<ModelTrigger session={session} disabled={disabled} onError={onError} onOpenSettings={() => update({ screen: "settings", settingsSection: "models" })} />
			<EffortTrigger session={session} disabled={disabled} onError={onError} />
		</div>
	);
}

// ── 设置 ────────────────────────────────────────────────────────────

/**
 * 设置页的正文：900px 一列居中，章节内容见 settings/pages.tsx。整页滚动的滚动面铺满窗格、一列放在它里面，
 * 滑块贴着窗格右沿，而不是这一列的右沿。
 * 模型页是左右两个窗格各自滚动，整页不再套一层滚动（否则一屏两个滚动条，外层会把窗格的标题从内容上方推走），
 * 所以它占满高度、自己滚。
 */
function SettingsScreen() {
	const { settingsSection, windowWidth, sidebarOpen, sidebarWidth, sessions, projects } = useChrome();
	const compact = layoutMode(windowWidth) === "compact";
	const selfScrolling = settingsSection === "models";
	/*
	 * 章节列表开合时，这一列一下子取最终的宽度，之后只跟着平移。列表是靠动画侧栏的宽度把正文推开的，正文每一帧都变宽一点；
	 * 页面里的行按容器查询排（`@md` 起说明和控件并排），窗口窄到这一列在滑动途中跨过断点时，页面在半路重排一次，
	 * 文字也一路跟着重新折行。最终宽度是现在的宽度加减侧栏的宽度；滑动期间这一列可能伸出卡片的边，由滚动面裁掉，
	 * 滑完放开，宽度回到 100%（那时正好相等）。窄窗口里侧栏是盖在正文上的抽屉，不推正文，没什么要定住的。
	 */
	const column = useRef<HTMLDivElement>(null);
	const heldFor = useRef(sidebarOpen);
	useLayoutEffect(() => {
		if (heldFor.current === sidebarOpen) return;
		heldFor.current = sidebarOpen;
		const element = column.current;
		const parent = element?.parentElement;
		if (!element || !parent || compact || motionReduced()) return;
		const style = getComputedStyle(parent);
		const inner = parent.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
		const sidebar = sidebarWidthFor(sidebarWidth, windowWidth);
		element.style.setProperty("--plume-settings-hold", `${inner + (sidebarOpen ? -sidebar : sidebar)}px`);
		const release = () => element.style.removeProperty("--plume-settings-hold");
		// 侧栏滑动用的是 `--plume-t-slow`（见 SLIDE_MOTION 的用处），多留一点余量再放开。
		const timer = window.setTimeout(release, DURATION.slow + 60);
		return () => {
			window.clearTimeout(timer);
			release();
		};
	}, [sidebarOpen, compact, sidebarWidth, windowWidth]);
	const page = (
		<div
			ref={column}
			data-screen="settings"
			data-section={settingsSection}
			className={`mx-auto w-[var(--plume-settings-hold,100%)] max-w-[900px] pt-2 ${selfScrolling ? "flex min-h-0 flex-1 flex-col pb-6" : "pb-16"} ${compact ? "px-4" : "px-9"}`}
		>
			{settingsSection === "general" && <GeneralSettings projects={projects} />}
			{settingsSection === "appearance" && <AppearanceSettings />}
			{settingsSection === "personalization" && <PersonalizationSettings />}
			{settingsSection === "models" && <ModelSettings />}
			{settingsSection === "agents" && <AgentsSettings onOpenModelSettings={openModelsSection} />}
			{settingsSection === "storage" && <StorageSettings />}
			{settingsSection === "about" && <AboutSettings />}
			{settingsSection === "archived" && (
				<ArchivedSettings
					sessions={sessions}
					projects={projects}
					onOpen={(sessionId) => {
						update({ screen: "chat" });
						void select(sessionId);
					}}
					onError={(error) => notify(errorText(error), "error")}
				/>
			)}
			{settingsSection.startsWith("plugin:") && <PluginSettingsSection id={settingsSection.slice("plugin:".length)} />}
		</div>
	);
	return selfScrolling ? page : <Scroller className="flex-1">{page}</Scroller>;
}

/** 插件加的设置分区：页头（标题和 `detail` 那段介绍）由产品画，下面是插件的组件。插件停用、卸下时回到「常规」。 */
function PluginSettingsSection({ id }: { id: string }) {
	const { resolvedLocale } = useI18n();
	usePluginUis();
	const entry = listSettingsSections().find((section) => section.key === id);
	useEffect(() => {
		if (!entry) update({ settingsSection: "general" });
	}, [entry]);
	if (!entry) return null;
	return (
		<>
			<PageHeader title={localized(entry.title, resolvedLocale)} intro={entry.detail === undefined ? undefined : localized(entry.detail, resolvedLocale)} />
			<ErrorBoundary key={entry.key}>
				<entry.component />
			</ErrorBoundary>
		</>
	);
}

/** 「智能体」页里「还没有模型」那一行：去设置 › 模型。 */
function openModelsSection(): void {
	update({ settingsSection: "models" });
}

/** 插件详情里「设置」一节的入口：去设置里那一节。 */
function openSettingsSection(section: SettingsSection): void {
	update({ screen: "settings", settingsSection: section });
}

/** 市场的「新建插件」：开一个新对话，输入框里放好点名写插件技能的 `/plume-plugin `，人接着说想要什么插件。 */
function createPlugin(): void {
	tryPrompt("/plume-plugin ");
}

/** 开一个新对话，输入框里放好这句话，由人来发。 */
function tryPrompt(prompt: string): void {
	openNew();
	setDraft(draftScope(), prompt);
	focusComposer();
}

function ProjectFiles(props: PanelProps) {
	const { projects } = useChrome();
	return <FileBrowser {...props} projects={projects} />;
}

function ProjectFilePanel(props: PanelProps) {
	return <FilePanel {...props} projects={useAppPick((current) => current.projects)} />;
}
