import type { AgentEvent, AssistantMessage, SessionObservation, SessionSummary, TurnStop, UserMessage } from "@plume/contract";
import type { SessionWakeups } from "../wakeups.ts";
import type { Session } from "./session.ts";

export interface OccupancyDeps {
	observe(sessionId: string, event: SessionObservation["event"], timestamp?: number): void;
	wakeups: Pick<SessionWakeups, "turnEnded">;
	/** 回边：唤醒模块后建，在 `createAgent` 里接上。 */
	nudgeOrigin(session: Session): void;
	syncBackground(session: Session): boolean;
	saveSummary(session: Session): void;
	/** 回边：队列模块后建，在 `createAgent` 里接上。 */
	drainQueue(session: Session): void;
	/** 回边：唤醒模块后建，在 `createAgent` 里接上。 */
	wakeReports(session: Session): void;
	checkIdle(session: Session): void;
	/** 回边：回合模块后建，在 `createAgent` 里接上。 */
	runTurn(session: Session, prompt: UserMessage | undefined, controller: AbortController, pinModel?: boolean): Promise<TurnStop>;
	emit(event: AgentEvent): void;
	summaries(): SessionSummary[];
}

export interface Occupancy {
	held(session: Session): boolean;
	begin(session: Session, prompt: UserMessage): void;
	release(session: Session): void;
	releaseHold(session: Session, controller: AbortController, settled: boolean): void;
	setDraft(session: Session, draft: AssistantMessage | undefined): void;
	dropStaleDraft(session: Session): void;
	observeDraft(session: Session, id: string, draft: AssistantMessage | undefined): void;
	setRunning(session: Session, running: boolean): void;
	looping(session: Session): boolean;
}

export function createOccupancy(deps: OccupancyDeps): Occupancy {
	const { observe, wakeups, nudgeOrigin, syncBackground, saveSummary, drainQueue, wakeReports, checkIdle, runTurn, emit, summaries } = deps;

	/** 会话在忙：有一轮、`/compact` 或收尾的压缩占着它，见 `Session.controller`。 */
	function held(session: Session): boolean {
		return session.controller !== undefined;
	}

	/**
	 * 放开会话（`controller`、`turn` 一起清），告诉观察者不在跑了，再让等它的接着走：开出它的会话（`nudgeOrigin`），
	 * 循环的唤醒下次到点照常送（`SessionWakeups.turnEnded`）。没送进来的插话作废。
	 */
	function release(session: Session): void {
		session.controller = undefined;
		session.turn = undefined;
		session.steering = [];
		session.summary.running = false;
		observe(session.summary.id, { type: "running", running: false });
		nudgeOrigin(session);
		wakeups.turnEnded(session.summary.id);
	}

	/** 一轮之外的压缩（`/compact`、一轮收尾以后）收场：放开会话；没被停下的算作干净收尾，界面上排着的话接着发。 */
	function releaseHold(session: Session, controller: AbortController, settled: boolean): void {
		if (session.controller !== controller) return;
		if (settled) session.summary.stop = { reason: "done" };
		release(session);
		syncBackground(session);
		saveSummary(session);
		// 压缩占着会话时排进来的，压完接着发；人按停的不发，和一轮被停下一样留着等人。
		if (!controller.signal.aborted && session.summary.stop?.reason === "done") drainQueue(session);
		wakeReports(session);
		checkIdle(session);
	}

	/** 开始新的一轮；上一轮还没收完尾（被打断的那一轮）时排在它后面。 */
	function begin(session: Session, prompt: UserMessage): void {
		session.stopped = false;
		const previous = session.turn;
		session.controller?.abort();
		const controller = new AbortController();
		session.controller = controller;
		session.turn = (async () => {
			await previous;
			return runTurn(session, prompt, controller);
		})();
	}

	function setDraft(session: Session, draft: AssistantMessage | undefined): void {
		session.draft = draft;
		emit({ type: "draft", sessionId: session.summary.id, draft });
	}

	/** 没落进会话的回复（拒收、超长后要重发的，这一轮出错收场的）不该一直挂在界面上。 */
	function dropStaleDraft(session: Session): void {
		if (session.draft) setDraft(session, undefined);
		if (session.observedDraft) observeDraft(session, session.observedDraft, undefined);
	}

	/**
	 * 把 `id` 那次请求写着的回复推给订了草稿的观察者；undefined 是作废，观察者没看过这次请求的快照时不说。
	 * 和界面的草稿分开记：界面只要最新那份，观察者要按请求认出哪一截作废了（重试从头写、放手、没写进会话）。
	 */
	function observeDraft(session: Session, id: string, draft: AssistantMessage | undefined): void {
		if (!draft && session.observedDraft !== id) return;
		session.observedDraft = draft ? id : undefined;
		observe(session.summary.id, { type: "draft", id, draft });
	}

	function setRunning(session: Session, running: boolean): void {
		session.summary.running = running;
		observe(session.summary.id, { type: "running", running });
		emit({ type: "sessions", sessions: summaries() });
	}

	/** 有循环在跑、还会在下一次请求前来取插话。 */
	function looping(session: Session): boolean {
		const controller = session.controller;
		return controller !== undefined && session.looping === controller && !controller.signal.aborted;
	}

	return { held, begin, release, releaseHold, setDraft, dropStaleDraft, observeDraft, setRunning, looping };
}
