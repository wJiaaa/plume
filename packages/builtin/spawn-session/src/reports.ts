/**
 * 开出来的会话每结束一轮，把它最后那段回复的前 400 字交回开出它的会话（`SessionAccess.reportBack`）。
 *
 * 叫不叫醒来处（`wake`），看这一轮是谁引起的：开出来的第一轮、来处寄来的信引起的那一轮叫醒；人在它里面说话引起的、被停下的、
 * 出错的不叫醒，汇报留到来处下一轮开头读。后台结果叫起的那一轮（它派的子 Agent 回来了）接着算引起它的那件事。
 * 一轮收尾时还有派出去的事没回来（`SessionSummary.background`），先不交：真正的结论在回来以后那一轮里，那时再交。
 * 那件事要是被人停掉、没再引起新的一轮，隔一阵看一眼（`LINGER_MS`），后台空了、会话也闲着就把这一轮的汇报交上，不叫醒——人停下的事不该叫起来处。
 * 只有新的一轮收场才接手这份汇报：会话「在跑」不一定是新开了一轮，收尾后的压缩、`/compact` 也占着它、却不再有收场，见了在跑就撒手的话，这一轮的汇报就再也交不出去。
 * 被人按停的那一轮不交——停下是人的决定，叫醒来处去处理半截结果是在和这个决定争。
 * 什么时候真叫醒由本体定：来处闲着、它开出的会话都不在跑，几份合成一次送达；连着叫醒太多次就留到人开口（见 `ReportBackOptions.wake`）。
 *
 * 汇报的结尾（`ReportFrame.tail`）送出那一刻才写：那时哪个会话在等用户（弹着审批或提问卡），要点名告诉来处只有用户能答。
 *
 * 只交本插件的工具开出来的（`spawnedFrom.toolCallId` 是来处里一次 `spawn_session` 或 `hand_off_to_session`），认过的记在内存里。
 * 「第一轮」也只记在内存里：应用退出时第一轮跟着停了，按被人停下算。
 */

import type { DeliveryInput, Message, ReportBackOptions, ReportFrame, SessionObservation, SessionSummary, TurnStop } from "@plume/contract";
import { REPORT_HEAD, REPORT_MAX, reportTail, reportText } from "./prompt.ts";
import { HAND_OFF, SPAWN_SESSION } from "./suggestion.ts";
import { excerpt, lastReply, lastSpeaker } from "./turns.ts";

export interface ReportDeps {
	get(sessionId: string): Promise<SessionSummary | undefined>;
	messages(sessionId: string): Promise<Message[]>;
	reportBack(sessionId: string, text: string, options: ReportBackOptions): boolean;
	warn(message: string): void;
}

type Origin = NonNullable<SessionSummary["spawnedFrom"]>;

/** 收尾时还有事没回来的会话，多久看一眼它的后台空了没有。只读一下摘要，便宜。 */
const LINGER_MS = 3000;

export class Reports {
	private readonly deps: ReportDeps;
	/** 认过的：这个会话是不是本插件的工具开出来的。 */
	private readonly ours = new Map<string, Promise<boolean>>();
	/** 刚开出来、第一轮还没结束的。 */
	private readonly firstTurn = new Set<string>();
	/** 收尾时还有事没回来的那一轮该不该叫醒，留给回来以后那一轮。 */
	private readonly carry = new Map<string, boolean>();
	/** 弹着审批或提问卡、在等用户的会话。 */
	private readonly waiting = new Set<string>();
	/** 来处 → 它开出的会话 → 怎么称呼（短名，没有时是标题）。 */
	private readonly family = new Map<string, Map<string, string>>();
	/** 收尾时有事没回来、在看它后台空没空的，见 `linger`。 */
	private readonly lingering = new Map<string, ReturnType<typeof setInterval>>();

	constructor(deps: ReportDeps) {
		this.deps = deps;
	}

	/** 本插件刚开出一个会话。 */
	launched(sessionId: string, origin: Origin, label: string): void {
		this.ours.set(sessionId, Promise.resolve(true));
		this.firstTurn.add(sessionId);
		this.remember(origin.sessionId, sessionId, origin.name ?? label);
	}

	/** 它的第一轮还在跑：这一轮是来处交代的，不是人说的。 */
	inFirstTurn(sessionId: string): boolean {
		return this.firstTurn.has(sessionId);
	}

	deleted(sessionId: string): void {
		this.stopLingering(sessionId);
		this.ours.delete(sessionId);
		this.firstTurn.delete(sessionId);
		this.carry.delete(sessionId);
		this.waiting.delete(sessionId);
		this.family.delete(sessionId);
		for (const children of this.family.values()) children.delete(sessionId);
	}

