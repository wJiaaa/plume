import type { CommandExpansion, Message, OutgoingMessage, QueuedMessage, SessionSummary, SessionView, UserMessage } from "@plume/contract";
import { type EditorView, keymap } from "@codemirror/view";
import { Button, formatList, useI18n } from "@plume/ui";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { layoutMode } from "../layout.ts";
import { notify } from "../toast/index.ts";
import { ComposerSend, ComposerShell } from "../composer/index.ts";
import { ContextMeter } from "../composer/ContextMeter.tsx";
import { useComposerAttachments } from "../composer/useComposerAttachments.tsx";
import { parseInvocation, resolveCommand } from "../composer/commands.ts";
import { useMentions } from "../composer/useMentions.tsx";
import { withSessionReferences } from "../composer/session-references.ts";
import { SessionReferences, sessionReferences, setSessionReferences, useSessionReferences } from "../composer/SessionReferences.tsx";
import { useCommands } from "../composer/useCommands.tsx";
import { useInputHistory } from "../composer/useInputHistory.ts";
import { QueuedMessages } from "../composer/QueuedMessages.tsx";
import { draftFromMessage } from "../conversation/revert-draft.ts";
import { withQuotes } from "../conversation/quote.ts";
import { QuoteChip } from "../composer/QuoteChip.tsx";
import { PermissionChip } from "../composer/PermissionPicker.tsx";
import { ProjectPicker } from "../composer/ProjectPicker.tsx";
import { conversationDescendants } from "../conversation/descendants.ts";
import { ApprovalOverlay } from "../conversation/ApprovalOverlay.tsx";
import { HandedOffStrip } from "../conversation/HandedOffStrip.tsx";
import { type ComposerSession, EffortTrigger, ModelTrigger } from "../models/index.ts";
import { effectiveModel } from "../models/session.ts";
import { useModels } from "../models/store.ts";
import {
	ComposerAbove,
	ComposerChips,
	composerHint,
	ComposerItems,
	ConversationCards,
	listSettingsSections,
	usePluginUis,
	useQueueActions,
} from "../plugins.tsx";
import { useLiveSession } from "../session-live.ts";
import {
	agent,
	composerArrival,
	draftScope,
	errorText,
	focusComposer,
	nextTurnCwd,
	NO_FILES,
	NO_QUOTES,
	type QueuedDraft,
	setComposerArrival,
	setDraft,
	setQuotes,
	state,
	update,
	useChrome,
} from "./state.ts";
import { cardActions, enqueue, moveQueued, restoreUnqueued, takeQueued } from "./message-actions.ts";
import { openNew } from "./sessions.ts";
import { handOverBlankTabs, showPanel } from "./panels.ts";
import { sidebarActions } from "./actions.ts";

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
const COMPOSER_ARRIVAL_WINDOW = 1000;

/** `cards`：跟着会话的卡片放不下浮在转录上，画在输入框正上方。 */
export function Composer({ view, centered = false, cards = false }: { view?: SessionView; centered?: boolean; cards?: boolean }) {
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
		setComposerArrival(undefined);
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
					handOverBlankTabs(id);
					update({
						currentId: id,
						view: { summary, messages: [], progress: {}, startedAt: {}, hiccups: [], compactions: [], compactionRuns: [], compacting: false, queue: [] },
					});
				}
				if (blankModel) await agent.setSessionModel(id, blankModel);
				if (blankThinking) await agent.setSessionThinking(id, blankThinking);
			}
			if (centered && state.currentId === id && state.screen === "chat") setComposerArrival({ sessionId: id, at: performance.now() });
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
			if (composerArrival?.sessionId === id) setComposerArrival(undefined);
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
								<PermissionChip
									required={view?.summary.projectPermission}
									{...(view ? { cwd: view.summary.cwd } : {})}
									onError={(message) => notify(message, "error")}
								/>
								<ComposerItems side="start" {...item} />
							</>
						}
						right={
							<>
								<ComposerItems side="end" {...item} />
								<ContextMeter view={view} contextWindow={model?.contextWindow} />
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
