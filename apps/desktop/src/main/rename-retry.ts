/**
 * Windows 上的改名，等一等正开着它的别的进程。
 *
 * Windows 上改名改到一个别的进程开着的文件（或目录里有开着的文件）会被拒，报 EPERM、EBUSY 或 EACCES；杀毒软件和
 * 搜索索引会去打开每个刚写完的文件。那是一会儿的事，不是一种状态，所以先等过去再报错。只在 Windows 上等：macOS、
 * Linux 上同样的错误码说的是权限，等多久都不会变，重试只会把报错推迟。
 *
 * 不引用 electron，测试才能直接加载它。
 */

import { rename } from "node:fs/promises";

export interface RenameRetry {
	/** 一共试几次，第一次也算。 */
	attempts?: number;
	/** 第一次被拒后等多久；之后每次多等这么久。 */
	stepMs?: number;
	/** 按哪个平台的规矩判断，缺省是本机。 */
	platform?: string;
	/** 真正去改名的那一步，测试里可以换掉。 */
	rename?: (from: string, to: string) => Promise<void>;
}

/** Windows 上别的进程开着这个文件（或目录里的文件）时改名报的错。 */
const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES"]);

/** 缺省大约半秒，够扫描器放开一个小文件；挪大目录的调用方给更长的。 */
export async function renameWithRetry(from: string, to: string, retry: RenameRetry = {}): Promise<void> {
	const attempts = retry.attempts ?? 8;
	const step = retry.stepMs ?? 20;
	const platform = retry.platform ?? process.platform;
	const move = retry.rename ?? rename;
	for (let attempt = 1; ; attempt++) {
		try {
			await move(from, to);
			return;
		} catch (error) {
			if (attempt >= attempts || !heldOpen(error, platform)) throw error;
			await new Promise((resolve) => setTimeout(resolve, step * attempt));
		}
	}
}

/** 这个错误是不是 Windows 上「有文件正被占用」。 */
export function heldOpen(error: unknown, platform: string = process.platform): boolean {
	return platform === "win32" && HELD_OPEN.has((error as { code?: string } | null)?.code ?? "");
}
