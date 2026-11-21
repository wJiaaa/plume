import type { AgentEvent, AssistantMessage, Message, RevertPlan, SessionSummary, UserMessage } from "@plume/contract";
import { keptRecord, marks, runsOf, type ContextRecord } from "@plume/loop";
import type { BackgroundRuns } from "../background.ts";
import type { PluginHost } from "../host.ts";
import { text } from "../i18n.ts";
import { parkImages } from "../media.ts";
import type { SessionDb } from "../session-db.ts";
import type { SessionWakeups } from "../wakeups.ts";
import { type InputParts, tailActivity } from "../usage-record.ts";
import type { Session } from "./session.ts";

export interface MessagesDeps {
	mediaDir: string;
	messagesOf(session: Session): Promise<Message[]>;
	/** 回边：模型请求模块后建，在 `createAgent` 里接上。 */
	partsOf(message: AssistantMessage): InputParts | undefined;
	store: Pick<SessionDb, "append" | "truncate">;
	emit(event: AgentEvent): void;
	summaries(): SessionSummary[];
	recordOf(session: Session): Promise<ContextRecord>;
	background: Pick<BackgroundRuns, "cancelCalls" | "cancelRuns">;
	wakeups: Pick<SessionWakeups, "cancelCalls">;
	host: {
		workspace: Pick<PluginHost["workspace"], "revert">;
		sessionContextReset(sessionId: string): void;
	};
	/** 回边：占用模块后建，在 `createAgent` 里接上。 */
	held(session: Session): boolean;
}

export interface Messages {
	commit(session: Session, message: Message, allowed?: () => boolean): Promise<boolean>;
	rewind(session: Session, keep: number): Promise<void>;
	sentAt(session: Session, index: number, options?: { reask?: boolean; timestamp?: unknown }): Promise<number>;
	rewindFiles(session: Session, index: number, restore: boolean): Promise<RevertPlan>;
	commitPrompt(session: Session, prompt: UserMessage, context: string | undefined, allowed: () => boolean): Promise<boolean>;
}

