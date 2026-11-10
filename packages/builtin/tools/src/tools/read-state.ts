import type { ToolContext } from "./types.ts";

export interface FileStamp {
	mtimeMs: number;
	size: number;
}

export interface ReadRecord {
	/** 读的时候的修改时间和大小。图片、抽出字的文档没有：它们不是能编辑的文本。 */
	stamp?: FileStamp;
	/**
	 * 上一次读看到的比要的少：折成了大纲，或者撞上了行数、字数上限。在一次指明窗口的读之前，文件里什么都不能改。
	 * 不记显示了哪几行，只记模型知不知道自己看到的是一部分。
	 */
	partial?: boolean;
}

function readState(ctx: ToolContext): Map<string, ReadRecord> {
	const existing = ctx.state.get("readFiles");
	if (existing instanceof Map) return existing;
	const fresh = new Map<string, ReadRecord>();
	ctx.state.set("readFiles", fresh);
	return fresh;
}

export function markRead(ctx: ToolContext, path: string, stamp?: FileStamp, partial = false): void {
	readState(ctx).set(path, { stamp: stamp && { mtimeMs: stamp.mtimeMs, size: stamp.size }, partial });
}

/**
 * 读过以后变没变：修改时间（按整毫秒）更晚，或者大小不同。不比内容的哈希——同一毫秒里改成同样大小的会漏过，
 * 只 touch 不改字的也要重读。
 */
export function changedSince(record: ReadRecord, current: FileStamp): boolean {
	return !record.stamp || Math.floor(current.mtimeMs) > Math.floor(record.stamp.mtimeMs) || current.size !== record.stamp.size;
}

export function readRecord(ctx: ToolContext, path: string): ReadRecord | undefined {
	return readState(ctx).get(path);
}
