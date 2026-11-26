/**
 * 插件的子会话（侧边聊天、子 Agent）画在面板里的样子：和主列同一套转录，底下可选带附件的输入框。
 * 插件的 `ui.Conversation` 就是它。会话的一轮只有插件能发起，所以没有「继续」，发出去的字交给插件的 `send`。
 * 子会话等人批准的那一次压在主输入框上方（见 `app/Composer.tsx` 的 `ChildApprovals`），这里只标「等待确认」；插件给了
 * `approvals: "here"` 的，在屏上时卡压在这里的输入框上方，并认领下来、主输入框上方不再压一张。插件的独立会话
 * 不挂在哪个对话下，没有别处可压，审批卡就压在这里的输入框上方，和主列一样。
 */

import type { ApprovalDecision, Message } from "@plume/contract";
import type { ConversationProps } from "@plume/contract/ui";
import { ActionSpinner } from "@plume/ui";
import { Activity, useCallback, useContext, useEffect, useRef, useState } from "react";
import { FileScope, useFileScopeValue } from "../files/scope.ts";
import { Arrival, useArrival } from "../markdown/useSmoothText.ts";
import { useLiveSession } from "../session-live.ts";
import { useAppearance } from "../appearance-settings.ts";
import { GrainLayer } from "../chat-backdrop.tsx";
import { ApprovalOverlay } from "./ApprovalOverlay.tsx";
import { useApprovalClaim, ViewShown } from "./approval-claims.ts";
import { ChildComposer, type ReadComposerDocument } from "./ChildComposer.tsx";
import type { DraftQuote } from "./quote.ts";
import { seedChildText } from "./child-drafts.ts";
import type { MessageEdits } from "./message-edits.ts";
import { PluginPart } from "../plugins.tsx";
import { Transcript } from "./Transcript.tsx";

/** 子会话任务上那几样操作。`withdraw` 交回收回的那句话，已经发出去了就是 undefined。 */
export interface ChildTaskActions {
	runNow(parentId: string, taskId: string): void;
	withdraw(parentId: string, taskId: string): Promise<string | undefined>;
	retry(childId: string, taskId: string): void;
	dismiss(childId: string, taskId: string): void;
}

function parentIdOf(view: { summary: { parentId?: string } }): string {
	return view.summary.parentId ?? "";
}

