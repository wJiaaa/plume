/**
 * 插件的子会话（侧边聊天、子 Agent）画在面板里的样子：和主列同一套转录，底下可选带附件的输入框。
 * 插件的 `ui.Conversation` 就是它。会话的一轮只有插件能发起，所以没有「继续」，发出去的字交给插件的 `send`。
 * 子会话等人批准的那一次压在主输入框上方（见 `app.tsx` 的 `ChildApprovals`），这里只标「等待确认」；插件的独立会话
 * 不挂在哪个对话下，没有别处可压，审批卡就压在这里的输入框上方，和主列一样。
 */

import type { ApprovalDecision, Message } from "@plume/contract";
import type { ConversationProps } from "@plume/contract/ui";
import { ActionSpinner } from "@plume/ui";
import { Activity, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileScope, touchedPaths } from "../files/scope.ts";
import { Arrival, useArrival } from "../markdown/useSmoothText.ts";
import { useLiveSession } from "../session-live.ts";
import { ApprovalOverlay } from "./ApprovalOverlay.tsx";
import { ChildComposer, type ReadComposerDocument } from "./ChildComposer.tsx";
import type { DraftQuote } from "./quote.ts";
import { seedChildText } from "./child-drafts.ts";
import type { MessageEdits } from "./message-edits.ts";
import { type TaskActions, TaskStrip } from "./TaskStrip.tsx";
import { Transcript } from "./Transcript.tsx";

export function ChildConversation({
	sessionId,
	composer,
	empty,
	renderUserMessage,
	replyText,
	documentText,
	onOpenSettings,
	onQuote,
	edits,
	tasks,
	respond,
}: ConversationProps & {
	/** 回执条（`TaskStrip`）的操作：这个子会话交给父会话的事有了，就画在转录和输入框之间。 */
	tasks: TaskActions;
	/** 子会话只给编辑重问（见 `MessageEdits.aside`），由宿主按插件的 `reask` 拼好。 */
	edits?: MessageEdits;
	documentText: ReadComposerDocument;
	onOpenSettings: () => void;
	onQuote: (quote: DraftQuote) => void;
	/** 人在独立会话的审批卡上做的决定。 */
	respond: (sessionId: string, toolCallId: string, decision: ApprovalDecision) => Promise<void>;
}) {
	const view = useLiveSession(sessionId);
	const arrival = useArrival(sessionId ?? "");
	const files = useMemo(
		() => ({ sessionId: sessionId ?? "", cwd: view?.summary.cwd ?? "", touched: touchedPaths(view?.messages ?? []) }),
		[sessionId, view?.summary.cwd, view?.messages],
	);
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
	// 还没有会话（侧边聊天的第一句还没发）和会话里还没消息一样，画 `empty`。
	const loading = sessionId !== undefined && view === undefined;
	const blank = !loading && (view === undefined || (view.messages.length === 0 && !view.draft));
	const approval = view && !view.summary.parentId ? view.approval : undefined;
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
								{...(composer && !composer.disabled && (!running || composer.mode === "steer") ? { onSend } : {})}
								onOpenSettings={onOpenSettings}
								onQuote={onQuote}
								{...(edits ? { edits } : {})}
								{...(renderUserMessage ? { renderUserMessage } : {})}
								{...(replyText ? { replyText } : {})}
							/>
						</FileScope.Provider>
					</Arrival.Provider>
				)
			)}
			{view?.tasks && view.summary.parentId && (
				<TaskStrip
					tasks={view.tasks}
					sideId={view.summary.id}
					parentId={view.summary.parentId}
					actions={tasks}
					{...(composer?.draftKey ? { onWithdrawn: (text: string) => seedChildText(composer.draftKey!, text) } : {})}
				/>
			)}
			{view && approval && (
				<ApprovalOverlay
					request={approval}
					queued={view.queuedApprovals}
					sessionId={view.summary.id}
					compact={false}
					respond={async (decision) => await respond(view.summary.id, approval.toolCallId, decision)}
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
