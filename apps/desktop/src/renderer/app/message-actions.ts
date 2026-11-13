import type { AssistantMessage, OutgoingMessage, QueuedMessage, SessionSummary, UserMessage } from "@plume/contract";
import { touchWorkingTree, translate } from "@plume/ui";
import { notify } from "../toast/index.ts";
import { withSessionReferences } from "../composer/session-references.ts";
import { sessionReferences, setSessionReferences } from "../composer/SessionReferences.tsx";
import { draftFromMessage, editedContent } from "../conversation/revert-draft.ts";
import type { DraftAttachment } from "../composer/attachments/read.ts";
import { agent, errorText, focusComposer, type QueuedDraft, queuedDrafts, state, update } from "./state.ts";
import { beginReask, select, settleReask, updateView } from "./sessions.ts";

/** 卡片上的按钮（暂停、继续）做的事，和输入框的停止按钮、转录底下的「继续」是同一件。 */
export function cardActions(sessionId: string): { stop(): void; carryOn(text: string): void } {
	return {
		stop: () => void agent.stop(sessionId),
		carryOn: (text) => carryOn(sessionId, String(text)),
	};
}

/** 从队里拿走一条（删除、编辑、交给插件），连同排进来时记下的草稿。已经发出去了就什么都拿不到。 */
export async function takeQueued(sessionId: string, id: string): Promise<{ entry: QueuedMessage; draft?: QueuedDraft } | undefined> {
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
export function moveQueued(sessionId: string, id: string, targetId: string, placement: "before" | "after"): void {
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
export async function enqueue(sessionId: string, outgoing: OutgoingMessage, preview: string, draft?: QueuedDraft): Promise<boolean> {
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
export function restoreUnqueued(scope: string, draft: QueuedDraft): void {
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
export function carryOn(sessionId: string, prompt: string): void {
	void agent.send(sessionId, { content: [{ type: "text", text: prompt }], synthetic: true }).catch((error: unknown) => notify(errorText(error), "error"));
}

/**
 * 编辑重发：附件原样带上，换的只是人打的那句。截完就回来，新的一轮经事件流到。`files` 为真时先把截掉的那几轮改过的文件退回去，
 * 退回的文件不是一轮写的，改动统计和 Git 面板闲着时不轮询，得叫它们重读。
 */
export async function editMessage(sessionId: string, index: number, message: UserMessage, text: string, files = false): Promise<void> {
	beginReask(sessionId);
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
export async function retryMessage(sessionId: string, index: number, message: UserMessage): Promise<void> {
	beginReask(sessionId);
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

/** 撤回：截掉这条和之后的，这条连同附件放回输入框。`files` 同编辑重发。 */
export async function revertMessage(sessionId: string, index: number, message: UserMessage, files = false): Promise<void> {
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
export async function forkFrom(sessionId: string, index: number, message: UserMessage | AssistantMessage): Promise<void> {
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

/** 光标放回当前对话的输入框。 */
/** 看图器里标注完的图（`data:` URL）挂到这个会话的输入框上，光标回到框里。 */
export function attachToComposer(sessionId: string, dataUrl: string): void {
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
