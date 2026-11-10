/**
 * 整份替换一个文件：读的人看到的要么是旧的、要么是新的，不会是两者掺在一起。
 *
 * 先写一个旁边的临时文件，再改名盖过去。两处都要当心：
 *
 * - 临时文件的名字每次写都要不同，不能每个进程一个：同一个进程里两次写（两次连着的保存）共用 `${path}.tmp` 时，先改名的
 *   把文件从后一个底下拿走，后一个要么 ENOENT，要么把另一份的字节放了上去。
 * - Windows 上改名盖过一个别人开着的文件会得到 EPERM、EBUSY 或 EACCES，而杀毒软件和搜索索引会打开每个刚写出来的文件。
 *   那是一瞬间而不是一种状态，所以先等它过去，再报错。
 */

import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export async function writeFileAtomic(path: string, data: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
	const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		// 权限在建临时文件时就给上，写完到改名之间也不会被别人读到。
		await writeFile(tmp, data, options.mode === undefined ? {} : { mode: options.mode });
		await renameWithRetry(tmp, path);
	} catch (error) {
		// 名字各不相同，失败留下的不会被下一次覆盖，会越堆越多。
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

/** Windows 上别的进程开着目标（或目录里的文件）时，改名得到的回答。 */
const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * `rename`，Windows 上等别的进程放开目标。
 *
 * 只在 Windows 上等：macOS、Linux 上同样的错误码说的是权限，等也不会变，重试只会把报错拖后。一共试 8 次，每次多等 20ms，
 * 合计半秒多，够扫描器放开一个小文件。
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (attempt >= 8 || process.platform !== "win32" || !HELD_OPEN.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
			await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
		}
	}
}