export function createMessages(deps: MessagesDeps): Messages {
	const { mediaDir, messagesOf, partsOf, store, emit, summaries, recordOf, background, wakeups, host, held } = deps;

	async function commit(session: Session, message: Message, allowed?: () => boolean): Promise<boolean> {
		const messages = await messagesOf(session);
		await parkImages(mediaDir, message);
		// 图片落盘也会等待：停止或卸载期间，尚未写进历史的插话和送达仍可撤回。
		if (allowed && !allowed()) return false;
		const parts = message.role === "assistant" ? partsOf(message) : undefined;
		const note = parts && {
			parts,
			...tailActivity(messages),
			// 轮次只数顶层会话的：子会话里「人说的话」是派它的那一方写的任务。
			...(session.summary.parentId ? { turns: 0 } : {}),
			...(session.cacheBoundary ? { boundary: session.cacheBoundary } : {}),
		};
		const changes: Partial<SessionSummary> = { updatedAt: Date.now(), messageCount: messages.length + 1 };
		if (message.role === "user" && !message.synthetic && session.summary.title === "") {
			// 带附件时第一块字是给模型的附件说明，标题取人打的那句。
			const first = message.displayText ?? message.content.find((block) => block.type === "text")?.text ?? "";
			changes.title = first.trim().slice(0, 40);
		}
		// 先落盘再进内存：写不进去（磁盘出错、存不成 JSON）时内存、界面和会话库都还是原样，撤回、编辑重发按条数截断才对得上。
		store.append({ ...session.summary, ...changes }, message, note);
		Object.assign(session.summary, changes);
		if (note) session.cacheBoundary = undefined;
		messages.push(message);
		// 回复落进会话就顶替了它的草稿：界面收到这条 message 时一并换下草稿，不另发一次清空，见 `StreamTurn.draft`。
		if (message.role === "assistant") {
			session.draft = undefined;
			// 观察者那边这条回复已经以 response 给全了，落进会话就不再作废。
			session.observedDraft = undefined;
		}
		emit({ type: "message", sessionId: session.summary.id, message, count: messages.length });
		emit({ type: "sessions", sessions: summaries() });
		return true;
	}

	/**
	 * 只留前 `keep` 条消息（撤回、编辑重发），只在没跑的时候做。压缩记录跟着留下那截（`keptRecord`）；上一轮怎么结束的不再说得清，
	 * 清掉，界面不再挂着「已暂停 · 继续」。截掉那段里的调用起的后台命令、监视、唤醒不再送达（它们的渠道作废），留下那段起的照常；
	 * 后台还在跑的派发全部停掉：派发不记是哪一条派出去的，留着的话，截掉那段派出的结果回来会接在一段不再有它的对话后面。
	 */
	async function rewind(session: Session, keep: number): Promise<void> {
		const sessionId = session.summary.id;
		const messages = await messagesOf(session);
		const kept = messages.slice(0, keep);
		const record = keptRecord(await recordOf(session), kept);
		const cutCalls = messages
			.slice(keep)
			.flatMap((message) => (message.role === "assistant" ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) : []));
		background.cancelCalls(sessionId, cutCalls);
		wakeups.cancelCalls(sessionId, cutCalls);
		background.cancelRuns(sessionId);
		session.messages = kept;
		session.record = record;
		session.hiccups = [];
		session.repetition.reset();
		if (session.cacheBoundary !== "compaction") session.cacheBoundary = "rewind";
		delete session.summary.stop;
		session.summary.messageCount = kept.length;
		store.truncate(session.summary, keep, record);
		host.sessionContextReset(sessionId);
		emit({ type: "rewound", sessionId, count: keep, compactions: marks(record), runs: runsOf(record) });
		emit({ type: "hiccups", sessionId, hiccups: [] });
		emit({ type: "sessions", sessions: summaries() });
	}

	/**
	 * 编辑、撤回的对象：人发的第 `index` 条（不能是界面替人说的那句）在会话里实际是第几条。
	 *
	 * 先做截断前的检查。插件的子会话默认不让人截：那里的一轮只有插件能发起。`reask` 为真（编辑重发）时放行，
	 * 插件在界面上开了 `ConversationProps.reask`（侧边聊天）就是同意宿主替它重跑这一问；撤回、退文件仍然不行。
	 *
	 * 再认位置。给了 `timestamp`（界面上那一条的）就拿它核对：界面的序号可能和会话差几条，
	 * 按时间戳认回那一条，同 `forkSession`；认不出就报错，不截错地方。
	 */
	async function sentAt(session: Session, index: number, options: { reask?: boolean; timestamp?: unknown } = {}): Promise<number> {
		if (session.summary.owner && !options.reask) throw new Error(text("session.pluginOwned", { plugin: session.summary.owner }));
		if (held(session)) throw new Error(text("session.running"));
		const messages = await messagesOf(session);
		const { timestamp } = options;
		const at =
			typeof timestamp !== "number" || messages[index]?.timestamp === timestamp ? index : messages.findIndex((message) => message.timestamp === timestamp);
		const message = Number.isInteger(at) ? messages[at] : undefined;
		if (message?.role !== "user" || message.synthetic) throw new Error(text("session.badMessage"));
		return at;
	}

	/**
	 * 截掉第 `index` 条起的那段改过的文件（按结果上本体记下的 `ToolResultMessage.changes`，见 `run-files.ts` 的 `revert`）。
	 * `restore` 为真时真的退回去，退不回去就抛错，message 给人看。
	 */
	async function rewindFiles(session: Session, index: number, restore: boolean): Promise<RevertPlan> {
		return host.workspace.revert(session.summary.id, session.summary.cwd, (await messagesOf(session)).slice(index), restore);
	}

	/** 写进人的这条；插件放行时带了话，紧跟着以用户身份（synthetic）写进去，模型读得到，界面不画成人的消息。 */
	async function commitPrompt(session: Session, prompt: UserMessage, context: string | undefined, allowed: () => boolean): Promise<boolean> {
		if (!(await commit(session, prompt, allowed))) return false;
		if (context) await commit(session, { role: "user", content: [{ type: "text", text: context }], timestamp: Date.now(), synthetic: true }, allowed);
		return true;
	}

	return { commit, rewind, sentAt, rewindFiles, commitPrompt };
}
