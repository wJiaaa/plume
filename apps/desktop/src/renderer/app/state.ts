/**
 * 应用状态（`AppState`）和改它的入口 `update`。读写它的代码都放在 `app/` 和 `app.tsx` 里，分三层、只往下引用：
 * 这里和 `shell-classes.ts` 在最下面；`sessions.ts`（事件流、换会话）、`panels.ts`（侧栏和面板区的标签）在它上面，
 * `message-actions.ts`、`actions.ts` 再上一层；组件在最上面。`composer/`、`conversation/`、`sidebar/` 这些目录不碰这份状态，
 * 要用就由这里的组件经参数交进去。
 */

import type { AgentService, ProjectEntry, SessionSummary, SessionTarget, SessionView, SettingsView } from "@plume/contract";
import type { Remote } from "@plume/rpc";
import { useSyncExternalStore } from "react";
import type { PanelWindowTarget } from "../../shared/panel-window.ts";
import { readPanelPrefs, readPanelTabs, readSidebarPrefs } from "../layout.ts";
import type { SessionReference } from "../composer/session-references.ts";
import type { DraftAttachment } from "../composer/attachments/read.ts";
import type { DraftQuote } from "../conversation/quote.ts";
import { EMPTY_HISTORY, type NavEntry, type NavHistory, record, type Screen } from "../nav-history.ts";
import type { SettingsSection } from "../settings/pages.tsx";

export interface AppState {
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
export const queuedDrafts = new Map<string, { sessionId: string; draft: QueuedDraft }>();

export interface QueuedDraft {
	sessionRefs?: SessionReference[];
	text: string;
	attachments: DraftAttachment[];
	quotes: DraftQuote[];
}

/** 面板区的一个标签：panel 是 `插件名/id`，没有就是开始页；title 是面板自己设的字。 */
export interface PanelTab {
	id: string;
	panel?: string;
	title?: string;
	/** 子会话打开的辅助面板仍放在父会话旁边，但读取子会话自己的数据。 */
	sessionId?: string;
	file?: { path: string; sessionId: string };
}

export interface PanelTabs {
	tabs: PanelTab[];
	active: string;
}

// ── 状态 ────────────────────────────────────────────────────────────

const sidebarPrefs = readSidebarPrefs();
const panelPrefs = readPanelPrefs();
export const panelWindow = window.plume.panelWindows.boot;
/** 会话菜单「新窗口」开出来的窗口：只有这一段对话，没有侧栏和面板区。 */
export const sessionWindow = window.plume.sessionWindows.boot;
export let state: AppState = {
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
export let agent: Remote<AgentService>;

export function connectAgent(service: Remote<AgentService>): void {
	agent = service;
}

/**
 * 除了屏上那个会话的视图以外的状态。流式输出时草稿每 50ms、命令输出每 100ms 换一次 `view`，别的都没变；侧栏、标题栏、面板区这些
 * 不读视图的地方订阅它，就不跟着每一拍重画。就是 `state` 本身，只在 `view` 以外有字段变了时才换成新的那份；类型上拿掉 `view`，
 * 读不到可能过时的那份视图。
 */
export type Chrome = Omit<AppState, "view">;
let chrome: Chrome = state;

function sameChrome(before: AppState, after: AppState): boolean {
	for (const key of Object.keys(after) as (keyof AppState)[]) if (key !== "view" && !Object.is(before[key], after[key])) return false;
	return true;
}

export function update(patch: Partial<AppState> | ((current: AppState) => Partial<AppState>)): void {
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
export function useChrome(): Chrome {
	return useSyncExternalStore(subscribeApp, () => chrome);
}

/** 状态里的一样东西，它变了才重画。`pick` 只能交回状态里原有的引用或原始值，不能每次新造一个对象。 */
export function useAppPick<T>(pick: (current: AppState) => T): T {
	return useSyncExternalStore(subscribeApp, () => pick(state));
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── 后退、前进 ──────────────────────────────────────────────────────

export function here(current: AppState): NavEntry {
	return { screen: current.screen, sessionId: current.currentId ?? null };
}

/** 后退、前进正在落地：这期间的状态变化是这一步本身，不是新去了一个地方，记下来会把前面的都截掉。 */
let arriving = false;

export function setArriving(value: boolean): void {
	arriving = value;
}

/** 下一轮在哪个目录跑：会话保留自己的工作目录，新对话取选中项目的目录。插件的格子、面板都按它画。 */
export function nextTurnCwd(current: Chrome, session: SessionSummary | undefined): string | undefined {
	if (session) return session.cwd ?? current.projects.find((entry) => entry.id === session.project)?.path;
	const target = current.target;
	return current.projects.find((entry) => entry.id === target.project)?.path ?? target.cwd;
}

export function draftScope(view?: SessionView): string {
	const target = state.target;
	return view?.summary.id ?? `blank:${target.project ?? target.cwd ?? ""}`;
}

export function setDraft(scope: string, value: string): void {
	update((current) => ({ drafts: { ...current.drafts, [scope]: value } }));
}

/** 没挂附件时的同一个空数组：附件清单按引用比较，每次新建一个就每次都「变了」。 */
export const NO_FILES: DraftAttachment[] = [];

/** 没有引文时的同一个空数组：发送完拿它比引文变没变，每次新建一个就永远「变了」。 */
export const NO_QUOTES: DraftQuote[] = [];

export function setQuotes(scope: string, change: (quotes: DraftQuote[]) => DraftQuote[]): void {
	update((current) => ({ quotes: { ...current.quotes, [scope]: change(current.quotes[scope] ?? []) } }));
}

export function focusComposer(): void {
	requestAnimationFrame(() => document.querySelector<HTMLElement>("main .cm-content")?.focus());
}

/** 只给刚从欢迎页发出消息的那个会话播放入场，切换会话不能借用这个标记。 */
export let composerArrival: { sessionId: string; at: number } | undefined;

export function setComposerArrival(value: typeof composerArrival): void {
	composerArrival = value;
}
