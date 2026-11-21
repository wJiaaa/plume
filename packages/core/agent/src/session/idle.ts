import type { AgentEvent, BackgroundCallState, ParentStatus, SessionSummary } from "@plume/contract";
import type { BackgroundRuns } from "../background.ts";
import type { BackgroundJobs } from "../jobs.ts";
import type { SessionQueues } from "../queue.ts";
import type { SessionWakeups } from "../wakeups.ts";
import type { Session } from "./session.ts";

export interface IdleDeps {
	sessions: Map<string, Session>;
	emit(event: AgentEvent): void;
	summaries(): SessionSummary[];
	background: Pick<BackgroundRuns, "pending" | "hasReady">;
	jobs: Pick<BackgroundJobs, "calls" | "pending">;
	wakeups: Pick<SessionWakeups, "cancelled">;
	queues: Pick<SessionQueues, "list">;
	/** 回边：占用模块后建，在 `createAgent` 里接上。 */
	held(session: Session): boolean;
}

export interface Idle {
	/** 删掉的会话：等它闲下来的人不用再等了，记着的那份也丢掉。 */
	forget(sessionIds: readonly string[]): void;
	backgroundChanged(sessionId: string): void;
	backgroundCallsField(sessionId: string): { backgroundCalls?: Record<string, BackgroundCallState> };
	emitBackgroundCalls(sessionId: string): void;
	parentStatus(session: Session): ParentStatus;
	syncBackground(session: Session): boolean;
	waiting(sessionId: string): boolean;
	checkIdle(session: Session): void;
	whenIdle(session: Session): Promise<void>;
}

export function createIdle(deps: IdleDeps): Idle {
	const { sessions, emit, summaries, background, jobs, wakeups, queues, held } = deps;
	/** 某个会话在等的后台的事变了（派发回来、任务结束、唤醒取消……）：重新看它闲没闲，起了任务的那几次调用也跟着看一遍。 */
	const backgroundChanged = (sessionId: string) => {
		const session = sessions.get(sessionId);
		if (!session) return;
		if (syncBackground(session)) emit({ type: "sessions", sessions: summaries() });
		checkIdle(session);
		emitBackgroundCalls(sessionId);
	};
	/** 答完以后还在后台留着事的调用，见 `BackgroundCallState`：任务的和唤醒取消了的合在一起，在跑的任务盖过取消。 */
	const backgroundCallsOf = (sessionId: string): Record<string, BackgroundCallState> => {
		const calls: Record<string, BackgroundCallState> = {};
		for (const toolCallId of wakeups.cancelled(sessionId)) calls[toolCallId] = "stopped";
		return Object.assign(calls, jobs.calls(sessionId));
	};
	/** 上次推给界面的那一份，按会话：没变就不推（`backgroundChanged` 也为派发、送达叫一声）。删会话时清掉。 */
	const shownBackgroundCalls = new Map<string, string>();
	function backgroundCallsField(sessionId: string): { backgroundCalls?: Record<string, BackgroundCallState> } {
		const calls = backgroundCallsOf(sessionId);
		return Object.keys(calls).length > 0 ? { backgroundCalls: calls } : {};
	}
	function emitBackgroundCalls(sessionId: string): void {
		if (!sessions.has(sessionId)) {
			shownBackgroundCalls.delete(sessionId);
			return;
		}
		const calls = backgroundCallsOf(sessionId);
		const key = JSON.stringify(Object.entries(calls).sort(([a], [b]) => a.localeCompare(b)));
		if ((shownBackgroundCalls.get(sessionId) ?? "[]") === key) return;
		shownBackgroundCalls.set(sessionId, key);
		emit({ type: "backgroundCalls", sessionId, calls });
	}

	/** 等着某个会话真闲下来的（`launch` 的 `idle`），见 `checkIdle`。 */
	const idleWaiters = new Map<string, Array<() => void>>();

	function parentStatus(session: Session): ParentStatus {
		const sessionId = session.summary.id;
		const state = held(session) ? "running" : waiting(sessionId) ? "background" : "idle";
		return { state, queued: queues.list(sessionId).length };
	}

	/**
	 * 摘要里的 `background` 跟上后台运行：派出去时立起来，回来、撤掉时（`BackgroundRuns` 的 `changed`）和一轮收尾时再看。
	 * 交回的结果攒着待送、送达开出的那一轮还没取走时也算，所以最后一个回来到接着跑之间它不落下，界面上的交付卡片不会先挂出来再收掉。
	 * 变了返回 true，由调用方告诉界面。
	 */
	function syncBackground(session: Session): boolean {
		const now = waiting(session.summary.id);
		if ((session.summary.background === true) === now) return false;
		if (now) session.summary.background = true;
		else delete session.summary.background;
		return true;
	}

	/**
	 * 会话还在等结果：只算会自己结束、结束后要叫醒会话的——派出去的后台运行没都回来、交回的结果攒着待送（`BackgroundRuns`），
	 * 登记着的一次性后台任务没结束（`BackgroundJobs.pending`）。挂着的不算：监视、开发服务器这类长跑的任务（`BackgroundJobInput.wakes`、
	 * `TrackedJob.stand`），约好的唤醒和 cron（`SessionWakeups`）——它们照旧登记、列出、叫醒会话、被本体停掉，只是不挡会话闲下来。
	 * 被人停掉、撤回而作废的都不算。
	 */
	function waiting(sessionId: string): boolean {
		return background.pending(sessionId) || background.hasReady(sessionId) || jobs.pending(sessionId);
	}

	/** 真闲着：没在跑，后台没有在等的（`waiting`）。 */
	function isIdle(session: Session): boolean {
		return parentStatus(session).state === "idle";
	}

	function checkIdle(session: Session): void {
		if (!isIdle(session)) return;
		if (session.summary.kind === "top" && session.summary.stop?.reason === "done" && session.idleStop !== session.summary.stop) {
			session.idleStop = session.summary.stop;
			emit({ type: "idle", sessionId: session.summary.id });
		}
		const waiting = idleWaiters.get(session.summary.id);
		if (!waiting) return;
		idleWaiters.delete(session.summary.id);
		for (const resolve of waiting) resolve();
	}

	function whenIdle(session: Session): Promise<void> {
		if (isIdle(session) || !sessions.has(session.summary.id)) return Promise.resolve();
		return new Promise((resolve) => idleWaiters.set(session.summary.id, [...(idleWaiters.get(session.summary.id) ?? []), resolve]));
	}

	return {
		forget(sessionIds) {
			for (const id of sessionIds) {
				shownBackgroundCalls.delete(id);
				for (const resolve of idleWaiters.get(id) ?? []) resolve();
				idleWaiters.delete(id);
			}
		},
		backgroundChanged,
		backgroundCallsField,
		emitBackgroundCalls,
		parentStatus,
		syncBackground,
		waiting,
		checkIdle,
		whenIdle,
	};
}
