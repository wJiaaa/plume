/**
 * 一次截屏的流水账：从开始到最后一次窗口操作。
 *
 * 截屏的问题几乎都是别人机器上的时序和实际取值：走了哪条分支、屏幕实际多大、快照回来多大、窗口相对激活什么时候亮出来。
 * 这些从源码推不出来（同一段代码按当时谁在前台走不同的路），录屏也只录得到现象、录不到原因。
 *
 * 写在 Plume 目录下的 `screenshot-debug.log`，追加，一件事一行，带相对这次截屏开始的毫秒数。一直开着也便宜：
 * 一次截屏二三十行、约 2KB，文件过了 `LOG_LIMIT` 就从头写。
 */

import { statSync, truncateSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { plumeHome } from "../home.ts";

/** 大约一百次截屏：够盖住要问的那一次，又不会一直长。 */
const LOG_LIMIT = 256 * 1024;

let started = 0;
let session = 0;
/**
 * 每行一个序号。写盘不等（等盘的日志会改掉它要量的时序），行可能乱序落下；序号才是事情实际发生的顺序。
 */
let seq = 0;

function debugLogPath(): string {
	return join(plumeHome(), "screenshot-debug.log");
}

export function beginCaptureLog(): void {
	// 同步做，在这一次的第一行之前：之后的写都不等、先后不定，异步截断可能抹掉已经写下的行。stat 只要几微秒。
	try {
		if (statSync(debugLogPath()).size > LOG_LIMIT) truncateSync(debugLogPath());
	} catch {
		// 还没有文件。
	}
	started = Date.now();
	session += 1;
	seq = 0;
	void write(`\n===== capture #${session} @ ${new Date().toISOString()} =====`);
}

/** 这次截屏的一件事。不等写盘，理由同 `seq`。 */
export function captureLog(event: string, detail?: Record<string, unknown>): void {
	const ms = started ? Date.now() - started : 0;
	const body = detail ? ` ${JSON.stringify(detail)}` : "";
	seq += 1;
	void write(`#${String(seq).padStart(2, "0")} [+${String(ms).padStart(5, " ")}ms] ${event}${body}`);
}

async function write(line: string): Promise<void> {
	try {
		await appendFile(debugLogPath(), `${line}\n`, "utf8");
	} catch {
		// 流水账写不下不能让截屏失败。
	}
}
