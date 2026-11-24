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
import type { PluginHost } from "../host.ts";
import { text } from "../i18n.ts";
import type { SessionQueues } from "../queue.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { userMessage, type Session } from "./session.ts";
import type { SpawnedReports } from "./spawned-reports.ts";

/** 开出来的会话的短名（`SessionLaunch.spawnedFrom.name`）。 */
const SPAWN_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

export interface DispatchDeps {
	host: Pick<PluginHost, "run"> & { workspace: Pick<PluginHost["workspace"], "beginPrompt"> };
	messagesOf(session: Session): Promise<Message[]>;
	observe(sessionId: string, event: SessionObservation["event"], timestamp?: number): void;
	lifecycle: Pick<Lifecycle, "createPlain" | "plainChoice" | "stopSession">;
	find(sessionId: string): Session;
	recordOf(session: Session): Promise<ContextRecord>;
	sessions: Map<string, Session>;
	begin(session: Session, prompt: UserMessage): void;
	whenIdle(session: Session): Promise<void>;
	readMessages(session: Session): Message[];
	log: Log;
	quitting(): boolean;
	spawned: Pick<SpawnedReports, "callOwner">;
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
	childMessage(message: string | SessionMessage): UserMessage;
	sendChild(session: Session, message: string | SessionMessage, signal: AbortSignal | undefined): Promise<TurnStop>;
	parentFor(child: Session, plugin: string): ParentSession | undefined;
}

export function createDispatch(deps: DispatchDeps): Dispatch {
	const {
		host,
		messagesOf,
		observe,
		lifecycle: { createPlain, plainChoice, stopSession },
		find,
		recordOf,
		sessions,
		begin,
		whenIdle,
		readMessages,
		log,
		quitting,
		spawned,
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
					session: sessionScope(session.summary, session.cause),
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
		const [target, extra] = await plainChoice(options);
		const from = options?.spawnedFrom;
		const source = from !== undefined ? find(String(from?.sessionId)) : undefined;
		if (source && source.summary.kind !== "top") throw new Error(text("session.nestedChild"));
		const name = typeof from?.name === "string" ? from.name.trim() : "";
		if (name && !SPAWN_NAME.test(name)) throw new Error(text("session.badSpawnName", { name }));
		// 只核字段属实，不管该不该开。调用 id 要是本插件的工具在那个会话里的一次调用：插件不能把随便哪个会话填成来处、
		// 借交回往里说话，也不能冒认别的插件的卡。要交回的（`spawned-reports.ts` 每轮交回），那次调用得在来处本身里，交回记在它名下。
		const toolCallId = typeof from?.toolCallId === "string" ? from.toolCallId : undefined;
		const callIn = typeof from?.callIn === "string" ? from.callIn : undefined;
		const reportBack = from?.reportBack === true;
		if (source) {
			const via = callIn === undefined ? source : sessions.get(callIn);
			if (!via || (callIn !== undefined && (toolCallId === undefined || via.summary.parentId !== source.summary.id || via.summary.kind === "top")))
				throw new Error(text("session.badSpawnCallIn", { id: String(callIn) }));
			if (reportBack && (toolCallId === undefined || callIn !== undefined)) throw new Error(text("session.reportNeedsCall"));
			if (toolCallId !== undefined && spawned.callOwner(via.summary.id, toolCallId) !== owner)
				throw new Error(text("session.badSpawnSource", { id: via.summary.id }));
		}
		// 带了 `callIn` 的那次调用不在来处里，`forkedHistory` 找不到它，照样抛错。
		const history = options?.fork === true ? await forkedHistory(source, toolCallId) : undefined;
		const summary = await createPlain(
			target,
			{
				...extra,
				...(from
					? {
							spawnedFrom: {
								sessionId: String(from.sessionId),
								...(toolCallId !== undefined ? { toolCallId } : {}),
								...(callIn !== undefined ? { callIn } : {}),
								...(name ? { name } : {}),
								...(reportBack ? { reportBack: true as const } : {}),
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
					return sessions.has(summary.id) ? { stop: structuredClone(session.summary.stop), reply: lastReply(readMessages(session)) } : { reply: "" };
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

	return { submitPrompt, launchedPrompts, launchSession, childMessage, sendChild, parentFor };
}
