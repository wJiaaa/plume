/**
 * 一个会话的后台任务：`run_in_background` 起的、超过默认等待还在跑而转到后台的、命令退出后留下来拿着输出的，和 `monitor` 起的。
 *
 * 任务表放在会话的工具状态里，给 bash_output 读、停用（输出读到哪了、结束要不要告诉模型）。每一个也登记进本体（`ToolRun.track`，
 * 见 `bash.ts`）：会话闲没闲、删会话和关应用时连进程组一起停掉、界面列出它们，都是本体按登记做的，停的时候调回这里的 `stop`。
 * 只认这个会话自己起的进程句柄：停任务用的是 id，不是 pid，pid 会被系统复用。
 *
 * 起任务的那次调用拿到的送达渠道（`ToolRun.background`）跟着任务走：任务自己结束时经它告诉模型。人按停以后渠道作废，
 * 停下以前起的普通任务照跑、只是不再叫醒会话；`monitor` 只为叫醒会话而存在，跟着停掉。
 */

import type { BackgroundChannel, SandboxProcess } from "@plume/contract";

export interface BackgroundJob {
	id: string;
	command: string;
	/** 模型说的这条命令是干什么的：人读的是它，不是命令行。 */
	description?: string;
	startedAt: number;
	exitCode: number | null;
	finishedAt?: number;
	output: string;
	/** 完整输出的日志（见 `output-log.ts`）；没有临时目录时没有。 */
	outputPath?: string;
	outputComplete?: boolean;
	outputError?: string;
	pid?: number;
	status: "running" | "stopping" | "exited" | "failed";
	error?: string;
	/** `monitor` 起的：输出一来就分批送给模型，不是结束时送一次。 */
	kind?: "monitor";
}

interface OwnedJob {
	info: BackgroundJob;
	process: SandboxProcess;
	channel?: BackgroundChannel;
}

const KEY = "backgroundJobs";

export class BackgroundJobs {
	private readonly entries = new Map<string, OwnedJob>();
	/**
	 * 结束了也不该告诉模型的：有人停了它、模型已经读到了它怎么结束的。再告诉一遍，要么是重复它知道的，要么是叫醒一个
	 * 人刚停下的会话。
	 */
	private readonly quiet = new Set<string>();
	/** 其中经 `stop` 停掉的。`monitor` 攒着的那批只为这个丢：模型只是读到了结束的，还有没人看过的行。 */
	private readonly stopped = new Set<string>();

	/** `channel` 是起它的那次调用的送达渠道；没有（子会话、直接调工具的测试）就只能让模型自己读。 */
	add(info: BackgroundJob, process: SandboxProcess, channel?: BackgroundChannel): void {
		this.entries.set(info.id, { info, process, ...(channel ? { channel } : {}) });
		// 人按了停：monitor 跟着停，见文件头。
		if (info.kind === "monitor")
			channel?.signal.addEventListener(
				"abort",
				() => {
					try {
						this.stop(info.id);
					} catch {
						// 停不掉的记在任务上了；停止按钮不该因为它失败。
					}
				},
				{ once: true },
			);
	}

	/** 这个任务结束或有新输出时送给模型的渠道；没有或已作废时是 `undefined`。 */
	channel(id: string): BackgroundChannel | undefined {
		const channel = this.entries.get(id)?.channel;
		return channel && !channel.signal.aborted ? channel : undefined;
	}

	/** 任务的进程：读它输出的调用经 `ToolRun.files.includeChanges` 把它改了什么算进结果。 */
	process(id: string): SandboxProcess | undefined {
		return this.entries.get(id)?.process;
	}

	get(id: string): BackgroundJob | undefined {
		return this.entries.get(id)?.info;
	}

	list(): BackgroundJob[] {
		return [...this.entries.values()].map(({ info }) => ({ ...info }));
	}

	/** 模型读到了这个任务的结束状态，它的结束不再是新闻。 */
	observed(id: string): void {
		if (this.entries.get(id)?.info.finishedAt !== undefined) this.quiet.add(id);
	}

	/** 要送出时再问一次：攒着的那一会儿里可能有人停了它，或者模型自己读过了。 */
	isQuiet(id: string): boolean {
		return this.quiet.has(id);
	}

	wasStopped(id: string): boolean {
		return this.stopped.has(id);
	}

	stop(id: string, force = false): boolean {
		const job = this.entries.get(id);
		if (!job || job.info.finishedAt !== undefined || job.info.status === "exited") return false;
		this.quiet.add(id);
		this.stopped.add(id);
		job.info.status = "stopping";
		try {
			job.process.kill(force ? "SIGKILL" : "SIGTERM");
		} catch (error) {
			job.info.status = "failed";
			job.info.error = String(error);
			throw error;
		}
		return true;
	}
}

export function backgroundJobs(state: Map<string, unknown>): BackgroundJobs {
	const current = state.get(KEY);
	if (current instanceof BackgroundJobs) return current;
	const registry = new BackgroundJobs();
	state.set(KEY, registry);
	return registry;
}
