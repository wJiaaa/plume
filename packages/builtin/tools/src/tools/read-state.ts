import type { FileStamp } from "@plume/contract";
import type { ToolContext } from "./types.ts";

export interface ReadRecord {
	/** 读的时候的修改时间和大小。图片、抽出字的文档没有：它们不是能编辑的文本。 */
	stamp?: FileStamp;
	/**
	 * 上一次读看到的比要的少：折成了大纲，或者撞上了行数、字数上限。在一次指明窗口的读之前，文件里什么都不能改。
	 * 不记显示了哪几行，只记模型知不知道自己看到的是一部分。
	 */
	partial?: boolean;
}

const RECORDS = "readFiles";
/** 记录变了以后调它存盘（`read-store.ts` 装上的）；直接调工具的测试没装，只记在内存里。 */
const SAVE = "readFilesSave";

function readState(ctx: ToolContext): Map<string, ReadRecord> {
	const existing = ctx.state.get(RECORDS);
	if (existing instanceof Map) return existing;
	const fresh = new Map<string, ReadRecord>();
	ctx.state.set(RECORDS, fresh);
	return fresh;
}

/** 把存盘的记录装回会话的状态里，之后每次记下都交给 `save`。 */
export function restoreReads(state: Map<string, unknown>, records: Map<string, ReadRecord>, save: (records: Map<string, ReadRecord>) => void): void {
	state.set(RECORDS, records);
	state.set(SAVE, save);
}

export function markRead(ctx: ToolContext, path: string, stamp?: FileStamp, partial = false): void {
	const records = readState(ctx);
	records.set(path, { stamp: stamp && { mtimeMs: stamp.mtimeMs, size: stamp.size }, partial });
	const save = ctx.state.get(SAVE);
	if (typeof save === "function") save(records);
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
