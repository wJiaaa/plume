import type { AgentEvent, TurnStop, UserMessage } from "@plume/contract";
import type { BackgroundRuns, ReadyKind } from "../background.ts";
import { text } from "../i18n.ts";
import type { Session } from "./session.ts";

/** 被别的会话的信、开出来的会话的交回接连叫起这么多轮、人一句话也没说时，不再叫醒（见 `wakeReports`）。 */
const AUTO_WAKE_LIMIT = 10;
/** 开出来的会话一轮停下后，等它交回的那一份进了这一批再看要不要叫醒来处（见 `nudgeOrigin`）。 */
const REPORT_SETTLE_MS = 1_000;
/**
 * 交回的一批为了和兄弟会话的合成一次送达，最多等这么久：兄弟会话里有一个要跑一小时，先做完的那份就不该陪它等一小时。
 * 一分钟够把差不多同时收场的几份凑到一起。
 */
const SPAWNED_WAIT_MS = 60_000;

export interface WakeDeps {
	background: Pick<BackgroundRuns, "hasReady" | "readyKind" | "holdReady" | "readyAt" | "cancelSession">;
	quitting(): boolean;
	held(session: Session): boolean;
	sessions: Map<string, Session>;
	/** 回边：回合模块后建，在 `createAgent` 里接上。 */
	runTurn(session: Session, prompt: UserMessage | undefined, controller: AbortController, pinModel?: boolean): Promise<TurnStop>;
	emit(event: AgentEvent): void;
}

export interface Wake {
	wakeReports(session: Session): void;
	admitWake(session: Session, kind: ReadyKind): boolean;
	/** 别的会话的信、开出来的会话的交回此刻叫不醒它：它的人按了停，或者被它们接连叫起到了上限。这时它们留到人开口。 */
	wakeHeld(session: Session): boolean;
	nudgeOrigin(session: Session): void;
}

export function createWake(deps: WakeDeps): Wake {
	const { background, quitting, held, sessions, runTurn, emit } = deps;

	/**
	 * 攒好的送达叫醒闲着的会话。别的会话的信、开出来的会话的交回（`ReadyKind` 不是 `other`）另有规矩，防几个会话原地互相叫醒，
	 * 见 `LetterReceipt`、`ReportBackOptions.wake`：
	 * - 全是交回的：来处被人按停、上一轮没以完成收场的不叫醒，留到下一轮开头读；从它开出来的会话还有在跑的先不叫，最后一个停下时再看
	 *   （`nudgeOrigin`），可最多等到这一批攒好后 `SPAWNED_WAIT_MS`，到点还有在跑的也先送。
	 * - 接连叫起到了上限的不叫醒，留到人开口，对话里提示一句。
	 * - 人按了停的什么都不叫醒，整批留到人开口：按停说的是现在别再接着做，别的会话寄来的信也不例外。
	 */
	function wakeReports(session: Session): void {
		const id = session.summary.id;
		if (quitting() || held(session) || !sessions.has(id) || !background.hasReady(id)) return;
		// 归档以后还送来的（归档时还在跑的那一轮又派出去的事回来了）：不为它开一轮，信按「不在了」结掉。
		if (session.summary.archived) return background.cancelSession(id, "closed");
		const kind = background.readyKind(id);
		// 整批在攒着的时候都作废了（撤回）：清掉，不为它白开一轮、也不让会话一直显得在等后台。
		if (kind === undefined) return background.holdReady(id);
		if (kind === "spawned") {
			const stop = session.summary.stop;
			if (session.stopped || (stop !== undefined && stop.reason !== "done")) return background.holdReady(id);
			const waited = Date.now() - (background.readyAt(id) ?? Date.now());
			if (spawnedRunning(id) && waited < SPAWNED_WAIT_MS) return waitSpawned(session, SPAWNED_WAIT_MS - waited);
		}
		// 留着而不是放着不管：放着的一批一直「攒好了」，会话就一直显得在等后台（`BackgroundRuns.pending`）。
		if (session.stopped) return background.holdReady(id);
		if (!admitWake(session, kind)) return;
		const controller = new AbortController();
		session.controller = controller;
		session.turn = runTurn(session, undefined, controller);
	}

	/**
	 * 这一批要叫起一轮（闲着时叫醒，或本来要收场的一轮为它接着跑，见 turn 的 `consumeBoundary`）：别的会话的信、交回的（不是 `other`）计一次数，到了上限整批留到人开口，
	 * 对话里提示一句——只说一次，对方还在不停地寄的话，每来一批弹一次就成了刷屏；人开口后计数清零，再撞上限再说。返回叫不叫。
	 */
	function admitWake(session: Session, kind: ReadyKind): boolean {
		if (kind === "other") return true;
		const id = session.summary.id;
		const wakes = session.autoWakes ?? 0;
		if (wakes < AUTO_WAKE_LIMIT) {
			session.autoWakes = wakes + 1;
			return true;
		}
		background.holdReady(id);
		if (wakes === AUTO_WAKE_LIMIT) {
			session.autoWakes = wakes + 1;
			emit({ type: "notice", sessionId: id, text: text("session.autoWakeLimit", { count: String(AUTO_WAKE_LIMIT) }), level: "info" });
		}
		return false;
	}

	function wakeHeld(session: Session): boolean {
		return session.stopped === true || (session.autoWakes ?? 0) >= AUTO_WAKE_LIMIT;
	}

	/**
	 * 开出来的会话一轮停下了：开出它的会话可能攒着别的会话交回的、在等它停（见 `wakeReports`）。插件读到收场再交回要一会儿，
	 * 等这一份也进了这一批再看，几份合成一次送达。
	 */
	function nudgeOrigin(session: Session): void {
		const originId = session.summary.spawnedFrom?.sessionId;
		if (!originId) return;
		setTimeout(() => {
			const origin = sessions.get(originId);
			if (origin) wakeReports(origin);
		}, REPORT_SETTLE_MS).unref?.();
	}

	/** 在等兄弟会话停下的来处，到点再看一次（`wakeReports`）；一个来处只挂一个。 */
	const spawnedWaits = new Map<string, ReturnType<typeof setTimeout>>();
	function waitSpawned(session: Session, ms: number): void {
		const id = session.summary.id;
		if (spawnedWaits.has(id)) return;
		const timer = setTimeout(() => {
			spawnedWaits.delete(id);
			const origin = sessions.get(id);
			if (origin) wakeReports(origin);
		}, ms);
		timer.unref?.();
		spawnedWaits.set(id, timer);
	}

	/** 从 `parentId` 开出来、没归档的会话还有在跑的。 */
	function spawnedRunning(parentId: string): boolean {
		for (const other of sessions.values()) if (other.summary.spawnedFrom?.sessionId === parentId && !other.summary.archived && held(other)) return true;
		return false;
	}

	return { wakeReports, admitWake, wakeHeld, nudgeOrigin };
}
