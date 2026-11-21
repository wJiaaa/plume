import type {
	Log,
	Message,
	ParentSession,
	ParentStatus,
	PromptVerdict,
	SessionAccess,
	SessionMessage,
	SessionObservation,
	TurnStop,
	UserMessage,
} from "@plume/contract";
import { keptRecord, sessionScope, type ContextRecord } from "@plume/loop";
import type { BackgroundRuns } from "../background.ts";
import type { PluginHost } from "../host.ts";
import { text } from "../i18n.ts";
import type { SessionQueues } from "../queue.ts";
import type { SessionDb } from "../session-db.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { userMessage, type Session } from "./session.ts";

/** 开出来的会话的短名（`SessionLaunch.spawnedFrom.name`）。 */
const SPAWN_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

export interface DispatchDeps {
	host: Pick<PluginHost, "run" | "toolOwners"> & { workspace: Pick<PluginHost["workspace"], "beginPrompt"> };
	messagesOf(session: Session): Promise<Message[]>;
	observe(sessionId: string, event: SessionObservation["event"], timestamp?: number): void;
	lifecycle: Pick<Lifecycle, "checkChoice" | "createPlain" | "existingCwd" | "stopSession">;
	find(sessionId: string): Session;
	recordOf(session: Session): Promise<ContextRecord>;
	sessions: Map<string, Session>;
	begin(session: Session, prompt: UserMessage): void;
	whenIdle(session: Session): Promise<void>;
	store: Pick<SessionDb, "messages">;
	log: Log;
	quitting(): boolean;
	background: Pick<BackgroundRuns, "reportBack">;
	held(session: Session): boolean;
	/** 回边：回合模块后建，在 `createAgent` 里接上。 */
	runTurn(session: Session, prompt: UserMessage | undefined, controller: AbortController, pinModel?: boolean): Promise<TurnStop>;
	parentStatus(session: Session): ParentStatus;
	enqueueTask(child: Session, instruction: unknown): boolean;
	queues: Pick<SessionQueues, "remove">;
	handed: { discard(parentId: string): void };
	commit(session: Session, message: Message, allowed?: () => boolean): Promise<boolean>;
}

export interface Dispatch {
	submitPrompt(session: Session, prompt: UserMessage, signal: AbortSignal): Promise<PromptVerdict>;
	launchedPrompts: WeakSet<UserMessage>;
	launchSession(owner: string, options: Parameters<SessionAccess["launch"]>[0] | undefined): ReturnType<SessionAccess["launch"]>;
	forkedHistory(source: Session | undefined, toolCallId: string | undefined): Promise<{ messages: Message[]; record: ContextRecord }>;
	reportBack(owner: string, sessionId: string, words: string, options: Parameters<SessionAccess["reportBack"]>[2]): boolean;
	childMessage(message: string | SessionMessage): UserMessage;
	sendChild(session: Session, message: string | SessionMessage, signal: AbortSignal | undefined): Promise<TurnStop>;
	lastReply(messages: readonly Message[], since?: number): string;
	calledBy(session: Session, toolCallId: string | undefined, plugin: string): boolean;
	parentFor(child: Session, plugin: string): ParentSession | undefined;
}

