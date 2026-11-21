/**
 * 读过哪些文件，按会话存盘：插件数据目录下 `read-files/<会话 id>.json` 一个文件。
 *
 * 会话在 Plume 重启（重开应用、开发版重建）以后接着跑，模型上下文里读到的内容都还在；记录只在内存里的话，
 * 它改刚读过的文件也会被要求重读。存的只有路径、修改时间、大小和是否只看到一部分，重启后照样按修改时间和大小查过期，
 * 存盘不会放过读完以后被改过的文件。
 *
 * 写盘不等：工具不为它慢下来，一次没写完时只留最新的一份接着写。进程正写着就被杀掉，丢的是最后一两条记录，
 * 最坏是模型再读一遍。
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { restoreReads, type ReadRecord } from "./read-state.ts";

export interface ReadStore {
	/** 给会话的状态装上存盘的记录和写盘的入口；状态刚建出来时调一次。 */
	attach(state: Map<string, unknown>, sessionId: string): void;
	/** 会话删掉时删掉它的文件。 */
	forget(sessionId: string): Promise<void>;
}

export function readStore(dataDir: string, onError: (error: unknown) => void): ReadStore {
	const dir = join(dataDir, "read-files");
	// 会话 id 是本体给的，按文件名转一下，不让它拼出别的路径。
	const fileOf = (sessionId: string) => join(dir, `${encodeURIComponent(sessionId)}.json`);
	const writers = new Map<string, { latest: string | undefined; running: Promise<void> | undefined }>();

	const write = (sessionId: string, text: string) => {
		let writer = writers.get(sessionId);
		if (!writer) writers.set(sessionId, (writer = { latest: undefined, running: undefined }));
		writer.latest = text;
		if (writer.running) return;
		const current = writer;
		current.running = (async () => {
			while (current.latest !== undefined) {
				const next = current.latest;
				current.latest = undefined;
				const file = fileOf(sessionId);
				try {
					await mkdir(dir, { recursive: true });
					await writeFile(`${file}.tmp`, next, "utf8");
					await rename(`${file}.tmp`, file);
				} catch (error) {
					onError(error);
				}
			}
			current.running = undefined;
		})();
	};

	return {
		attach(state, sessionId) {
			const records = load(fileOf(sessionId));
			restoreReads(state, records, (changed) => write(sessionId, JSON.stringify([...changed])));
		},
		async forget(sessionId) {
			const writer = writers.get(sessionId);
			if (writer) writer.latest = undefined;
			await writer?.running;
			writers.delete(sessionId);
			await rm(fileOf(sessionId), { force: true });
		},
	};
}

/** 同步读：会话的状态在工具调用时同步建出来，文件只有几 KB，一个会话在一次进程里只读一次。读不出或格式不对的当作没读过。 */
function load(file: string): Map<string, ReadRecord> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return new Map();
	}
	const records = new Map<string, ReadRecord>();
	if (!Array.isArray(parsed)) return records;
	for (const entry of parsed) {
		if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "object" || entry[1] === null) continue;
		const { stamp, partial } = entry[1] as Record<string, unknown>;
		const valid =
			typeof stamp === "object" &&
			stamp !== null &&
			typeof (stamp as Record<string, unknown>).mtimeMs === "number" &&
			typeof (stamp as Record<string, unknown>).size === "number";
		// 没有 stamp 的（图片、文档）本来就不能改，不存它们也一样。
		if (!valid) continue;
		const { mtimeMs, size } = stamp as { mtimeMs: number; size: number };
		records.set(entry[0], { stamp: { mtimeMs, size }, partial: partial === true });
	}
	return records;
}
