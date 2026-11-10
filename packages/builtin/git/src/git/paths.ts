/**
 * 拿路径比较之前先换成平台自己的写法：git 在 Windows 上打印正斜杠、macOS 的临时目录有 `/private` 前缀。
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** 路径不在了就解析最近的上级再接回去：收走的工作树也拼得出和 git 一样的写法。 */
export function canonicalPath(input: string): string {
	const full = resolve(input);
	try {
		return realpathSync.native(full);
	} catch {
		const parent = dirname(full);
		return parent === full ? full : join(canonicalPath(parent), basename(full));
	}
}

/** 两个路径是不是同一个目录。Windows、macOS 的文件系统通常不分大小写。 */
export function samePath(a: string, b: string): boolean {
	const left = canonicalPath(a);
	const right = canonicalPath(b);
	return process.platform === "win32" || process.platform === "darwin" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