	observe(observation: SessionObservation): void {
		const event = observation.event;
		if (event.type === "approval") {
			if (event.approval) this.waiting.add(observation.sessionId);
			else this.waiting.delete(observation.sessionId);
		} else if (event.type === "turnEnd") {
			// 收尾时没回来的事叫起了新的一轮、这一轮收场了：交不交由它定，上一轮留下的 `carry` 跟着它算。
			this.stopLingering(observation.sessionId);
			// i18n-exempt：日志
			void this.turnEnded(observation.sessionId, event.stop).catch((error: unknown) =>
				this.deps.warn(`会话 ${observation.sessionId} 没交回去：${String(error)}`),
			);
		}
	}

	/** 这个会话是不是本插件的工具从来处开出来的。 */
	isOurs(sessionId: string, origin: Origin): Promise<boolean> {
		let known = this.ours.get(sessionId);
		if (!known) {
			known = this.deps.messages(origin.sessionId).then(
				(messages) =>
					messages.some(
						(message) =>
							message.role === "assistant" &&
							message.content.some(
								(part) => part.type === "toolCall" && part.id === origin.toolCallId && (part.name === SPAWN_SESSION || part.name === HAND_OFF),
							),
					),
				() => false,
			);
			this.ours.set(sessionId, known);
		}
		return known;
	}

	private remember(parentId: string, sessionId: string, label: string): void {
		let children = this.family.get(parentId);
		if (!children) this.family.set(parentId, (children = new Map()));
		children.set(sessionId, label);
	}

	private frame(parentId: string): ReportFrame {
		// i18n-exempt：发给模型的话。
		return {
			head: REPORT_HEAD,
			tail: () => reportTail([...(this.family.get(parentId) ?? [])].flatMap(([id, label]) => (this.waiting.has(id) ? [`${label}（${id}）`] : []))),
		};
	}

	private async turnEnded(sessionId: string, stop: TurnStop): Promise<void> {
		const first = this.firstTurn.delete(sessionId);
		const summary = await this.deps.get(sessionId);
		const origin = summary?.spawnedFrom;
		if (!summary || !origin?.toolCallId || !(await this.isOurs(sessionId, origin))) return;
		this.remember(origin.sessionId, sessionId, origin.name ?? summary.title);
		if (stop.reason === "aborted" || stop.reason === "interrupted") {
			this.carry.delete(sessionId);
			return;
		}
		const messages = await this.deps.messages(sessionId);
		const speaker = lastSpeaker(messages);
		const wake = first || (speaker.by === "peer" && speaker.from === origin.sessionId) || (speaker.by === "runtime" && this.carry.get(sessionId) === true);
		if (summary.background) {
			this.carry.set(sessionId, wake);
			this.linger(sessionId, origin, stop);
			return;
		}
		this.carry.delete(sessionId);
		this.deliver(sessionId, summary.title, origin, stop, messages, wake);
	}

	private deliver(sessionId: string, title: string, origin: Origin, stop: TurnStop, messages: readonly Message[], wake: boolean): void {
		const status = stop.reason === "done" ? "done" : "failed";
		const delivery: DeliveryInput = { id: `${sessionId}:${messages.length}`, title, status, ...(status === "failed" ? { incomplete: true } : {}) };
		const text = reportText({ sessionId, ...(origin.name ? { name: origin.name } : {}), title, status, reply: excerpt(lastReply(messages), REPORT_MAX) });
		try {
			this.deps.reportBack(sessionId, text, { delivery, frame: this.frame(origin.sessionId), wake: wake && status === "done" });
		} catch (error) {
			// 宿主不认这个来处了（来处撤回到了开它的那次调用之前）：以后不再当它是本插件开的，不每轮都交一次、记一条警告，提示词里也不再说来处。
			this.ours.set(sessionId, Promise.resolve(false));
			throw error;
		}
	}

	/** 等收尾时没回来的那件事：有新的一轮收场就交给它（`observe`），后台空了、会话闲着就把这一轮的汇报交上，不叫醒。 */
	private linger(sessionId: string, origin: Origin, stop: TurnStop): void {
		this.stopLingering(sessionId);
		const timer = setInterval(() => {
			void (async () => {
				const summary = await this.deps.get(sessionId);
				if (this.lingering.get(sessionId) !== timer) return;
				if (!summary) return this.stopLingering(sessionId);
				if (summary.running || summary.background) return;
				this.stopLingering(sessionId);
				if (!this.carry.delete(sessionId)) return;
				this.deliver(sessionId, summary.title, origin, stop, await this.deps.messages(sessionId), false);
			})().catch((error: unknown) => {
				this.stopLingering(sessionId);
				// i18n-exempt：日志
				this.deps.warn(`会话 ${sessionId} 没交回去：${String(error)}`);
			});
		}, LINGER_MS);
		timer.unref?.();
		this.lingering.set(sessionId, timer);
	}

	private stopLingering(sessionId: string): void {
		const timer = this.lingering.get(sessionId);
		if (timer === undefined) return;
		clearInterval(timer);
		this.lingering.delete(sessionId);
	}
}
