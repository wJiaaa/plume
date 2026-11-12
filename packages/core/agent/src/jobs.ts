/**
 * 会话里登记着的后台任务（`ToolRun.track`）：调用答完以后还在跑的命令、监视。
 *
 * 起什么、怎么读输出、结束时怎么告诉模型是工具的事；本体只记账，好办三件只有它办得了的事：算会话闲没闲（`pending`），
 * 删会话、退出应用、登记它的插件停用、子会话派出去的那次运行结束时停掉（它们的进程组是分离的，agent 进程退出不会带走它们），
 * 列给界面（`ctx.sessions.jobs`）。
 *
 * 「没闲」只算顶层会话里送达渠道还有效的：人按停、撤回截掉了起它的那次调用，渠道作废，它再结束也叫不醒会话，就不算在等
 * （和 `BackgroundRuns` 里停掉、撤回的派发不算一样）。子会话没有送达渠道，它的任务不算。
 */

import { randomUUID } from "node:crypto";
import type { BackgroundJobInfo, BackgroundJobInput, BackgroundJobOutput, TrackedJob } from "@plume/contract";
import { text } from "./i18n.ts";

interface Job {
	sessionId: string;
	/** 登记它的插件：插件停用时跟着停。 */
	plugin: string;
	info: BackgroundJobInfo;
	input: BackgroundJobInput;
	/** 起它的那次调用的送达渠道作废时触发；没有就是不会把结果送回会话（子会话）。 */
	signal?: AbortSignal;
}

export class BackgroundJobs {
	private readonly jobs = new Map<string, Job>();

	/** `changed`：某个会话在等的后台任务变了（结束了、渠道作废了），`pending` 可能变了。 */
	constructor(
		private readonly changed: (sessionId: string) => void,
		private readonly log: (message: string) => void,
	) {}

	track(sessionId: string, plugin: string, input: BackgroundJobInput, signal: AbortSignal | undefined): TrackedJob {
		const { command, description, pid, wakes, output, stop } = input ?? ({} as Partial<BackgroundJobInput>);
		if (typeof command !== "string" || typeof output !== "function" || typeof stop !== "function") throw new Error(text("session.badJob"));
		const id = randomUUID();
		const job: Job = {
			sessionId,
			plugin,
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
		};
	}

	/** 结束了的也在，按登记的先后。 */
	list(sessionId: string): BackgroundJobInfo[] {
		return [...this.jobs.values()].filter((job) => job.sessionId === sessionId).map((job) => ({ ...job.info }));
	}

	/** 还有没结束、结果还会送回会话的：会话不算闲。 */
	pending(sessionId: string): boolean {
		for (const job of this.jobs.values())
			if (job.sessionId === sessionId && job.info.finishedAt === undefined && job.signal && !job.signal.aborted) return true;
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
			try {
				job.input.stop(true);
			} catch (error) {
				this.log(`会话 ${job.sessionId} 的后台任务 ${id} 停不掉：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (forget) for (const sessionId of sessions) this.changed(sessionId);
	}
}
