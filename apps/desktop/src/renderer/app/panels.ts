import type { PanelProps } from "@plume/contract/ui";
import { translate } from "@plume/ui";
import type { PanelWindowTarget } from "../../shared/panel-window.ts";
import { layoutMode, writePanelPrefs, writePanelTabs, writeSidebarPrefs } from "../layout.ts";
import { notify } from "../toast/index.ts";
import { listPanels, panelEntry } from "../plugins.tsx";
import { dropFile, fileOf, isFolder, type LineRange, openFileIn, shownPath } from "../files/open-file.ts";
import { dropChildDraft, flushChildDrafts } from "../conversation/child-drafts.ts";
import { type Chrome, errorText, type PanelTab, type PanelTabs, panelWindow, sessionWindow, state, update } from "./state.ts";

export function setSidebar(patch: { open?: boolean; width?: number }): void {
	update(
		patch.open === undefined ? { sidebarWidth: patch.width } : { sidebarOpen: patch.open, ...(patch.width === undefined ? {} : { sidebarWidth: patch.width }) },
	);
	writeSidebarPrefs({ open: state.sidebarOpen, width: state.sidebarWidth });
}

/**
 * 会话 `scope` 还没有宽度时，第一次显示就按工作区的四成定下来，之后不再跟着侧栏、窗口变：不然侧栏开合、拖宽时
 * 面板区一路变宽变窄，对话顶行的图标也跟着挪。不碰 `panelMoving`，可能正赶上开合动画。
 */
export function pinPanelWidth(scope: string, width: number): void {
	if (state.panelWidth[scope] !== undefined) return;
	update({ panelWidth: { ...state.panelWidth, [scope]: width } });
	persistPanelPrefs();
}

/** 拖会话 `scope` 的面板区宽度，只改这个会话的。 */
export function setPanelWidth(scope: string, width: number): void {
	// 手动调宽立即接管，不能沿用尚未结束的开合动画。
	update({ panelWidth: { ...state.panelWidth, [scope]: width }, panelMoving: false });
	persistPanelPrefs();
}

/** 会话 `scope` 的面板区开没开（面板窗口里开局就记成开着）。 */
export const panelOpenIn = (current: Chrome, scope = scopeOf(current)): boolean => current.panelOpen[scope] === true;

/** 直接改会话 `scope` 的开合，不带动画；人点的走 `togglePanel`。 */
export function setPanelOpen(scope: string, open: boolean): void {
	if (panelOpenIn(state, scope) === open) return;
	const { [scope]: _, ...rest } = state.panelOpen;
	update({ panelOpen: open ? { ...rest, [scope]: true } : rest });
	persistPanelPrefs();
}

/** 面板窗口里的开合是假的（总开着），会话窗口没有面板区：都不写回去，免得盖掉主窗口记的。 */
function persistPanelPrefs(): void {
	if (panelWindow || sessionWindow) return;
	writePanelPrefs({ open: state.panelOpen, width: state.panelWidth });
}

/** 打开或收起会话 `scope` 的面板区：开关、收起按钮、Esc、点外面都走这里，只有眼前这个会话的这几下带动画。 */
export function togglePanel(open: boolean, scope = scopeOf(state)): void {
	if (open && state.panelLeaving) finishPanelLeave();
	update({ ...(scope === scopeOf(state) ? { panelMoving: true } : {}), ...(!open ? { panelMaximized: { ...state.panelMaximized, [scope]: false } } : {}) });
	setPanelOpen(scope, open);
}

export const scopeOf = (current: Chrome): string => current.currentId ?? "";
export const panelScope = (sessionId: string): string => state.sessions.find((session) => session.id === sessionId)?.parentId ?? sessionId;

