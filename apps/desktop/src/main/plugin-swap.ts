/**
 * 换上、拿掉插件目录：要么全换好，要么什么都没动。
 *
 * 原来是先 `rm -r` 旧目录、再把新目录改名过去。Windows 上还开着的文件（插件起的 `.exe`、编辑器打开着的文件；
 * agent 进程加载的 `.node` 是复制到 native-cache 里的那份，见 native-cache.ts）删不掉，`rm -r` 会把它周围的文件删光、最后卡在它上面：更新留下删了一半的旧版本，新的那份
 * 跟着暂存目录被扔掉；卸载留下一个既没装好、也删不掉的插件。
 *
 * 目录里有开着的文件时，改名是整个被拒、什么都不动的。所以先把旧目录挪开，再把新目录挪进来，最后才删挪开的那份
 * （`discard`）。哪一步失败就把挪过的全挪回去，装着的那份原样不变，错误交给调用方说明。
 *
 * 不引用 electron，测试才能直接加载它。
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { type RenameRetry, renameWithRetry } from "./rename-retry.ts";

/** 把 `from` 放到 `to`；`from` 是 null 时只拿掉 `to`。 */
export interface Move {
	from: string | null;
	to: string;
}

/** 挪目录：杀毒软件、索引还在读刚写进去的文件时会被拒一会儿。每个目录最多等一秒半左右。 */
const MOVE_RETRY: RenameRetry = { attempts: 8, stepMs: 50 };

/** 挪开的目录放多久以后，下一次换的时候可以删：比这新的可能还有一次换没做完、要挪回去。 */
const SWEEP_AFTER_MS = 10 * 60_000;

/**
 * 把每个 `from` 放到它的 `to`，拿走原来在那里的——全做或者全不做。
 *
 * @param retiredRoot 挪开的旧目录放在这里，要和 `to` 在同一个文件系统上（挪过去才是改名），且不在插件目录里
 *   （不能被当成插件加载）。
 * @returns 挪开的旧目录，交给 `discard` 删。
 */
export async function swapIn(moves: Move[], retiredRoot: string, retry: RenameRetry = MOVE_RETRY): Promise<string[]> {
	await sweepRetired(retiredRoot);
	const retired: { to: string; aside: string }[] = [];
	const placed: { from: string; to: string }[] = [];
	try {
		for (const { to } of moves) {
			if (!(await lstat(to).catch(() => null))) continue;
			await mkdir(retiredRoot, { recursive: true });
			// 名字带上时间，清理时分得出是早先剩下的，还是一次换正握着的。
			const aside = join(retiredRoot, `${Date.now()}-${randomUUID().slice(0, 8)}-${basename(to)}`);
			await renameWithRetry(to, aside, retry);
			retired.push({ to, aside });
		}
		for (const { from, to } of moves) {
			if (from === null) continue;
			await renameWithRetry(from, to, retry);
			placed.push({ from, to });
		}
	} catch (cause) {
		for (const { from, to } of placed.reverse()) await rename(to, from).catch(() => {});
		for (const { to, aside } of retired.reverse()) await rename(aside, to).catch(() => {});
		throw cause;
	}
	return retired.map(({ aside }) => aside);
}

/**
 * 删 `swapIn` 挪开的目录。尽力而为：换已经换好了，还有文件开着的留给下一次的 `sweepRetired`，
 * 不把做完的安装变成失败。
 */
export async function discard(retired: string[], retiredRoot: string): Promise<void> {
	for (const dir of retired) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
	if (retired.length > 0) await rmdir(retiredRoot).catch(() => {});
}

/** 删掉以前没删成、而且已经不可能再被挪回去的旧目录。 */
async function sweepRetired(retiredRoot: string): Promise<void> {
	for (const name of await readdir(retiredRoot).catch((): string[] => [])) {
		const at = Number(name.split("-")[0]);
		if (!Number.isFinite(at) || Date.now() - at < SWEEP_AFTER_MS) continue;
		await rm(join(retiredRoot, name), { recursive: true, force: true }).catch(() => {});
	}
}
