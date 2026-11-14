/**
 * 会话里登记着的后台任务（`ToolRun.track`）：调用答完以后还在跑的命令、监视。
 *
 * 起什么、怎么读输出、结束时怎么告诉模型是工具的事；本体只记账，好办三件只有它办得了的事：算会话闲没闲（`pending`），
 * 删会话、退出应用、登记它的插件停用、子会话派出去的那次运行结束时停掉（它们的进程组是分离的，agent 进程退出不会带走它们），
 * 列给界面（`ctx.sessions.jobs`）。
 *
 * 「没闲」只算顶层会话里送达渠道还有效、会自己结束的：人按停、撤回截掉了起它的那次调用，渠道作废，它再结束也叫不醒会话，就不算在等
 * （和 `BackgroundRuns` 里停掉、撤回的派发不算一样）。子会话没有送达渠道，它的任务不算。挂着的也不算：有输出就叫醒会话的监视
 * （`wakes`），起来以后被登记它的工具认出是长跑服务的（`TrackedJob.stand`）——它们没有「做完」的那一刻。
 */

import { randomUUID } from "node:crypto";
import type { BackgroundCallState, BackgroundJobInfo, BackgroundJobInput, BackgroundJobOutput, TrackedJob } from "@plume/contract";
import { text } from "./i18n.ts";

interface Job {
	sessionId: string;
	/** 登记它的插件：插件停用时跟着停。 */
	plugin: string;
	/** 起它的那次调用：转录里那一行跟着它画，见 `calls`。 */
	toolCallId: string;
	info: BackgroundJobInfo;
	input: BackgroundJobInput;
	/** 起它的那次调用的送达渠道作废时触发；没有就是不会把结果送回会话（子会话）。 */
	signal?: AbortSignal;
	/** 挂着的：不挡会话闲下来，见文件头。 */
	standing: boolean;
	/** 叫它停过（人在环境卡片、任务面板里停，删会话、子会话那次运行结束时本体停）：之后怎么退出都算停下的，不算失败。 */
	stopped?: true;
}

export class BackgroundJobs {
	private readonly jobs = new Map<string, Job>();

	/** `changed`：某个会话在等的后台任务变了（结束了、渠道作废了），`pending` 可能变了。 */
	constructor(
		private readonly changed: (sessionId: string) => void,
		private readonly log: (message: string) => void,
	) {}

	track(sessionId: string, plugin: string, toolCallId: string, input: BackgroundJobInput, signal: AbortSignal | undefined): TrackedJob {
		const { command, description, pid, wakes, output, stop } = input ?? ({} as Partial<BackgroundJobInput>);
		if (typeof command !== "string" || typeof output !== "function" || typeof stop !== "function") throw new Error(text("session.badJob"));
		const id = randomUUID();
		const job: Job = {
			sessionId,
			plugin,
			toolCallId,
			info: {
				id,
				command,
				...(typeof description === "string" && description ? { description } : {}),
				startedAt: Date.now(),
				exitCode: null,
				...(typeof pid === "number" ? { pid } : {}),
				status: "running",
				...(wakes === true ? { wakes: true as const } : {}),
			},
			input: { command, output, stop },
			...(signal ? { signal } : {}),
			standing: wakes === true,
		};
		this.jobs.set(id, job);
		signal?.addEventListener("abort", () => this.changed(sessionId), { once: true });
		this.changed(sessionId);
		return {
			id,
			done: (exitCode, error) => {
				const { info } = job;
				const first = info.finishedAt === undefined;
				info.finishedAt ??= Date.now();
				info.exitCode = typeof exitCode === "number" ? exitCode : null;
				if (typeof error === "string") info.error = error;
				info.status = info.error !== undefined || (info.exitCode !== null && info.exitCode !== 0) ? "failed" : "exited";
				if (first && this.jobs.get(id) === job) this.changed(sessionId);
			},
			stand: () => {
				if (job.standing) return;
				job.standing = true;
				if (job.info.finishedAt === undefined && this.jobs.get(id) === job) this.changed(sessionId);
			},
		};
	}

