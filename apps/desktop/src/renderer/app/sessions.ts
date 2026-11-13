import type { AgentEvent, SessionSummary, SessionTarget, SessionView } from "@plume/contract";
import { translate } from "@plume/ui";
import { notify } from "../toast/index.ts";
import { noteSessionDoing } from "../conversation/handed-off.ts";
import { refreshModels } from "../models/store.ts";
import { listPages, toolTableChanged } from "../plugins.tsx";
import { removeFiles, moveFiles } from "../files/open-file.ts";
import { applyLive, peekLiveSession, readSessionView, reloadLive, viewChange } from "../session-live.ts";
import { publishSessionChanges } from "../plugin-session-changes.ts";
import { record, sameEntry, step } from "../nav-history.ts";
import { pluginsChanged } from "../market/store.ts";
import { approvalChanged, outcome, sessionRead, sessionsChanged } from "../sidebar/activity.ts";
import {
	agent,
	type AppState,
	errorText,
	focusComposer,
	here,
	panelWindow,
	queuedDrafts,
	sessionWindow,
	setArriving,
	setComposerArrival,
	state,
	update,
} from "./state.ts";

/** 改一个会话的视图：屏上那个，或停在缓存里的那个——停着的也照样跟着事件走，切回来才是新的。 */
export function updateView(sessionId: string, change: (view: SessionView) => Partial<SessionView>): void {
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
			return;
		case "tools":
			toolTableChanged(event.tools);
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
		// 工具表也重拿一份：断流期间的 `tools` 事件丢了，转录会按旧的种类分组。
		const [sessions, projects, tools] = await Promise.all([agent.listSessions(), agent.listProjects(), agent.listTools(), refreshModels()]);
		toolTableChanged(tools);
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
export async function follow(): Promise<void> {
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
export const parked = new Map<string, SessionView>();
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
export function heldView(sessionId: string): SessionView | Promise<SessionView> | undefined {
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
export async function openNoticeSession(sessionId: string): Promise<boolean> {
	if (!state.sessions.some((session) => session.id === sessionId)) return false;
	await select(sessionId);
	return state.currentId === sessionId;
}

/** 打开一个会话。`again`：屏上就是它也重读一遍（事件流断过，见 `refresh`）。 */
export async function select(sessionId: string, again = false): Promise<void> {
	sessionRead(sessionId);
	// 只在人选中时清手动未读，缓存命中也一样；后台刷新和标记当前会话都不替人读掉。
	if (!again && state.sessions.some((session) => session.id === sessionId && session.unread)) {
		void agent.setSessionUnread(sessionId, false).catch((error: unknown) => notify(errorText(error), "error"));
	}
	const epoch = ++selection;
	setComposerArrival(undefined);
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
export function openNew(target: SessionTarget = state.target): void {
	selection++;
	setComposerArrival(undefined);
	park();
	update({ target: { ...target }, currentId: undefined, view: undefined, loading: false, pendingId: undefined, screen: "chat", drawerOpen: false });
	focusComposer();
}

export function canStep(current: AppState, direction: -1 | 1): boolean {
	return (
		step(current.nav, direction, { currentId: current.currentId ?? null, exists: (id) => current.sessions.some((session) => session.id === id), hasPage }) !==
		null
	);
}

function hasPage(screen: `page:${string}`): boolean {
	return listPages().some((page) => `page:${page.key}` === screen);
}

export async function go(direction: -1 | 1): Promise<void> {
	const next = step(state.nav, direction, { currentId: state.currentId ?? null, exists: (id) => state.sessions.some((session) => session.id === id), hasPage });
	if (!next) return;
	setArriving(true);
	try {
		update({ nav: next.history });
		if (next.entry.screen === "chat" && next.entry.sessionId && next.entry.sessionId !== state.currentId) await select(next.entry.sessionId);
		update({ screen: next.entry.screen });
	} finally {
		setArriving(false);
		// 最后停在哪里，记录就站在哪里，打开失败也一样。
		update((current) => {
			const at = current.nav.entries[current.nav.index];
			const landed = here(current);
			return at && sameEntry(at, landed) ? {} : { nav: record(current.nav, landed) };
		});
	}
}

/** 开始重问这个会话（编辑重发、重试），见 `reasking`。 */
export function beginReask(sessionId: string): void {
	reasking = { sessionId };
}

/** 重问收了场、那句没落进会话：补上压着的那一刀。 */
export function settleReask(sessionId: string): void {
	if (reasking?.sessionId !== sessionId) return;
	const { keep } = reasking;
	reasking = undefined;
	if (keep !== undefined) updateView(sessionId, (view) => ({ messages: view.messages.slice(0, keep) }));
}