export function createDispatch(deps: DispatchDeps): Dispatch {
	const {
		host,
		messagesOf,
		observe,
		lifecycle: { checkChoice, createPlain, existingCwd, stopSession },
		find,
		recordOf,
		sessions,
		begin,
		whenIdle,
		store,
		log,
		quitting,
		background,
		held,
		runTurn,
		parentStatus,
		enqueueTask,
		queues,
		handed,
		commit,
	} = deps;
	/** 插件发的话（经 `launch` 发的第一句、代管插件经 `post` 转来的）：`prompt.submit` 据此告诉插件这句不是人在输入框里发的（`PromptSubmit.launched`）。 */
	const launchedPrompts = new WeakSet<UserMessage>();

	/** 钩子 `prompt.submit`：这条消息写进会话之前问插件，最里层是放行。拦下的理由必须是一句话。 */
	async function submitPrompt(session: Session, prompt: UserMessage, signal: AbortSignal): Promise<PromptVerdict> {
		const words = prompt.displayText ?? prompt.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		const fresh = (await messagesOf(session)).length === 0;
		signal.throwIfAborted();
		// 正在撤销改动时不开新的一问；送进会话期间撤销也不能开始（之后这一轮在跑，撤销看会话在跑）。
		const release = host.workspace.beginPrompt();
		if (!release) return { block: true, reason: text("changes.undoBusy") };
		let verdict: PromptVerdict;
		try {
			verdict = await host.run(
				"prompt.submit",
				{
					sessionId: session.summary.id,
					session: sessionScope(session.summary),
					cwd: session.summary.cwd,
					text: words,
					attachments: (prompt.attachments ?? []).map((item) => item.name),
					synthetic: prompt.synthetic === true,
					fresh,
					launched: launchedPrompts.has(prompt),
					signal,
				},
				async () => ({ block: false }),
				{ trace: (trace) => observe(session.summary.id, { type: "hooks", ...trace }) },
			);
		} finally {
			release();
		}
		if (verdict?.block === true)
			return { block: true, reason: typeof verdict.reason === "string" && verdict.reason.trim() ? verdict.reason : text("prompt.blocked") };
		return {
			block: false,
			...(typeof verdict?.context === "string" && verdict.context.trim() ? { context: verdict.context } : {}),
			...(typeof verdict?.cwd === "string" && verdict.cwd ? { cwd: verdict.cwd } : {}),
		};
	}

	/**
	 * 插件开的新会话（`ctx.sessions.launch`）：建一个顶层会话、当场开第一轮，和人新建会话再发第一句话走同一条路。
	 * 不记 `owner`：开出来就是人的会话，插件只拿到这一轮的结果；要了 `steward` 的记下它是代管插件（见 `stewarded`）。
	 * 目录要是已有的：插件给的路径没人看过，错了的话第一轮的每个工具都会失败，不如当场说清楚。
	 * `fork` 的先复制来处在那次调用之前的记录（见 `forkedHistory`）。
	 */
	async function launchSession(owner: string, options: Parameters<SessionAccess["launch"]>[0] | undefined): ReturnType<SessionAccess["launch"]> {
		if (quitting()) throw new Error(text("session.quitting"));
		const words = typeof options?.message === "string" ? options.message : "";
		if (!words.trim()) throw new Error(text("session.emptyMessage"));
		await checkChoice(options);
		const from = options?.spawnedFrom;
		const source = from !== undefined ? find(String(from?.sessionId)) : undefined;
		if (source && source.summary.kind !== "top") throw new Error(text("session.nestedChild"));
		const name = typeof from?.name === "string" ? from.name.trim() : "";
		if (name && !SPAWN_NAME.test(name)) throw new Error(text("session.badSpawnName", { name }));
		const history = options?.fork === true ? await forkedHistory(source, from?.toolCallId) : undefined;
		const cwd = await existingCwd(options);
		const title = typeof options?.title === "string" ? options.title.replace(/\s+/g, " ").trim().slice(0, 80) : "";
		const summary = await createPlain(
			{ ...(options?.project ? { project: String(options.project) } : {}), ...(cwd ? { cwd } : {}) },
			{
				...(title ? { title } : {}),
				...(options?.model !== undefined ? { model: options.model } : {}),
				...(options?.thinking !== undefined ? { thinking: options.thinking } : {}),
				...(from
					? {
							spawnedFrom: {
								sessionId: String(from.sessionId),
								...(typeof from.toolCallId === "string" ? { toolCallId: from.toolCallId } : {}),
								...(name ? { name } : {}),
							},
						}
					: {}),
				...(options?.steward === true ? { steward: owner } : {}),
			},
			history,
		);
		const session = sessions.get(summary.id)!;
		session.launchedBy = owner;
		const first = userMessage({ content: [{ type: "text", text: words }] });
		launchedPrompts.add(first);
		begin(session, first);
		log("agent", "info", `插件 ${owner} 开了会话 ${summary.id}${history ? "（带着来处的记录）" : ""}`);
		const done = session.turn!.then((stop) => structuredClone(stop));
		return {
			session: structuredClone(summary),
			done,
			idle: done
				.catch(() => undefined)
				.then(() => whenIdle(session))
				.then(() => {
					// 闲下来以后它就只是人的会话了：开它的插件不再收它的观察（代管的照 `steward` 收）。
					delete session.launchedBy;
					return sessions.has(summary.id)
						? { stop: structuredClone(session.summary.stop), reply: lastReply(session.messages ?? store.messages(summary.id)) }
						: { reply: "" };
				}),
		};
	}

	/**
	 * `fork` 开的新会话带的记录：来处在 `toolCallId` 那次调用之前的全部消息（那次调用所在的回复还没有结果，不带），记录跟着筛（`keptRecord`）。
	 */
	async function forkedHistory(source: Session | undefined, toolCallId: string | undefined): Promise<{ messages: Message[]; record: ContextRecord }> {
		const messages = source ? await messagesOf(source) : [];
		const at = messages.findIndex(
			(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
		);
		if (!source || typeof toolCallId !== "string" || at < 0) throw new Error(text("session.badForkSource"));
		const kept = structuredClone(messages.slice(0, at));
		return { messages: kept, record: keptRecord(await recordOf(source), kept) };
	}

	/**
	 * 开出来的会话把一轮的结果交回开出它的会话（`SessionAccess.reportBack`）。认的是会话摘要上的 `spawnedFrom`，重启以后也认得；
	 * 来处只是插件当初填的一个 id：交回之前核对它真是本插件的工具在那个会话里的一次调用，插件不能借交回往随便哪个会话里说话。
	 */
	function reportBack(owner: string, sessionId: string, words: string, options: Parameters<SessionAccess["reportBack"]>[2]): boolean {
		if (!options || typeof options !== "object" || !options.delivery || typeof options.delivery !== "object") throw new Error(text("session.badDelivery"));
		if (typeof words !== "string" || !words.trim()) throw new Error(text("session.emptyMessage"));
		const from = sessions.get(String(sessionId))?.summary.spawnedFrom;
		const parent = from ? sessions.get(from.sessionId) : undefined;
		if (quitting() || !parent || parent.summary.kind !== "top" || parent.summary.archived) return false;
		if (!calledBy(parent, from?.toolCallId, owner)) throw new Error(text("session.badSpawnSource", { id: parent.summary.id }));
		// 交回不改来处被人按停的状态：叫不叫醒由 `wakeReports` 按规矩定，不叫醒的留到它下一轮开头读。
		background.reportBack(
			parent.summary.id,
			String(sessionId),
			words,
			{ delivery: options.delivery, ...(options.frame ? { frame: options.frame } : {}), wake: options.wake === true },
			owner,
		);
		return true;
	}

	function childMessage(message: string | SessionMessage): UserMessage {
		const input = typeof message === "string" ? { content: [{ type: "text" as const, text: message }] } : message;
		const prompt = userMessage({ ...input, synthetic: false, interrupt: false });
		if (typeof message !== "string" && message?.origin === "parent") prompt.origin = "parent";
		return prompt;
	}

	/** 插件在自己的子会话里跑一轮，等它结束；signal 只停止这一次运行。 */
	async function sendChild(session: Session, message: string | SessionMessage, signal: AbortSignal | undefined): Promise<TurnStop> {
		if (quitting()) throw new Error(text("session.parentStopped"));
		if (held(session)) throw new Error(text("session.running"));
		const prompt = childMessage(message);
		if (signal?.aborted) return { reason: "aborted" };
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		session.controller = controller;
		session.turn = runTurn(session, prompt, controller);
		try {
			return structuredClone(await session.turn);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** 最后一段有字的回复（`LaunchedIdle.reply`），`since` 起往后找（代答只认读到请求以后说的）。 */
	function lastReply(messages: readonly Message[], since = 0): string {
		for (let index = messages.length - 1; index >= since; index--) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			const words = message.content
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("")
				.trim();
			if (words) return words;
		}
		return "";
	}

	/** `toolCallId` 是不是插件 `plugin` 注册的工具在这个会话里的一次调用（撤回截掉了的不算）。 */
	function calledBy(session: Session, toolCallId: string | undefined, plugin: string): boolean {
		if (typeof toolCallId !== "string") return false;
		const history = session.messages ?? store.messages(session.summary.id);
		const call = history
			.flatMap((message) => (message.role === "assistant" ? message.content : []))
			.find((block) => block.type === "toolCall" && block.id === toolCallId);
		if (call?.type !== "toolCall") return false;
		return host.toolOwners().some((tool) => tool.name === call.name && tool.plugin === plugin);
	}

	/**
	 * 子会话的一次工具调用够得着的父会话（`ToolRun.parent`）：只给建这个子会话的插件注册的工具，作用对象只有它的父会话。
	 * 写进父会话的话都带着运行时来处：排进去的标着来自哪个插件，接着做是界面替人说的，作废清单是一句 synthetic。
	 */
	function parentFor(child: Session, plugin: string): ParentSession | undefined {
		const parentId = child.summary.parentId;
		if (child.summary.owner !== plugin || !parentId) return undefined;
		const current = () => find(parentId);
		return {
			id: parentId,
			enqueue: async (instruction) => ({ started: enqueueTask(child, instruction) }),
			stop: async (options) => {
				const parent = current();
				const before = parentStatus(parent);
				if (before.state !== "idle" || options?.discardPlan === true) stopSession(parent);
				if (options?.discardPlan === true) {
					await parent.turn;
					queues.remove(parentId, (entry) => entry.origin === "child");
					handed.discard(parentId);
					// 停稳以后才写：一轮还占着历史时插一句进去，会夹在调用和它的结果中间。
					if (!held(parent) && sessions.has(parentId)) {
						// i18n-exempt：给模型的话。
						const words = "用户已取消旧任务清单。不要继续旧清单；等待新的指令。";
						await commit(parent, { role: "user", content: [{ type: "text", text: words }], timestamp: Date.now(), synthetic: true });
					}
				}
				return before;
			},
			carryOn: async (words) => {
				const parent = current();
				const before = parentStatus(parent);
				if (before.state !== "idle") return before;
				if (typeof words !== "string" || !words.trim()) throw new Error(text("session.emptyMessage"));
				if (quitting()) throw new Error(text("session.parentStopped"));
				begin(parent, userMessage({ content: [{ type: "text", text: words }], synthetic: true }));
				return before;
			},
			status: () => parentStatus(current()),
		};
	}

	return { submitPrompt, launchedPrompts, launchSession, forkedHistory, reportBack, childMessage, sendChild, lastReply, calledBy, parentFor };
}
