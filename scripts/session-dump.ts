/**
 * 把会话库里一条会话的记录原样倒出来：一条消息一行 JSON。
 *
 * 会话存在 SQLite 里，`cat`、`grep`、`jq` 这些顺手的工具够不着它。排查一条会话、或者把它交给别人看的时候，用这个脚本取出来。
 * 只读打开，应用开着也可以跑。数据目录认 `PLUME_HOME`，缺省是 `~/.plume`。
 *
 * 用法：
 *   pnpm dump:session                 列出所有会话（id、最后活动时间、消息数、标题）
 *   pnpm dump:session <id 或其前缀>    打印这条会话的全部消息
 *   pnpm dump:session <id> > s.jsonl
 */

import type { SessionSummary } from "../packages/contract/src/index.ts";
import { openSessionsReadOnly } from "./session-records.ts";

const { db } = openSessionsReadOnly();
const wanted = process.argv[2];

if (!wanted) {
	const rows = db
		.prepare("SELECT s.id, s.updated_at, s.summary, (SELECT COUNT(*) FROM records r WHERE r.session_id = s.id) AS n FROM sessions s ORDER BY s.updated_at DESC")
		.all() as { id: string; updated_at: number; summary: string; n: number }[];
	for (const row of rows) {
		const { title } = JSON.parse(row.summary) as SessionSummary;
		console.log(`${row.id}  ${new Date(row.updated_at).toISOString()}  ${String(row.n).padStart(5)}  ${title}`);
	}
} else {
	const ids = (db.prepare("SELECT id FROM sessions WHERE id LIKE ? || '%'").all(wanted) as { id: string }[]).map((row) => row.id);
	if (ids.length !== 1) {
		console.error(ids.length === 0 ? `没有以 ${wanted} 开头的会话。` : `${wanted} 能对上 ${ids.length} 条会话，再多给几位：\n${ids.join("\n")}`);
		process.exit(1);
	}
	for (const row of db.prepare("SELECT body FROM records WHERE session_id = ? ORDER BY seq").iterate(ids[0]!) as Iterable<{ body: string }>) {
		process.stdout.write(`${row.body}\n`);
	}
}
db.close();