export function ChildConversation({
	sessionId,
	composer,
	empty,
	tasks: Tasks,
	approvals,
	renderUserMessage,
	replyText,
	documentText,
	onOpenSettings,
	onQuote,
	edits,
	taskActions,
	respond,
	answer,
}: ConversationProps & {
	/** 插件画的子会话任务（`ConversationProps.tasks`）上那几样操作，由宿主接到 agent 上。 */
	taskActions: ChildTaskActions;
	/** 子会话只给编辑重问和撤回（见 `MessageEdits.aside`），由宿主按插件的 `reask` 拼好。 */
	edits?: MessageEdits;
	documentText: ReadComposerDocument;
	onOpenSettings: () => void;
	onQuote: (quote: DraftQuote) => void;
	/** 人在独立会话的审批卡上做的决定。 */
	respond: (sessionId: string, toolCallId: string, decision: ApprovalDecision) => Promise<void>;
	/** 人在独立会话里等人给数据的卡（`run.request`）上交回的数据。 */
	answer: (sessionId: string, toolCallId: string, value: unknown) => Promise<void>;
}) {
	const view = useLiveSession(sessionId);
	const grain = useAppearance().grain === true;
	const arrival = useArrival(sessionId ?? "");
	const files = useFileScopeValue(sessionId ?? "", view?.summary.cwd ?? "", view?.messages ?? NO_MESSAGES);
	const running = view?.summary.running ?? false;
	// 每份会话独占附件 hook 和草稿。隐藏时停止编辑器、拖放监听等副作用，状态仍在。
	// scope 只用来分草稿：侧边聊天的 `draftKey` 是面板标签的 id，不是会话 id；@ 提及、命令、历史要的会话、目录和项目只给露着的那一份，用真的。
	const currentScope = composer?.draftKey ?? sessionId;
	const [scopes, setScopes] = useState<(string | undefined)[]>([currentScope]);
	if (!scopes.includes(currentScope)) setScopes([...scopes, currentScope]);
	const section = useRef<HTMLElement>(null);
	useEffect(() => {
		const element = section.current;
		// 文件只落在这一列；不再冒到主列的附件监听器，导致两边各添一份。
		const contain = (event: DragEvent) => {
			if (event.dataTransfer?.types.includes("Files")) event.stopPropagation();
		};
		for (const name of ["dragenter", "dragover", "dragleave", "drop"] as const) element?.addEventListener(name, contain);
		return () => {
			for (const name of ["dragenter", "dragover", "dragleave", "drop"] as const) element?.removeEventListener(name, contain);
		};
	}, []);
	/*
	 * 输入框发第一句时会话才建：同一份输入框正发着第一句、会话从没有变成有，这段会话本来就是空的，视图读回来之前不算加载，
	 * 接着画 `empty`、输入框照常可用；当加载的话这一下输入框整块压淡、只读，转录换成转圈，发第一句时闪一下。
	 * 只认正在发第一句的：插件打开已有的会话时也是从没有变成有（侧边聊天挂上时先查这个标签接的哪段），那要照常显示加载。
	 */
	const [opening, setOpening] = useState<string | undefined>();
	const [opened, setOpened] = useState({ scope: currentScope, sessionId, fresh: false });
	if (opened.scope !== currentScope || opened.sessionId !== sessionId) {
		setOpened({ scope: currentScope, sessionId, fresh: opened.scope === currentScope && opened.sessionId === undefined && opening === currentScope });
	}
	// 还没有会话（侧边聊天的第一句还没发）和会话里还没消息一样，画 `empty`。
	const loading = sessionId !== undefined && view === undefined && !(opened.fresh && opened.sessionId === sessionId);
	const blank = !loading && (view === undefined || (view.messages.length === 0 && !view.draft));
	// 子会话的卡默认压在主输入框上方；插件说了画在这里的，在屏上时认领下来，主输入框上方就不再压一张。
	const shown = useContext(ViewShown);
	const child = Boolean(view?.summary.parentId);
	useApprovalClaim(child && approvals === "here" && shown ? sessionId : undefined);
	const approval = view && (!child || approvals === "here") ? view.approval : undefined;
	// 插件每次渲染都给一份新的 `composer`；转录的 state 依赖 onSend，函数一变所有 `useTranscript()` 都跟着重画，所以经 ref 读最新的、函数本身不变。
	const latestComposer = useRef(composer);
	latestComposer.current = composer;
	const onSend = useCallback(async (text: string, displayText?: string) => {
		const current = latestComposer.current;
		if (!current) return;
		if (displayText !== undefined && current.sendMessage) await current.sendMessage({ content: [{ type: "text", text }], displayText });
		else await current.send(text);
	}, []);
	return (
		<section ref={section} data-screen="" data-child-conversation={sessionId ?? ""} className="relative isolate flex h-full min-h-0 flex-col">
			{grain && <GrainLayer />}
			{loading ? (
				<div role="status" aria-busy="true" className="plume-defer-in flex flex-1 items-center justify-center">
					<ActionSpinner size={20} className="text-ink-faint" />
				</div>
			) : blank ? (
				<div className="flex min-h-0 flex-1 flex-col">{empty}</div>
			) : (
				view && (
					<Arrival.Provider value={arrival}>
						<FileScope.Provider value={files}>
							<Transcript
								view={view}
								fadeSurface={grain ? undefined : "shell"}
								{...(composer && !composer.disabled && (!running || composer.mode === "steer") ? { onSend } : {})}
								onOpenSettings={onOpenSettings}
								onQuote={onQuote}
								{...(edits ? { edits } : {})}
								{...(renderUserMessage ? { renderUserMessage } : {})}
								{...(replyText ? { replyText } : {})}
								{...(approval
									? {
											request: (
												<ApprovalOverlay
													request={approval}
													queued={view.queuedApprovals}
													sessionId={view.summary.id}
													compact={false}
													place="transcript"
													respond={async (decision) => await respond(view.summary.id, approval.toolCallId, decision)}
													answer={async (value) => await answer(view.summary.id, approval.toolCallId, value)}
												/>
											),
										}
									: {})}
							/>
						</FileScope.Provider>
					</Arrival.Provider>
				)
			)}
			{Tasks && view?.tasks && view.summary.parentId && (
				<PluginPart plugin={view.summary.owner ?? ""}>
					<Tasks
						sessionId={view.summary.id}
						parentId={view.summary.parentId}
						tasks={view.tasks}
						runNow={(taskId) => taskActions.runNow(parentIdOf(view), taskId)}
						retry={(taskId) => taskActions.retry(view.summary.id, taskId)}
						dismiss={(taskId) => taskActions.dismiss(view.summary.id, taskId)}
						{...(composer?.draftKey
							? {
									withdraw: (taskId: string) =>
										void taskActions.withdraw(parentIdOf(view), taskId).then((text) => {
											if (text !== undefined) seedChildText(composer.draftKey!, text);
										}),
									putBack: (text: string) => seedChildText(composer.draftKey!, text),
								}
							: {})}
					/>
				</PluginPart>
			)}
			{view && approval && (
				<ApprovalOverlay
					request={approval}
					queued={view.queuedApprovals}
					sessionId={view.summary.id}
					compact={false}
					place="composer"
					respond={async (decision) => await respond(view.summary.id, approval.toolCallId, decision)}
					answer={async (value) => await answer(view.summary.id, approval.toolCallId, value)}
				/>
			)}
			{composer &&
				scopes.map((scope) => (
					<Activity key={scope ?? ""} mode={scope === currentScope ? "visible" : "hidden"}>
						<ChildComposer
							composer={composer}
							sessionId={scope === currentScope ? sessionId : undefined}
							cwd={scope === currentScope ? view?.summary.cwd : undefined}
							project={scope === currentScope ? view?.summary.project : undefined}
							active={scope === currentScope}
							onOpening={(on) => setOpening(on ? scope : undefined)}
							running={running}
							loading={loading}
							documentText={documentText}
							messages={(scope === currentScope ? view?.messages : undefined) ?? NO_MESSAGES}
							{...(scope === currentScope && view ? { view } : {})}
							onOpenSettings={onOpenSettings}
						/>
					</Activity>
				))}
		</section>
	);
}

/** 藏起来的那几份输入框不翻历史：同一个空数组，免得每次渲染重算。 */
const NO_MESSAGES: Message[] = [];
