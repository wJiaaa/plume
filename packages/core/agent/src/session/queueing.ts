import type { AgentEvent, ChildTask, Log, OutgoingMessage, QueuedMessage, UserMessage } from "@plume/contract";
import { errorText } from "@plume/loop";
import { ChildTasks } from "../child-tasks.ts";
import { text } from "../i18n.ts";
import { SessionQueues, childTask, type Source } from "../queue.ts";
import type { SessionDb } from "../session-db.ts";
import { userMessage, type Session } from "./session.ts";

export interface QueueingDeps {
	store: Pick<SessionDb, "queues" | "saveQueue">;
	sessions: Map<string, Session>;
	emit(event: AgentEvent): void;
	log: Log;
	quitting(): boolean;
	held(session: Session): boolean;
	looping(session: Session): boolean;
	begin(session: Session, prompt: UserMessage): void;
	/** 回边：派发模块后建，在 `createAgent` 里接上。 */
	launchedPrompts: Pick<WeakSet<UserMessage>, "add">;
	find(sessionId: string): Session;
}

export interface Queueing {
	handed: ChildTasks;
	handedPrompts: WeakMap<UserMessage, { childId: string; task: ChildTask }>;
	handedOf(childId: string): ChildTask[];
	queues: SessionQueues;
	queuedPrompt(entry: QueuedMessage, interrupt: boolean): UserMessage;
	drainQueue(session: Session): void;
	steer(session: Session, message: OutgoingMessage): void;
	enqueue(session: Session, message: OutgoingMessage, preview: string, source?: Source): QueuedMessage;
	enqueueTask(child: Session, instruction: unknown): boolean;
}

export function createQueueing(deps: QueueingDeps): Queueing {
	const { store, sessions, emit, log, quitting, held, looping, begin, launchedPrompts, find } = deps;
	/** 子会话交给父会话的那几件事走到了哪，见 `ChildTask`。 */
	const handed = new ChildTasks((childId) => emitHanded(childId));
	/** 这一轮是为交过来的哪件事跑的：按这一轮的第一句认，收场时落到那件事上。 */
	const handedPrompts = new WeakMap<UserMessage, { childId: string; task: ChildTask }>();
	const handedOf = (childId: string): ChildTask[] => {
		const parentId = sessions.get(childId)?.summary.parentId;
		return handed.list(childId, parentId ? queues.list(parentId) : []);
	};
	function emitHanded(childId: string): void {
		if (sessions.has(childId)) emit({ type: "tasks", sessionId: childId, tasks: handedOf(childId) });
	}
	const queues = SessionQueues.open(
		store,
		(sessionId, queue) => {
			emit({ type: "queue", sessionId, queue });
			// 排着的也算在子会话的任务里（`ChildTask` 的 `queued`）：交过事的子会话跟着变。
			for (const childId of handed.sidesOf(sessionId)) emitHanded(childId);
		},
		(error) => log("agent", "warn", `排队的消息没存上：${errorText(error)}`),
	);

	/**
	 * 排着的一条变成这一轮的第一句：带着它的来处（子会话交过来的、代管插件转来的），「现在就发」的带着打断的说明。
	 * 子会话交过来的，那件事（`ChildTask`）从这里起是「在跑」，这一轮收场时落定（`runTurn`）。
	 */
	function queuedPrompt(entry: QueuedMessage, interrupt: boolean): UserMessage {
		const prompt = userMessage({ ...entry.message, ...(interrupt ? { interrupt: true } : {}) });
		if (entry.origin) prompt.origin = entry.origin;
		// 代管插件转来的：记下是哪个插件；`prompt.submit` 据此知道这句不是人在输入框里发的（`PromptSubmit.launched`）。
		if (entry.origin === "plugin" && entry.fromPlugin) {
			prompt.fromPlugin = entry.fromPlugin;
			launchedPrompts.add(prompt);
		}
		const childId = entry.childId;
		const owner = childId ? sessions.get(childId)?.summary.owner : undefined;
		if (owner) prompt.fromPlugin = owner;
		if (childId && sessions.has(childId)) handedPrompts.set(prompt, { childId, task: handed.start({ ...entry, childId }) });
		return prompt;
	}

	/**
	 * 闲着就发队首，忙着、停着的不动：队伍只在这一轮以完成收场和有人排进来时往前走。
	 */
	function drainQueue(session: Session): void {
		if (quitting() || held(session) || !sessions.has(session.summary.id)) return;
		const next = queues.take(session.summary.id);
		if (next) begin(session, queuedPrompt(next, false));
	}

	/**
	 * 人在一轮中途插的话（会话忙时按回车、命令声明的 `deliver: "steer"`）。有循环在跑就排进队首、标成插话（`QueuedMessage.steered`），
	 * 做完手上这一步、下一次请求之前读到（`consumeBoundary`）；读到之前它在排队条上，人看得见、撤得回。
	 * 这一轮已经在收尾（收尾的压缩、`/compact`、被打断后还没停稳）、不会再有循环来取时排进队尾，跟在这件事后面发。
	 */
	function steer(session: Session, message: OutgoingMessage): void {
		const prompt = userMessage(message);
		// 排队条上那一行：气泡里画的字，没有就是发给模型的正文。
		const preview = prompt.displayText ?? prompt.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
		if (looping(session)) {
			queues.push(session.summary.id, message, preview.replace(/\s+/g, " ").trim(), {}, true);
			return;
		}
		enqueue(session, message, preview);
	}

	/** 排进队尾；会话空着（上一轮被停下、队里还有前面的）就由这一下把队伍推起来。 */
	function enqueue(session: Session, message: OutgoingMessage, preview: string, source?: Source): QueuedMessage {
		if (session.summary.owner) throw new Error(text("session.pluginOwned", { plugin: session.summary.owner }));
		if (quitting()) throw new Error(text("session.parentStopped"));
		// 先校验成一条消息：形状不对的现在就报，不等轮到它时才发现发不出去。
		userMessage(message);
		const entry = queues.push(session.summary.id, message, preview.replace(/\s+/g, " ").trim(), source);
		drainQueue(session);
		return entry;
	}

	/**
	 * 子会话 `child` 交给父会话的一件事（插件的 `ParentSession.enqueue`、人在卡片上点的「交给主会话」、重试）。
	 * 返回排上那一刻它是不是就开始了。
	 */
	function enqueueTask(child: Session, instruction: unknown): boolean {
		const session = find(child.summary.parentId!);
		const words = typeof instruction === "string" ? instruction.trim() : "";
		if (!words) throw new Error(text("session.emptyMessage"));
		handed.handed(session.summary.id, child.summary.id);
		const entry = enqueue(session, childTask(words), words, { origin: "child", childId: child.summary.id });
		return !queues.list(session.summary.id).some((queued) => queued.id === entry.id);
	}

	return { handed, handedPrompts, handedOf, queues, queuedPrompt, drainQueue, steer, enqueue, enqueueTask };
}