/** 某个会话的标签：插件停用了的面板不算；一个都没有时是一个开始页。 */
export function tabsOf(current: Chrome, scope = scopeOf(current), panels = listPanels()): PanelTabs {
	const saved = current.panelTabs[scope];
	const tabs = saved?.tabs.filter((tab) => !tab.panel || panels.some((panel) => panel.key === tab.panel)) ?? [];
	if (!saved || tabs.length === 0) return { tabs: [{ id: `start:${scope}` }], active: `start:${scope}` };
	return { tabs, active: tabs.some((tab) => tab.id === saved.active) ? saved.active : tabs[tabs.length - 1]!.id };
}

export function persistTabs(all: Record<string, PanelTabs>): void {
	if (panelWindow || sessionWindow) return;
	const saved: Record<string, PanelTabs> = {};
	for (const [scope, group] of Object.entries(all)) {
		const tabs = group.tabs.filter((tab) => tab.panel && panelEntry(tab.panel)?.restore);
		if (tabs.length) saved[scope] = { tabs, active: tabs.some((tab) => tab.id === group.active) ? group.active : tabs.at(-1)!.id };
	}
	writePanelTabs(saved);
}

export function setTabs(scope: string, next: PanelTabs | undefined): void {
	const { [scope]: _, ...rest } = state.panelTabs;
	const panelTabs = next ? { ...rest, [scope]: next } : rest;
	update({ panelTabs });
	persistTabs(panelTabs);
}

export function selectTab(id: string, scope: string): void {
	setTabs(scope, { tabs: tabsOf(state, scope).tabs, active: id });
}

