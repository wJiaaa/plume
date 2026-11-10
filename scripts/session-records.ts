/**
 * 会话审计、导出脚本共用的读库：库在哪、只读打开、取出每个会话的摘要、消息和压缩记录。
 *
 * 只读打开：应用可能正开着，审计不能成为写库的那一方。所以不用生产的 `openSessionDb`：它打开时会建表，还会把上次进程留下的
 * 流式草稿当成回复写进会话。
 *
 * 数据目录和应用一样认 `PLUME_HOME`：测试在临时目录里搭一份会话库再跑脚本，否则一启动就去读这台机器上的真实会话。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ContextRecord } from "../packages/core/agent/src/compaction.ts";
import type { Message, SessionSummary } from "../packages/contract/src/index.ts";

export function plumeHome(): string {
	return process.env.PLUME_HOME || join(homedir(), ".plume");
}

/** 只读打开会话库；还没有会话库时说一句就退出。 */
export function openSessionsReadOnly(): { db: DatabaseSync; path: string } {
	const path = join(plumeHome(), "sessions", "sessions.db");
	if (!existsSync(path)) {
		console.error(`读不到 ${path} —— 这台机器上还没有会话记录。`);
		process.exit(1);
	}
	return { db: new DatabaseSync(path, { readOnly: true }), path };
}

export interface StoredSession {
	summary: SessionSummary;
	messages: Message[];
	/** 压缩和剪过的结果；没压过、没剪过时没有。 */
	record?: ContextRecord;
}

/** 全部会话，按建立的先后。 */
export function storedSessions(db: DatabaseSync): StoredSession[] {
	const records = db.prepare("SELECT body FROM records WHERE session_id = ? ORDER BY seq");
	const rows = db.prepare("SELECT id, summary, context FROM sessions").all() as { id: string; summary: string; context: string | null }[];
	return rows
		.map((row) => ({
			summary: JSON.parse(row.summary) as SessionSummary,
			messages: (records.all(row.id) as { body: string }[]).map((record) => JSON.parse(record.body) as Message),
			...(row.context ? { record: JSON.parse(row.context) as ContextRecord } : {}),
		}))
		.sort((a, b) => a.summary.createdAt - b.summary.createdAt);
}
