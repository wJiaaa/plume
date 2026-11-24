import { randomUUID } from "node:crypto";
import type {
	AgentEvent,
	AlwaysAllow,
	ApprovalDecision,
	ApprovalRequest,
	AssistantMessage,
	ChildTask,
	CompactionOutcome,
	HumanAnswer,
	HumanRequest,
	LetterInput,
	LetterReceipt,
	Log,
	Message,
	ModelContext,
	ParentSession,
	PeerLetter,
	PromptVerdict,
	QueuedMessage,
	SessionObservation,
	TurnCause,
	TurnStop,
	UserMessage,
} from "@plume/contract";
import { createCompactor, errorText, runSteps, sessionScope, type CompactMode, type ContextRecord, type LoopHost } from "@plume/loop";
import { type BackgroundRuns, DELIVERED_HEADER, type ReadyKind, reportTexts } from "../background.ts";
import type { ChildTasks } from "../child-tasks.ts";
import { commandAccess } from "../commands.ts";
import type { PluginHost } from "../host.ts";
import { text } from "../i18n.ts";
import type { BackgroundJobs } from "../jobs.ts";
import { lettersText } from "../letters.ts";
import { lookup, resolveModel, thinkingFor, type StoredSettings } from "../models.ts";
import { projectRootsFor } from "../project-roots.ts";
import type { Projects } from "../projects.ts";
import type { SessionQueues } from "../queue.ts";
import type { SessionDb } from "../session-db.ts";
import type { SessionWakeups } from "../wakeups.ts";
import type { Session } from "./session.ts";
import { userMessage } from "./session.ts";
import type { SpawnedReports } from "./spawned-reports.ts";
import { promptCause, reportsCause } from "./turn-cause.ts";

export interface TurnDeps {
	/** 循环要的那几样（`LoopHost`）原样交给 `@plume/loop`，自己只用 `workspace.call`。 */
	host: LoopHost & { workspace: Pick<PluginHost["workspace"], "call"> };
	log: Log;
	emit(event: AgentEvent): void;
	store: Pick<SessionDb, "saveContext" | "dropDraft">;
	messagesOf(session: Session): Promise<Message[]>;
	recordOf(session: Session): Promise<ContextRecord>;
	readSessionSettings(session: Session): Promise<StoredSettings>;
	modelOf(session: Session): string | undefined;
	buildContext(session: Session): Promise<ModelContext>;
	find(sessionId: string): Session;
	quitting(): boolean;
	held(session: Session): boolean;
	releaseHold(session: Session, controller: AbortController, settled: boolean): void;
	setRunning(session: Session, running: boolean): void;
	projects: Pick<Projects, "list">;
	attachedPaths(session: Session): Promise<string[]>;
	scratchDir(sessionId: string): string;
	lineageScratchDirs(sessionId: string): string[];
	request(session: Session, context: ModelContext, signal: AbortSignal): Promise<AssistantMessage | "switched">;
	commit(session: Session, message: Message, allowed?: () => boolean): Promise<boolean>;
	dropStaleDraft(session: Session): void;
	askUser(session: Session, request: ApprovalRequest, grant: AlwaysAllow | undefined, signal: AbortSignal): Promise<ApprovalDecision>;
	requestUser(session: Session, request: HumanRequest, signal: AbortSignal): Promise<HumanAnswer>;
	parentFor(session: Session, plugin: string): ParentSession | undefined;
	jobs: Pick<BackgroundJobs, "track">;
	background: Pick<BackgroundRuns, "channel" | "take" | "takeKind" | "hasHeld" | "hasReady" | "hold" | "letter">;
	wakeups: Pick<SessionWakeups, "schedule">;
	queues: Pick<SessionQueues, "peekSteered" | "has" | "take" | "hasSteered" | "unsteer">;
	submitPrompt(session: Session, prompt: UserMessage, signal: AbortSignal): Promise<PromptVerdict>;
	commitPrompt(session: Session, prompt: UserMessage, context: string | undefined, allowed: () => boolean): Promise<boolean>;
	relocate(session: Session, cwd: string): Promise<void>;
	observe(sessionId: string, event: SessionObservation["event"], timestamp?: number): void;
	spawned: Pick<SpawnedReports, "turnEnded">;
	handedPrompts: WeakMap<UserMessage, { childId: string; task: ChildTask }>;
	/** 插件发的那几句（`launch` 的第一句、代管插件转来的），算这一轮是谁引起的时认它们（`promptCause`）。 */
	launchedPrompts: { has(prompt: UserMessage): boolean };
	handed: Pick<ChildTasks, "settle">;
	release(session: Session): void;
	syncBackground(session: Session): boolean;
	saveSummary(session: Session): void;
	archive(session: Session, archived: boolean): void;
	sessions: Map<string, Session>;
	drainQueue(session: Session): void;
	wakeReports(session: Session): void;
	checkIdle(session: Session): void;
	admitWake(session: Session, kind: ReadyKind): boolean;
	wakeHeld(session: Session): boolean;
	queuedPrompt(entry: QueuedMessage, interrupt: boolean): UserMessage;
	thinkingOf(session: Session): Session["summary"]["thinking"];
}

