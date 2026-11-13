/**
 * 替模型改一个文本文件（`ToolRun.files.change` 背后的那一步）：写边界、按文件排队、拿当前内容、写、记快照、撤销门闩一次做完。
 *
 * 读、审批、写都在同一个按文件排的队里：同一个文件的两次改动不会都拿着旧内容各写各的。审批之后、第一个破坏性操作之前再核对一遍，
 * 等审批时文件被人改了、换成了链接，就不写。写保留 inode（硬链接和权限都在），新建是独占创建，不覆盖等审批时冒出来的文件。
 */

import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { lstat, mkdir, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileStamp } from "@plume/contract";
import type { ChangeLock } from "./change-lock.ts";
import { fileIdentity, sameIdentity, type ChangeStore, type FileIdentity } from "./change-store.ts";
import type { ChangeWords } from "./change-words.ts";
import { resolveWriteTarget, type WriteScope } from "./paths.ts";

/** 一次改动在哪个会话、哪里：写边界按 `WriteScope` 判，快照记在 `sessionId` 名下。 */
export interface ChangeScope extends WriteScope {
	sessionId: string;
	signal?: AbortSignal;
}

export interface TextFile {
	/** 真正要写的那个文件（已有的父目录取了真实路径）。 */
	path: string;
	/** 现在的内容；文件还不存在时是 null。 */
	before: string | null;
	/** `before` 的修改时间和大小；文件还不存在时是 null。 */
	stamp: FileStamp | null;
	/** 写进去，交回写完那一刻的修改时间和大小，和这次改动的快照标识（前后一样时没有）。 */
	write(content: string): Promise<{ stamp: FileStamp; changeId: string | undefined }>;
}

export class TextFiles {
	private readonly writes = new Map<string, Promise<unknown>>();

	constructor(
		private readonly store: ChangeStore,
		private readonly lock: ChangeLock,
		private readonly words: () => ChangeWords,
	) {}

	/** 在这个文件的队里做 `action`；撤销进行中抛错。 */
	async change<T>(scope: ChangeScope, input: string, action: (file: TextFile) => Promise<T>): Promise<T> {
		const release = this.lock.beginMutation();
		try {
			return await this.queued(scope, input, action);
		} finally {
			release();
		}
	}

	private async queued<T>(scope: ChangeScope, input: string, action: (file: TextFile) => Promise<T>): Promise<T> {
		const path = await resolveWriteTarget(scope, input);
		const initial = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		// 路径管新建；inode 让经不同硬链接的编辑也排进同一个队。
		const keys = [path, ...(initial ? [`${initial.dev}:${initial.ino}`] : [])];
		const previous = keys.map((key) => this.writes.get(key)?.catch(() => {}));
		const run = Promise.all(previous).then(async () => {
			scope.signal?.throwIfAborted();
			let handle: FileHandle | undefined;
			// i18n-exempt：下面这些都是交给模型的话。
			const changed = () => new Error("The file changed before writing. Read it again before editing.");
			try {
				let before: string | null = null;
				let stamp: FileStamp | null = null;
				let beforeStat: FileIdentity | null = null;
				if (initial) {
					if (!initial.isFile()) throw new Error("Only regular UTF-8 text files can be edited.");
					handle = await open(path, constants.O_RDWR | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
					const current = await handle.stat();
					if (current.dev !== initial.dev || current.ino !== initial.ino) throw changed();
					const bytes = await handle.readFile();
					if (!isUtf8(bytes) || bytes.includes(0)) throw new Error("Only UTF-8 text files can be edited; this file contains binary data.");
					before = bytes.toString("utf8");
					stamp = { mtimeMs: current.mtimeMs, size: current.size };
					beforeStat = fileIdentity(current);
				}
				return await action({
					path,
					before,
					stamp,
					write: async (content) => {
						scope.signal?.throwIfAborted();
						// 审批之后、第一个破坏性操作之前再核对一遍。
						if ((await resolveWriteTarget(scope, input)) !== path) throw changed();
						if (handle) {
							const current = await lstat(path),
								opened = await handle.stat();
							if (
								current.isSymbolicLink() ||
								current.dev !== opened.dev ||
								current.ino !== opened.ino ||
								!sameIdentity(fileIdentity(opened), beforeStat) ||
								(await readFile(path, "utf8")) !== before
							)
								throw changed();
						} else {
							await mkdir(dirname(path), { recursive: true });
							if ((await realpath(dirname(path))) !== dirname(path)) throw changed();
							// 独占创建：等审批时冒出来的文件不会被覆盖。
							handle = await open(path, "wx");
						}
						scope.signal?.throwIfAborted();
						const bytes = Buffer.from(content, "utf8");
						try {
							// 保留 inode（硬链接和权限都在），写不全的情况自己处理。
							await handle.truncate(0);
							let offset = 0;
							while (offset < bytes.length) {
								const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
								if (!bytesWritten) throw new Error("No bytes were written.");
								offset += bytesWritten;
							}
						} catch (error) {
							throw new Error("The write failed after it started; the file may be incomplete. Read it again before retrying.", { cause: error });
						}
						const visible = await lstat(path),
							written = await handle.stat();
						if (visible.isSymbolicLink() || visible.dev !== written.dev || visible.ino !== written.ino) {
							throw new Error("The file path changed during writing; the visible result is unknown. Read it again.");
						}
						if ((await readFile(path, "utf8")) !== content) throw changed();
						const changeId = await this.store.record(scope.sessionId, path, before, content, "tool", beforeStat, fileIdentity(written)).catch((cause) => {
							throw new Error(this.words().changeSaveFailed, { cause });
						});
						return { changeId, stamp: { mtimeMs: written.mtimeMs, size: written.size } };
					},
				});
			} finally {
				await handle?.close();
			}
		});
		for (const key of keys) this.writes.set(key, run);
		try {
			return await run;
		} finally {
			for (const key of keys) if (this.writes.get(key) === run) this.writes.delete(key);
		}
	}
}
