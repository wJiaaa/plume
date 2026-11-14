/**
 * 开出来的会话每结束一轮，把它最后那段回复的前 400 字交回开出它的会话（`SessionAccess.reportBack`）。
 *
 * 叫不叫醒来处（`wake`），看这一轮是谁引起的：开出来的第一轮、来处寄来的信引起的那一轮叫醒；人在它里面说话引起的、被停下的、
 * 出错的不叫醒，汇报留到来处下一轮开头读。后台结果叫起的那一轮（它派的子 Agent 回来了）接着算引起它的那件事。
 * 一轮收尾时还有派出去的事没回来（`SessionSummary.background`），先不交：真正的结论在回来以后那一轮里，那时再交。
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
			return;
		}
		this.carry.delete(sessionId);
		const status = stop.reason === "done" ? "done" : "failed";
		const title = summary.title;
		const delivery: DeliveryInput = { id: `${sessionId}:${messages.length}`, title, status, ...(status === "failed" ? { incomplete: true } : {}) };
		const text = reportText({ sessionId, ...(origin.name ? { name: origin.name } : {}), title, status, reply: excerpt(lastReply(messages), REPORT_MAX) });
		this.deps.reportBack(sessionId, text, { delivery, frame: this.frame(origin.sessionId), wake: wake && status === "done" });
	}
}
