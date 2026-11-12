import { open } from "node:fs/promises";
import type { BackgroundJobsService } from "@plume/contract";
import { backgroundJobs } from "./background-jobs.ts";

const TAIL_BYTES = 256 * 1024;

/** 界面读日志不经过 bash_output：不能消费模型的未读输出或取消完成送达。 */
export function createJobsService(states: ReadonlyMap<string, Map<string, unknown>>): BackgroundJobsService {
	const jobs = (sessionId: string) => {
		const state = states.get(sessionId);
		return state ? backgroundJobs(state) : undefined;
	};
	return {
		list(sessionId) {
			return (jobs(sessionId)?.list() ?? []).map(({ id, command, description, startedAt, finishedAt, exitCode, pid, status, error, kind }) => ({
				id,
				command,
				description,
				startedAt,
				finishedAt,
				exitCode,
				pid,
				status,
				error,
				...(kind === "monitor" ? { wakes: true as const } : {}),
			}));
		},
		async output(sessionId, jobId) {
			const job = jobs(sessionId)?.get(jobId);
			if (!job) throw new Error("Background job not found");
			const done = job.finishedAt !== undefined && (!job.outputPath || job.outputComplete !== undefined || job.outputError !== undefined);
			if (!job.outputPath) return { text: job.output, done, truncated: false, error: job.outputError };
			const file = await open(job.outputPath, "r");
			try {
				const { size } = await file.stat();
				const start = Math.max(0, size - TAIL_BYTES);
				const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
				const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
				let offset = 0;
				// 尾部从字节偏移开始，跳过被截开的 UTF-8 字符。
				if (start) while (offset < bytesRead && (buffer[offset]! & 0xc0) === 0x80) offset++;
				return { text: new TextDecoder().decode(buffer.subarray(offset, bytesRead), { stream: !done }), done, truncated: start > 0, error: job.outputError };
			} finally {
				await file.close();
			}
		},
		stop: (sessionId, jobId, force) => jobs(sessionId)?.stop(jobId, force) ?? false,
	};
}
