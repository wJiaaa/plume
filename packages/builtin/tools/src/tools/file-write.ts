import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { lstat, mkdir, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { words } from "../messages.ts";
import { beginMutation } from "./change-lock.ts";
import { fileIdentity, recordFileChange, sameIdentity, type FileIdentity } from "./file-changes.ts";
import { resolveFilePath } from "./paths.ts";
import type { FileStamp } from "./read-state.ts";
import type { ToolContext } from "./types.ts";

const writes = new Map<string, Promise<unknown>>();
interface TextFile {
	path: string;
	before: string | null;
	/** `before` 的修改时间和大小；文件还不存在时是 null。 */
	stamp: FileStamp | null;
	/** 写完那一刻文件的修改时间和大小。 */
	write(content: string): Promise<{ stamp: FileStamp; changeId: string | undefined }>;
}

/** 读、审批、写都在同一个按文件排的队里，edit 和 write 共用。 */
export async function withTextFile<T>(ctx: ToolContext, input: string, action: (file: TextFile) => Promise<T>): Promise<T> {
	const release = beginMutation();
	try {
		return await queuedTextFile(ctx, input, action);
	} finally {
		release();
	}
}

async function queuedTextFile<T>(ctx: ToolContext, input: string, action: (file: TextFile) => Promise<T>): Promise<T> {
	const path = await resolveFilePath(ctx.cwd, input);
	const initial = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	// 路径管新建；inode 让经不同硬链接的编辑也排进同一个队。
	const keys = [path, ...(initial ? [`${initial.dev}:${initial.ino}`] : [])];
	const previous = keys.map((key) => writes.get(key)?.catch(() => {}));
	const run = Promise.all(previous).then(async () => {
		ctx.signal?.throwIfAborted();
		let handle: FileHandle | undefined;
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
					ctx.signal?.throwIfAborted();
					// 审批之后、第一个破坏性操作之前再核对一遍。
					if ((await resolveFilePath(ctx.cwd, input)) !== path) throw changed();
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
					ctx.signal?.throwIfAborted();
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
					const changeId = await recordFileChange(ctx, path, before, content, "tool", beforeStat, fileIdentity(written)).catch((cause) => {
						throw new Error(words().changeSaveFailed, { cause });
					});
					return { changeId, stamp: { mtimeMs: written.mtimeMs, size: written.size } };
				},
			});
		} finally {
			await handle?.close();
		}
	});
	for (const key of keys) writes.set(key, run);
	try {
		return await run;
	} finally {
		for (const key of keys) if (writes.get(key) === run) writes.delete(key);
	}
}
