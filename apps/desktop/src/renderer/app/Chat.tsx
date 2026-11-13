import type { SessionSummary, SessionTarget, SessionView } from "@plume/contract";
import type { ConversationProps, PageProps } from "@plume/contract/ui";
import { ActionSpinner, composingKey, IconButton, Splitter, translate, useI18n, useConfirmer, usePopover } from "@plume/ui";
import { Folder, MoreHorizontal, Plug } from "@plume/ui/icons";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CARD_INSET, TOP_ROW_HEIGHT } from "../../shared/window-chrome.ts";
import { Arrival, useArrival } from "../markdown/useSmoothText.ts";
import { layoutMode, panelWidthFor } from "../layout.ts";
import { ChatBackdrop } from "../chat-backdrop.tsx";
import { notify } from "../toast/index.ts";
import { Transcript } from "../conversation/Transcript.tsx";
import type { MessageEdits } from "../conversation/message-edits.ts";
import type { DraftQuote } from "../conversation/quote.ts";
import { Welcome } from "../composer/Welcome.tsx";
import { ConversationCards, listPanels, SessionToolbar, usePluginUis } from "../plugins.tsx";
import { FileScope, type FileScopeValue, touchedPaths } from "../files/scope.ts";
import { MarketToolbar } from "../market/market.tsx";
import { ChildConversation, type ChildTaskActions } from "../conversation/ChildConversation.tsx";
import { usePluginDisplayName } from "../market/store.ts";
import { ToolbarButton } from "../window-controls.tsx";
import { deleteSessionQuestion } from "../sidebar/delete-session.tsx";
import { SessionMenu } from "../sidebar/SessionMenu.tsx";
import { agent, draftScope, errorText, focusComposer, nextTurnCwd, sessionWindow, setDraft, setQuotes, state, update, useAppPick, useChrome } from "./state.ts";
import { finishPanelLeave, scopeOf, tabsOf, togglePanel } from "./panels.ts";
import { PANEL_MOTION, PanelArea, PanelIcon, PanelLayer, panelLayout, PanelResizer } from "./PanelArea.tsx";
import { CARD_DRAG, HEADER_BAR, NO_DRAG } from "./shell-classes.ts";
import { createPlugin, sidebarActions } from "./actions.ts";
import { Composer } from "./Composer.tsx";
import { attachToComposer, cardActions, carryOn, editMessage, enqueue, forkFrom, retryMessage, revertMessage } from "./message-actions.ts";

/** 对话和面板共用工作区尺寸；常驻标签不随会话切换搬动 DOM。 */
export function ChatScreen({ inset, fatal, share, onShare }: { inset?: number; fatal?: string; share: number; onShare(share: number): void }) {
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
export function ScreenCard({ header, fatal, topInset, children }: { header?: ReactNode; fatal?: string; topInset?: number; children: ReactNode }) {
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
 * 卡片的顶行：会话标题和操作菜单，有插件注册了面板时右端是面板开关，其余界面只是一条可拖动的空行。
 */
export function TitleBar({ inset }: { inset?: number }) {
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
			{session.steward && <StewardMark plugin={session.steward} />}
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

/** 标题旁的「由某插件代管」：人一眼看得出这个会话里会有插件转来的话、插件替人答的卡；收回在会话菜单里。 */
function StewardMark({ plugin }: { plugin: string }) {
	const name = usePluginDisplayName()(plugin) ?? plugin;
	return (
		<span data-plume-steward={plugin} className="flex min-w-0 shrink items-center gap-1 truncate text-caption text-ink-faint select-none">
			<Plug size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
			<span className="truncate">{translate("sessionCard.stewardedBy", { name })}</span>
		</span>
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
export function pageProps(view: SessionView | undefined, target: SessionTarget): PageProps {
	if (view) return { session: view, workspace: { ...(view.summary.project ? { project: view.summary.project } : {}), cwd: view.summary.cwd } };
	return target.project || target.cwd ? { workspace: target } : {};
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
export function CurrentChat() {
	const view = useAppPick((current) => current.view);
	const loading = useAppPick((current) => current.loading);
	if (!view && sessionWindow) return <ChatLoading />;
	return <ChatBody view={view} loading={loading} />;
}

/** 顶行上插件给会话加的按钮：它们拿的是整份视图，跟着视图重画，标题栏的其余部分不用。 */
export function CurrentSessionToolbar() {
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

/** 子会话任务上的操作：「立即执行」「撤回」就是父会话排队条上的「现在就发」和拿掉那一条。 */
const TASK_ACTIONS: ChildTaskActions = {
	runNow: (parentId, taskId) => void agent.sendQueued(parentId, taskId).catch((error: unknown) => notify(errorText(error), "error")),
	withdraw: async (parentId, taskId) => {
		const entry = await agent.removeQueued(parentId, taskId).catch((error: unknown) => {
			notify(errorText(error), "error");
			return undefined;
		});
		return entry && (entry.message.displayText ?? entry.preview);
	},
	retry: (childId, taskId) => void agent.retryTask(childId, taskId).catch((error: unknown) => notify(errorText(error), "error")),
	dismiss: (childId, taskId) => void agent.dismissTask(childId, taskId).catch((error: unknown) => notify(errorText(error), "error")),
};

/** 插件的 `ui.Conversation`：引用到的是当前对话的输入框，「去设置」去模型设置。 */
export function PluginConversation(props: ConversationProps) {
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
			taskActions={TASK_ACTIONS}
			documentText={async (name, data) => await agent.documentText(name, data)}
			onOpenSettings={onOpenSettings}
			onQuote={onQuote}
			respond={async (id, toolCallId, decision) => await agent.respond(id, toolCallId, decision)}
			answer={async (id, toolCallId, value) => await agent.answer(id, toolCallId, value)}
		/>
	);
}
