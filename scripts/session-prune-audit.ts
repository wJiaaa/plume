/**
 * 工具结果的剪裁在真实会话上能清掉多少：用生产的剪法在历史消息上重放，只量工具结果的字数（UTF-16 字符）× 之后的每一次请求。
 *
 * - `afterSend`：每次请求发出前 plume.compaction 在 model.context 里做的那一步（`freshView`：清空无结果的、剪掉炸开的输出）。
 * - `afterStale`：压缩时清掉已经被后来的观察顶替的结果（`dropStaleResults`），这里假设它在每次请求前都做，量的是它的上限。
 *
 * 不模拟模型行为、压缩本身、账单或缓存命中；数的是会话里存下的原样历史，不是当时真正发出去的那份。数据目录认 `PLUME_HOME`。
 *
 * 用法：
 *   pnpm audit:prune
 */

import { freshView } from "../packages/builtin/compaction/src/prune.ts";
import { dropStaleResults } from "../packages/builtin/compaction/src/stale-results.ts";
import type { Message } from "../packages/contract/src/index.ts";
import { copiedCount } from "./audit-copies.ts";
import { openSessionsReadOnly, storedSessions } from "./session-records.ts";

const chars = (messages: Message[]) =>
	messages.reduce(
		(sum, message) => sum + (message.role === "toolResult" ? message.content.reduce((n, part) => n + (part.type === "text" ? part.text.length : 0), 0) : 0),
		0,
	);

const { db } = openSessionsReadOnly();
const stored = storedSessions(db);
db.close();

let sessions = 0;
let requests = 0;
let before = 0;
let afterSend = 0;
let afterStale = 0;
let combined = 0;
let rewrites = 0;
for (const { summary, messages: all } of stored) {
	// 分叉抄来的那段在原会话里已经量过。
	const messages = all.slice(copiedCount(summary, all));
	const history: Message[] = [];
	sessions++;
	for (const message of messages) {
		if (message.role === "assistant") {
			requests++;
			const sent = freshView(history);
			before += chars(history);
			afterSend += chars(sent);
			afterStale += chars(dropStaleResults(history, summary.cwd));
			combined += chars(dropStaleResults(sent, summary.cwd));
			rewrites += sent.filter((each, i) => each !== history[i]).length;
		}
		history.push(message);
	}
}
const saving = (after: number) => (before ? 1 - after / before : 0);
console.log(
	JSON.stringify(
		{
			label:
				"Historical message replay; tool-result UTF-16 characters × subsequent requests; does not simulate model behaviour, compaction, invoices or cache hits",
			sessions,
			requests,
			before,
			afterSend,
			afterStale,
			combined,
			sendSaving: saving(afterSend),
			staleSaving: saving(afterStale),
			combinedSaving: saving(combined),
			rewrites,
		},
		null,
		2,
	),
);
