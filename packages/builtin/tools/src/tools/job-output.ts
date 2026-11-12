import { open } from "node:fs/promises";
import type { BackgroundJobOutput } from "@plume/contract";
import type { BackgroundJob } from "./background-jobs.ts";

const TAIL_BYTES = 256 * 1024;

/**
 * 一个后台任务给人看的尾部输出（本体经 `BackgroundJobInput.output` 要，任务面板、环境卡片找端口用）。
 * 界面读日志不经过 bash_output：不能消费模型的未读输出或取消完成送达。
 */
export async function readJobOutput(job: BackgroundJob): Promise<BackgroundJobOutput> {
	const done = job.finishedAt !== undefined && (!job.outputPath || job.outputComplete !== undefined || job.outputError !== undefined);
	if (!job.outputPath) return { text: job.output, done, truncated: false, ...(job.outputError ? { error: job.outputError } : {}) };
	const file = await open(job.outputPath, "r");
	try {
		const { size } = await file.stat();
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
		let offset = 0;
		// 尾部从字节偏移开始，跳过被截开的 UTF-8 字符。
		if (start) while (offset < bytesRead && (buffer[offset]! & 0xc0) === 0x80) offset++;
		return {
			text: new TextDecoder().decode(buffer.subarray(offset, bytesRead), { stream: !done }),
			done,
			truncated: start > 0,
			...(job.outputError ? { error: job.outputError } : {}),
		};
	} finally {
		await file.close();
	}
}