/** 成功打开独立窗口才交接，失败时保留原标签及资源。 */
export async function popOutTab(tab: PanelTab, scope: string): Promise<void> {
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
export function launch(tabId: string, key: string, scope = scopeOf(state), sessionId?: string): void {
	const entry = listPanels().find((panel) => panel.key === key);
	if (!entry) return;
	const { tabs } = tabsOf(state, scope);
	const open = entry.multiple ? undefined : tabs.find((tab) => tab.panel === key && tab.sessionId === sessionId);
	if (open) return setTabs(scope, { tabs: tabs.filter((tab) => tab.id !== tabId), active: open.id });
	const id = crypto.randomUUID();
	setTabs(scope, { tabs: tabs.map((tab) => (tab.id === tabId ? { id, panel: key, ...(sessionId ? { sessionId } : {}) } : tab)), active: id });
}

/** 「+」：开一个开始页标签；已经有开始页就切过去，不并排留几个空的。 */
export function openStartTab(scope = scopeOf(state)): void {
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
export function showPanel(key: string, fresh = false, sessionId?: string, options: { tab?: string; background?: boolean } = {}): void {
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
		if (!options.background && !panelOpenIn(state, scope)) togglePanel(true, scope);
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
	if (!panelOpenIn(state, scope)) togglePanel(true, scope);
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
export async function openFileTab(path: string, lines?: LineRange | null, owner?: string): Promise<void> {
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
	if (!panelOpenIn(state, scope)) togglePanel(true, scope);
}

/** 标签 ✕ 前先问的，见 PanelProps.onClose。 */
const closeGuards = new Map<string, () => boolean | Promise<boolean>>();

/** 关一个标签：面板设了 onClose 先问它。一个不剩就收起面板区，下次打开是新的开始页。 */
export async function closeTab(id: string, scope = scopeOf(state)): Promise<void> {
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
		panelOpenIn(state, scope) &&
		!state.panelMaximized[scope] &&
		layoutMode(state.windowWidth) !== "compact" &&
		tabsOf(state).tabs.filter((tab) => !state.panelWindows.some((entry) => entry.tab === tab.id)).length === 1
	) {
		update({ panelLeaving: { id, scope } });
		togglePanel(false);
	} else removeTab(id, scope);
}

export function finishPanelLeave(): void {
	const leaving = state.panelLeaving;
	if (!leaving) return;
	update({ panelLeaving: undefined });
	removeTab(leaving.id, leaving.scope);
}

export function removeTab(id: string, scope: string): void {
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
		if (panelOpenIn(state, scope)) togglePanel(false, scope);
		return;
	}
	setTabs(scope, { tabs: rest, active: active === id ? (rest[index] ?? rest[index - 1])!.id : active });
}

/** 每个标签给面板的 setTitle、onClose，同一个标签一直是同一对函数：面板拿它们进 effect 的依赖也不会反复重跑。 */
const tabHandles = new Map<string, Pick<PanelProps, "setTitle" | "onClose">>();

/** 空白页第一次发出去、成了会话 `id`：空白页上开着的标签交给它。 */
export function handOverBlankTabs(id: string): void {
	// 开合也交过去：空白页上开着（哪怕只有开始页），成了会话也开着；下一个空白页从收着开始。宽度同样交过去。
	if (panelOpenIn(state, "")) {
		setPanelOpen(id, true);
		setPanelOpen("", false);
	}
	const { "": width, ...widths } = state.panelWidth;
	if (width !== undefined) {
		update({ panelWidth: { ...widths, [id]: width } });
		persistPanelPrefs();
	}
	const draftTabs = state.panelTabs[""];
	if (!draftTabs) return;
	for (const tab of draftTabs.tabs) tabHandles.delete(tab.id);
	setTabs("", undefined);
	setTabs(id, draftTabs);
}

/**
 * 会话删掉了（`gone` 认它）：它的标签、开合、全屏，连同标签上挂的关闭确认、文件、侧边聊天的草稿一起清掉；别的会话里
 * 属于它的标签（子会话的辅助面板、看它文件的标签）也关掉，那个会话因此一个标签不剩时收起。会话已经不在了，不问面板的关闭确认。
 * 空白页（`""`）不归任何会话。面板窗口里那个标签没了就关掉这个窗口。
 */
export function forgetPanels(gone: (sessionId: string) => boolean): void {
	const goneId = (id: string | undefined) => id !== undefined && id !== "" && gone(id);
	const dropped: string[] = [];
	const emptied: string[] = [];
	const panelTabs: Record<string, PanelTabs> = {};
	for (const [scope, group] of Object.entries(state.panelTabs)) {
		const tabs = goneId(scope) ? [] : group.tabs.filter((tab) => !goneId(tab.sessionId) && !goneId(tab.file?.sessionId));
		for (const tab of group.tabs) if (!tabs.includes(tab)) dropped.push(tab.id);
		if (tabs.length) panelTabs[scope] = { tabs, active: tabs.some((tab) => tab.id === group.active) ? group.active : tabs.at(-1)!.id };
		else if (!goneId(scope) && group.tabs.length) emptied.push(scope);
	}
	const keep = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([scope]) => !goneId(scope) && !emptied.includes(scope)));
	const panelOpen = keep(state.panelOpen);
	const panelMaximized = keep(state.panelMaximized);
	// 宽度只跟会话走：会话删了才清，标签关光了还留着，下次打开照旧。
	const panelWidth = Object.fromEntries(Object.entries(state.panelWidth).filter(([scope]) => !goneId(scope)));
	if (
		!dropped.length &&
		Object.keys(panelOpen).length === Object.keys(state.panelOpen).length &&
		Object.keys(panelMaximized).length === Object.keys(state.panelMaximized).length &&
		Object.keys(panelWidth).length === Object.keys(state.panelWidth).length
	)
		return;
	for (const id of dropped) {
		closeGuards.delete(id);
		tabHandles.delete(id);
		dropFile(id);
		dropChildDraft(id);
	}
	update({ panelTabs, panelOpen, panelMaximized, panelWidth });
	persistTabs(panelTabs);
	persistPanelPrefs();
	if (panelWindow && dropped.includes(panelWindow.tab)) void window.plume.panelWindows.close();
}

export function handlesOf(id: string): Pick<PanelProps, "setTitle" | "onClose"> {
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