export interface Turn {
	compactNow(sessionId: string, instructions: string): Promise<{ done: Promise<CompactionOutcome> }>;
	runTurn(session: Session, prompt: UserMessage | undefined, controller: AbortController, pinModel?: boolean): Promise<TurnStop>;
	active(): Iterable<Session>;
}

export function createTurn(deps: TurnDeps): Turn {
	const {
		host,
		log,
		emit,
		store,
		messagesOf,
		recordOf,
		readSessionSettings,
		modelOf,
		buildContext,
		find,
		quitting,
		held,
		releaseHold,
		setRunning,
		projects,
		attachedPaths,
		scratchDir,
		lineageScratchDirs,
		request,
		commit,
		dropStaleDraft,
		askUser,
		requestUser,
		parentFor,
		jobs,
		background,
		wakeups,
		queues,
		submitPrompt,
		commitPrompt,
		relocate,
		observe,
		spawned,
		handedPrompts,
		launchedPrompts,
		handed,
		release,
		syncBackground,
		saveSummary,
		archive,
		sessions,
		drainQueue,
		wakeReports,
		checkIdle,
		admitWake,
		wakeHeld,
		queuedPrompt,
		thinkingOf,
	} = deps;
	// 删除会话不等循环收尾；退出和卸载仍须等这些已从列表移走的运行。
	const active = new Set<Session>();
	// 压缩的问和记，见 `session-compaction.ts`。
	const compactor = createCompactor({
		host,
		log,
		emit,
		saveContext: (sessionId, record) => store.saveContext(sessionId, record),
		messagesOf: (session) => messagesOf(session as Session),
		recordOf: (session) => recordOf(session as Session),
		model: async (session) => resolveModel(await readSessionSettings(session as Session), modelOf(session as Session)),
		onCompacted: (session) => {
			(session as Session).repetition.reset();
			(session as Session).cacheBoundary = "compaction";
		},
	});

	/**
	 * `/compact`：现在就压。和一轮一样占住会话：期间界面把发的话排在后面，停止按钮停下它，打断的那条等它收完尾再开始
	 * （`begin` 等的就是 `session.turn`）。开始了就返回，`done` 在压完时给出结果。
	 */
	async function compactNow(sessionId: string, instructions: string): Promise<{ done: Promise<CompactionOutcome> }> {
		const session = find(sessionId);
		if (quitting() || held(session)) throw new Error(text("compaction.busy"));
		// 没有可用的模型就当场说，不画一行注定失败的压缩。
		resolveModel(await readSessionSettings(session), modelOf(session));
		if (quitting() || held(session)) throw new Error(text("compaction.busy"));
		const controller = new AbortController();
		session.controller = controller;
		active.add(session);
		setRunning(session, true);
		const mode: CompactMode = { force: true, fork: true, manual: { instructions } };
		const done = (async (): Promise<CompactionOutcome> => {
			try {
				const { outcome } = await compactor.compact(session, await buildContext(session), mode, controller.signal);
				return outcome;
			} catch (error) {
				log("agent", "error", `会话 ${session.summary.id} 的 /compact 没做成：${errorText(error)}`);
				return controller.signal.aborted ? { ok: false, code: "cancelled" } : { ok: false, code: "failed", error: errorText(error) };
			} finally {
				active.delete(session);
				releaseHold(session, controller, !controller.signal.aborted);
			}
		})();
		session.turn = done.then(() => (controller.signal.aborted ? { reason: "aborted" } : { reason: "done" }));
		return { done };
	}

	/**
	 * 一轮干净收尾以后、人还没开口时先问一次要不要压（`CompactMode.idle`）：越过线的那次回复刚落地、缓存还热，这时从主请求分叉
	 * 基本只付摘要的钱，等待也落在人打字的那段时间里。占着这一轮的控制器，压完才放开会话。
	 */
	async function compactIdle(session: Session, controller: AbortController): Promise<void> {
		active.add(session);
		session.idleHold = controller;
		try {
			const context = await buildContext(session);
			if (!controller.signal.aborted) await compactor.compact(session, context, { force: false, fork: true, idle: true }, controller.signal);
		} catch (error) {
			log("agent", "warn", `会话 ${session.summary.id} 收尾后的压缩没做成：${errorText(error)}`);
		} finally {
			if (session.idleHold === controller) session.idleHold = undefined;
			active.delete(session);
			releaseHold(session, controller, false);
		}
	}

	/**
	 * 把这一刻送到的读进会话：先是人的插话，再是后台结果和别的会话的信（合成一条运行时送达）。
	 * 人开口了，被信和交回接连叫起的轮数（`Session.autoWakes`）清零。
	 *
	 * `ending`：这一轮本来到这里就收场了，读进什么就接着跑什么。这时只有别的会话的信、开出来的会话的交回在等的，和闲着时被它们
	 * 叫醒是一回事，同样计数、到上限留到人开口（`admitWake`）。循环里最后一步的收件箱和一轮收尾后的接着读都走这里：只在其中一处数，
	 * 两个会话的往来总赶在对方收尾前攒好，就一直接着跑、撞不到上限。人这次插了话的不数，人开口了。
	 */
	async function consumeBoundary(session: Session, controller: AbortController, ending = false, opening = false): Promise<boolean> {
		let received = false;
		/** 这次边界里人插了话：后面一并读进的送达不改这一轮是人的。 */
		let spoke = false;
		const sessionId = session.summary.id;
		while (!controller.signal.aborted) {
			// 插件经 `ctx.sessions.steer` 插给它子会话的在内存里，人插的在排队条上（`steer`）。
			const queued = session.steering?.length ? undefined : queues.peekSteered(sessionId);
			const prompt = session.steering?.shift() ?? (queued && queuedPrompt(queued, false));
			if (!prompt) break;
			// 被这一轮接了进去，不是开了新的一轮：发给模型时据此说清它是在模型工作时说的（plume.prompt 的插话说明）。
			prompt.steered = true;
			const verdict = await submitPrompt(session, prompt, controller.signal);
			// 过钩子的那一阵人可能在条上撤回了它（字回到输入框）：那就不写，不然这句话既在会话里、又在输入框里。
			const allowed = () => !controller.signal.aborted && (!queued || queues.has(sessionId, queued.id));
			const committed = !controller.signal.aborted && !verdict.block && (await commitPrompt(session, prompt, verdict.context, allowed));
			if (committed) {
				received = true;
				if (!prompt.synthetic) delete session.autoWakes;
				// 人插话：这一轮从这里起算人的（插件插给子会话的不算）。
				if (promptCause(prompt, causeOf(session), launchedPrompts).by === "human") {
					setCause(session, { by: "human" });
					spoke = true;
				}
			}
			// 消息落进会话以后才从条上收走：反过来的话，条先空、气泡还没到，那句话有一阵子哪里都不在。写进去以后才被停下的照样收走，
			// 不然停下后它成了普通的一条，又发一遍。
			if (queued && committed) queues.take(sessionId, queued.id);
			// 读到一半被停下：排队条上那一条还没写进去，人按停不该把刚说的话吞掉。
			if (controller.signal.aborted) return received;
			if (verdict.block) {
				if (queued) queues.take(sessionId, queued.id);
				emit({ type: "notice", sessionId, text: verdict.reason, level: "warn" });
			}
		}
		if (controller.signal.aborted) return received;
		if (ending && !received) {
			const kind = background.takeKind(sessionId);
			if (kind !== undefined && !admitWake(session, kind)) return received;
		}
		let reports = background.take(session.summary.id);
		// 信和开出来的会话交回的（`delivery.sessionId`）不是这个会话自己派出去的事：没写进会话就收了场的放回去，同 `BackgroundRuns.cancelSession`。
		const taken = reports.filter((report) => "letter" in report || report.delivery?.sessionId !== undefined);
		let delivered = false;
		try {
			while (!controller.signal.aborted && reports.length > 0) {
				const texts = reportTexts(reports);
				const letters = reports.flatMap((report) => ("letter" in report ? [report.letter] : []));
				const delivery = reports.flatMap((report) => ("delivery" in report && report.delivery ? [report.delivery] : []));
				const words = [...(texts.length ? [`${DELIVERED_HEADER}\n\n${texts.join("\n\n")}`] : []), ...(letters.length ? [lettersText(letters)] : [])].join(
					"\n\n",
				);
				// `delivery`、`peer` 给界面画成对话里的一行，不是一个人发的气泡。
				const prompt: UserMessage = {
					...userMessage({ content: [{ type: "text", text: words }], synthetic: true }),
					...(delivery.length ? { delivery } : {}),
					...(letters.length ? { peer: letters.map((letter) => letter.peer) } : {}),
				};
				const verdict = await submitPrompt(session, prompt, controller.signal);
				if (controller.signal.aborted) return received;
				// 某份在钩子等待期间撤回，剩下的重走钩子，不夹带基于旧正文产生的 context。
				const valid = reports.filter((report) => report.valid());
				if (valid.length !== reports.length) {
					reports = valid;
					continue;
				}
				if (verdict.block) {
					emit({ type: "notice", sessionId: session.summary.id, text: verdict.reason, level: "warn" });
					break;
				}
				if (await commitPrompt(session, prompt, verdict.context, () => !controller.signal.aborted && reports.every((report) => report.valid()))) {
					// 一轮开头读进的、做完前读进而接着做的，这一轮是它们引起的；做到一半顺带读进的、和人的插话一起读进的不改。
					if ((opening || ending) && !spoke) setCause(session, reportsCause(reports, session.cause, session.causeWaited === true));
					for (const letter of letters) letter.settle({ status: "read" });
					received = true;
					delivered = true;
					break;
				}
				reports = reports.filter((report) => report.valid());
			}
			return received;
		} finally {
			// 没写进会话就收了场的信（读到了的已经定下，不再改）：会话删掉、应用退出是 `closed`；钩子拦下的算没读到（`dropped`）；
			// 这一轮被打断（人按停、插话、编辑重发）的留到下一轮开头读，见 `BackgroundRuns.cancelSession`。
			// 交回同理：被打断的留到下一轮，删掉、退出、被钩子拦下的不再送。
			const left = delivered ? [] : taken.filter((report) => report.valid());
			const closed = quitting() || !sessions.has(sessionId);
			for (const report of left) {
				if (!("letter" in report)) continue;
				if (closed) report.letter.settle({ status: "closed" });
				else if (!controller.signal.aborted) report.letter.settle({ status: "dropped" });
			}
			if (!closed && controller.signal.aborted) background.hold(sessionId, left);
		}
	}

	/**
	 * `from` 给 `toId` 寄一封信（`ToolRun.letter`）。两边都得是顶层会话；发件方的 id、目录照实填。信是单向的，见 `LetterReceipt`。
	 * 信不替人做主：人按了停的会话不为它开一轮，留到人开口（`wakeReports`），回执照实说（`held`）。归档了的会话收工了，不再寄信。
	 */
	function postLetter(from: Session, toId: string, input: LetterInput): LetterReceipt {
		const to = sessions.get(String(toId));
		if (quitting() || !sessions.has(from.summary.id)) throw new Error(text("session.parentStopped"));
		if (from.summary.archived) throw new Error(text("session.archivedSender"));
		if (!to || to.summary.kind !== "top" || to.summary.archived || from.summary.kind !== "top" || to === from)
			throw new Error(text("session.badLetterTarget", { id: String(toId) }));
		const words = typeof input?.text === "string" ? input.text.trim() : "";
		const address = typeof input?.from === "string" ? input.from.trim() : "";
		if (!words || !address) throw new Error(text("session.emptyMessage"));
		const peer: PeerLetter = { id: randomUUID(), sessionId: from.summary.id, from: address, text: words, cwd: from.summary.cwd };
		// 「会话在不在忙」只看 `held`（见 `Session.controller`），不另看 `summary.running`。
		const queued = held(to);
		const read = background.letter(to.summary.id, peer, typeof input.guide === "string" && input.guide.trim() ? input.guide : undefined);
		return { id: peer.id!, queued, held: wakeHeld(to), read };
	}

	const causeOf = (session: Session) => ({ kind: session.summary.kind, launchedBy: session.launchedBy });

	/** 记下这一轮是谁引起的；这一轮已经交给循环的那份会话信息跟着改，之后的钩子、工具读到新的。 */
	function setCause(session: Session, cause: TurnCause): void {
		session.cause = cause;
		if (session.turnScope) session.turnScope.cause = structuredClone(cause);
	}

	async function runTurn(session: Session, prompt: UserMessage | undefined, controller: AbortController, pinModel = false): Promise<TurnStop> {
		const sessionId = session.summary.id;
		active.add(session);
		session.looping = controller;
		delete session.summary.stop;
		session.hiccups = [];
		emit({ type: "hiccups", sessionId, hiccups: [] });
		setRunning(session, true);
		// 人发来新消息就从头数；「继续」这类界面替人说的不算，接着做的还是同一件事。
		if (prompt && !prompt.synthetic) {
			session.repetition.reset();
			delete session.autoWakes;
		}
		let stop: TurnStop;
		try {
			if (pinModel) {
				// 后台任务与续跑使用同一模型，不因父会话换模型或配置失效而悄悄换人。
				const settings = await readSessionSettings(session);
				if (session.summary.model && !lookup(settings, session.summary.model)) throw new Error(text("model.unavailable", { model: session.summary.model }));
				const { model } = resolveModel(settings, modelOf(session));
				session.summary.thinking = thinkingFor(model, thinkingOf(session));
				session.summary.model = model.id;
			}
			const steps = () =>
				runSteps({
					sessionId,
					session: (session.turnScope = sessionScope(session.summary, session.cause)),
					cwd: session.summary.cwd,
					projectRoots: projectRootsFor(projects.list(), session.summary.cwd, session.summary.project),
					allowedPaths: () => attachedPaths(session),
					scratchDir: scratchDir(sessionId),
					scratchDirs: () => lineageScratchDirs(sessionId),
					signal: controller.signal,
					host,
					log,
					repetition: session.repetition,
					context: () => buildContext(session),
					boundary: (ending) => consumeBoundary(session, controller, ending),
					request: (context) => request(session, context, controller.signal),
					commit: async (message) => {
						await commit(session, message);
					},
					notice: (text, level) => emit({ type: "notice", sessionId, text, ...(level ? { level } : {}) }),
					compact: (context, force) => {
						dropStaleDraft(session);
						// 超长恢复不分叉：完整历史本来就放不下，分叉请求只会再被拒一次。
						return compactor.compact(session, context, { force, fork: !force }, controller.signal).then((result) => result.compacted);
					},
					withhold: () => {
						dropStaleDraft(session);
						return compactor.withhold(session);
					},
					permission: async () => {
						const settings = await readSessionSettings(session);
						return { mode: settings.permissionMode ?? "auto", alwaysAllow: settings.alwaysAllow ?? [] };
					},
					ask: (approval, grant) => askUser(session, approval, grant, controller.signal),
					requestHuman: (request) => requestUser(session, request, controller.signal),
					answeredBy: (toolCallId) => {
						const plugin = session.answeredBy?.get(toolCallId);
						session.answeredBy?.delete(toolCallId);
						return plugin;
					},
					parent: (plugin) => parentFor(session, plugin),
					commands: commandAccess,
					// 只有顶层会话的任务算在等：结果经那次调用的送达渠道送回来，渠道作废（人按停、撤回）就不再算。子会话没有渠道。
					track: (plugin, toolCallId, job) =>
						jobs.track(
							sessionId,
							plugin,
							toolCallId,
							job,
							session.summary.kind === "top" ? background.channel(sessionId, toolCallId, plugin).signal : undefined,
						),
					files: (call) => host.workspace.call(call),
					started: (toolCallId) => {
						const at = Date.now();
						session.startedAt.set(toolCallId, at);
						emit({ type: "toolStart", sessionId, toolCallId, startedAt: at });
					},
					traced: (toolCallId, trace) => observe(sessionId, { type: "hooks", toolCallId, ...trace }),
					// 后台结果只回顶层会话：插件的子会话、独立会话没人等它们的后台结果，见 `ToolRun.background`。
					...(session.summary.kind !== "top"
						? {}
						: {
								background: (plugin, toolCallId) => background.channel(sessionId, toolCallId, plugin),
								schedule: (plugin, toolCallId, wake) =>
									wakeups.schedule(sessionId, plugin, toolCallId, background.channel(sessionId, toolCallId, plugin), wake),
								letter: (_plugin, to, letter) => postLetter(session, to, letter),
								archiveAfterTurn: () => void (session.archiveAfterTurn = controller),
							}),
					progress: (toolCallId, output, push) => {
						if (output === undefined) {
							session.progress.delete(toolCallId);
							session.startedAt.delete(toolCallId);
						} else session.progress.set(toolCallId, output);
						if (push && output !== undefined) emit({ type: "progress", sessionId, toolCallId, output });
					},
				});
			let accepted = false;
			if (prompt) {
				const verdict = await submitPrompt(session, prompt, controller.signal);
				if (verdict.block) emit({ type: "notice", sessionId, text: verdict.reason, level: "warn" });
				else if (!controller.signal.aborted) {
					if (verdict.cwd !== undefined) await relocate(session, verdict.cwd);
					accepted = await commitPrompt(session, prompt, verdict.context, () => !controller.signal.aborted);
					if (accepted) setCause(session, promptCause(prompt, causeOf(session), launchedPrompts));
					// 人按停时留下的通知、答复在这一轮开头读到，接在人这句后面。
					if (accepted && background.hasHeld(sessionId)) await consumeBoundary(session, controller);
				}
			} else accepted = await consumeBoundary(session, controller, false, true);
			// 拦下的这条没写进会话，这一轮什么也没做，按完成收场：不留「已暂停 · 继续」。
			stop = controller.signal.aborted ? { reason: "aborted" } : !accepted ? { reason: "done" } : await steps();
			// 最后一次边界返回后、await 恢复前也可能入队；仍在原轮里串行消费，不丢插话。步骤已经做完，这时读到的是叫起了它（`ending`）。
			// 什么也没读进（到了上限留着、钩子拦下、都作废了）就收场，剩下的由收场后的 `wakeReports` 再看。
			while (
				!controller.signal.aborted &&
				stop.reason === "done" &&
				(session.steering?.length || queues.hasSteered(sessionId) || background.hasReady(sessionId))
			) {
				if (!(await consumeBoundary(session, controller, true))) break;
				stop = await steps();
			}
			if (controller.signal.aborted) stop = { reason: "aborted" };
		} catch (error) {
			if (controller.signal.aborted) stop = { reason: "aborted" };
			else {
				emit({ type: "notice", sessionId, text: errorText(error) });
				log("agent", "error", `会话 ${sessionId} 出错：${errorText(error)}`);
				stop = { reason: "error", error: errorText(error) };
			}
		}
		dropStaleDraft(session);
		// 从这里起不再有循环来取插话：之后送来的排进队尾或开新的一轮，见 `steer`。
		if (session.looping === controller) session.looping = undefined;
		// 退出应用时停下的不是人按的停：重开以后说「上次执行被中断」，而不是「已暂停」。
		const final: TurnStop = stop.reason === "aborted" && session.quitting ? { reason: "interrupted" } : stop;
		session.summary.stop = final;
		// 先把「还在不在等后台」对到此刻再说收场：后台结果叫起的这一轮开头取走那批送达时不重算它（`take`），不先对，
		// 观察者和交回（`spawned`）在收场这一刻读到的还是开轮前那个「在等」，会当它还有事没回来，汇报不叫醒来处。
		syncBackground(session);
		session.causeWaited = session.summary.background === true;
		delete session.turnScope;
		observe(sessionId, { type: "turnEnd", stop: session.summary.stop });
		// 开出来的会话把这一轮交回来处；赶在放开会话之前，放开时叫的 `nudgeOrigin` 看得到这一份。
		spawned.turnEnded(session, final);
		const task = prompt && handedPrompts.get(prompt);
		if (task) handed.settle(task.childId, task.task, session.summary.stop);
		// 干净收尾的、人自己的会话，趁缓存还热先问一次要不要压（`compactIdle`）：控制器先不放，压完由它放开会话。
		// 子会话不压：插件派它做完一件事就收了，提前压的那一次多半白花钱。
		const idle =
			session.controller === controller &&
			stop.reason === "done" &&
			!controller.signal.aborted &&
			!quitting() &&
			session.sent !== undefined &&
			session.summary.kind === "top";
		// 被一条打断的消息接替了：新的一轮紧接着开始，这里不说「停了」，免得界面闪一下「已暂停」。
		if (session.controller === controller && !idle) release(session);
		try {
			// 这一轮里没变成消息的草稿（流到一半抛错、拒收后没写进会话的回复）不留给下次打开时恢复。
			store.dropDraft(sessionId);
			saveSummary(session);
		} catch (error) {
			log("agent", "error", `会话 ${sessionId} 的摘要没存上：${errorText(error)}`);
		}
		/*
		 * 这一轮里有工具要求归档（`ToolRun.archiveAfterTurn`）：工具里不能当场归档，那时这一轮还在等它的结果，所以等到这里。
		 * 只认以完成收场的那一轮：人在调用之后按的停是更新的意思，出错、卡住时归档会把出的事藏起来。不管怎么收场，请求都只管这一轮。
		 */
		if (session.archiveAfterTurn === controller) {
			session.archiveAfterTurn = undefined;
			if (stop.reason === "done" && !quitting() && sessions.get(sessionId) === session) archive(session, true);
		}
		active.delete(session);
		// 后面接着开的一轮（`begin` 等的是 `session.turn`）要等收尾的压缩做完；排着的、送达的由压完放开会话时（`releaseHold`）接着推。
		if (idle) session.turn = compactIdle(session, controller).then(() => stop);
		else {
			/*
			 * 排队条上还有没读到的插话（被停下、出错、撞了上限收的场）：后面没有接着开的一轮来读它们，就去掉标记、留在队首，
			 * 和排着的话一样等人；被打断换了一轮的留给那一轮读。
			 */
			if (!held(session) && !quitting()) queues.unsteer(sessionId);
			// 这一轮做完了就发下一条排着的；停了、出错了就留着等人，按停说的是现在别再接着做。
			if (stop.reason === "done") drainQueue(session);
			// 聚合计时器可能恰好在收尾的 await 期间到期，释放循环后再看一眼。
			wakeReports(session);
			checkIdle(session);
		}
		// 不读 `summary.stop`：上面 `wakeReports` 可能当场开起下一轮，它开头就清掉了。
		return structuredClone(final);
	}

	return { compactNow, runTurn, active: () => active.values() };
}