	/** 结束了的也在，按登记的先后。 */
	list(sessionId: string): BackgroundJobInfo[] {
		return [...this.jobs.values()].filter((job) => job.sessionId === sessionId).map((job) => ({ ...job.info }));
	}

	/**
	 * 起了任务的那几次调用此刻怎样，按调用 id（见 `BackgroundCallState`）：没结束的在跑，叫停过的是停下，出错结束的失败，
	 * 正常结束的是跑完。同一次调用起了几个时取最要紧的那个：在跑的盖过停下的、停下的盖过失败的、失败的盖过跑完的。
	 */
	calls(sessionId: string): Record<string, BackgroundCallState> {
		const rank: Record<BackgroundCallState, number> = { running: 4, stopped: 3, failed: 2, exited: 1 };
		const states: Record<string, BackgroundCallState> = {};
		for (const job of this.jobs.values()) {
			if (job.sessionId !== sessionId) continue;
			const state: BackgroundCallState =
				job.info.finishedAt === undefined ? "running" : job.stopped ? "stopped" : job.info.status === "failed" ? "failed" : "exited";
			const held = states[job.toolCallId];
			if (!held || rank[state] > rank[held]) states[job.toolCallId] = state;
		}
		return states;
	}

	/** 还有没结束、结果还会送回会话、不是挂着的：会话不算闲。 */
	pending(sessionId: string): boolean {
		for (const job of this.jobs.values())
			if (job.sessionId === sessionId && !job.standing && job.info.finishedAt === undefined && job.signal && !job.signal.aborted) return true;
		return false;
	}

	async output(sessionId: string, jobId: string): Promise<BackgroundJobOutput> {
		const job = this.find(sessionId, jobId);
		if (!job) throw new Error(text("session.jobNotFound"));
		return await job.input.output();
	}

	/** 叫它停下；没有、已经结束时返回 false。停不掉时抛错。 */
	stop(sessionId: string, jobId: string, force: boolean): boolean {
		const job = this.find(sessionId, jobId);
		if (!job || job.info.finishedAt !== undefined) return false;
		job.info.status = "stopping";
		job.stopped = true;
		try {
			job.input.stop(force === true);
		} catch (error) {
			job.info.status = "failed";
			job.info.error = error instanceof Error ? error.message : String(error);
			throw error;
		}
		return true;
	}

	/** 子会话派出去的那次运行结束了：停掉它还在跑的，记录留着。 */
	stopRunning(sessionId: string): void {
		this.stopAll((job) => job.sessionId === sessionId, false);
	}

	/** 会话删掉了：停掉、忘掉。 */
	forget(sessionId: string): void {
		this.stopAll((job) => job.sessionId === sessionId, true);
	}

	/** 登记它们的插件停用了：停掉、忘掉。 */
	forgetOwner(plugin: string): void {
		this.stopAll((job) => job.plugin === plugin, true);
	}

	/** 退出应用：全部停掉。 */
	clear(): void {
		this.stopAll(() => true, true);
	}

	private find(sessionId: string, jobId: string): Job | undefined {
		const job = this.jobs.get(String(jobId));
		return job?.sessionId === sessionId ? job : undefined;
	}

	/** 停不掉的多半是已经自己退出了：只记日志，删会话、关应用不该因为一个停不掉的进程失败。 */
	private stopAll(matches: (job: Job) => boolean, forget: boolean): void {
		const sessions = new Set<string>();
		for (const [id, job] of this.jobs) {
			if (!matches(job)) continue;
			if (forget) this.jobs.delete(id);
			sessions.add(job.sessionId);
			if (job.info.finishedAt !== undefined) continue;
			job.info.status = "stopping";
			job.stopped = true;
			try {
				job.input.stop(true);
			} catch (error) {
				this.log(`会话 ${job.sessionId} 的后台任务 ${id} 停不掉：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (forget) for (const sessionId of sessions) this.changed(sessionId);
	}
}
