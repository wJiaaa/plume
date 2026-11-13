/**
 * 会话存储：`<dataDir>/sessions/sessions.db`，一个 SQLite 库。
 *
 * 每个会话在 `sessions` 里一行（摘要、压缩记录），消息在 `records` 里只往后追加，只有撤回、编辑重发从尾巴上截掉一段（`truncate`）。追加一条消息和更新它的摘要在同一个
 * 事务里，列表里看到的会话和它的消息不会对不上；整份重写会话文件、另存一份索引的做法，长会话每来一条消息都要把前面
 * 的全部再写一遍。
 *
 * 用 Node 自带的 `node:sqlite`，不加依赖：原生模块每个平台、每次升级 Electron 都要重新编译。它是同步 API，
 * 一个事务里不跨 `await`，进程里别的写入插不进来，所以不需要按文件排的写队列。事务里只读写库，不碰别的 I/O。
 *
 * 一个数据目录只有一个 agent 进程在写（主进程只起一个），所以打开库时留下来的流式草稿，写它的进程一定已经不在了。
 *
 * 花销单独一张表 `spend`：每次计费的调用一行，和带着它的回复在同一个事务里写；删会话不动它。使用统计读的是它，
 * 从会话记录里现算的话，删一条会话，已经付过的钱就从统计里消失了，和服务商的账对不上。
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	AssistantMessage,
	Message,
	QueuedMessage,
	SessionStats,
	SessionSummary,
	UsageCacheMissCause,
	UsageRequestBucket,
	UsageTokenPart,
} from "@plume/contract";
import type { AssistantContent } from "@plume/llm/types";
import type { ContextRecord } from "./compaction.ts";
import { text } from "./i18n.ts";
import { kindOf } from "./session-scope.ts";
import { billedParts, diagnoseCache, type PreviousRequest, type SpendNote, TOKEN_PARTS, thinkingMs } from "./usage-record.ts";

/**
 * 表结构和它的版本。不做迁移：别的版本写的库报出路径和原因，原样留着不动。改表就把版本加一，免得旧库少一张表也能混过去。
 *
 * - `sessions.context`：压缩和被剪掉的结果（`ContextRecord`），没压过、没剪过时是 null。
 * - `drafts` / `draft_chunks`：正在流式输出的回复，见下面的「流式草稿」。
 * - `queue`：会话排着的话（`QueuedMessage[]`，见 `queue.ts`），一个会话一行，队空了就删掉那一行；随会话一起删。
 * - `spend`：每次计费的调用，见 `insertSpend`。没有外键：会话删了它还在，`session_id` 照样留着；不属于会话的调用
 *   （插件经 `ctx.model.complete` 发的）是 null。会话里一步步发的请求（主请求）还记着 `prompt` 往后那些列，
 *   别的调用那些列是 null，见 `usage-record.ts`。
 */
const SCHEMA_VERSION = 1;
const SCHEMA = `
	CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		updated_at INTEGER NOT NULL,
		summary TEXT NOT NULL,
		context TEXT
	);
	CREATE TABLE records (
		id INTEGER PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		seq INTEGER NOT NULL,
		body TEXT NOT NULL,
		UNIQUE (session_id, seq)
	);
	CREATE TABLE drafts (
		session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
		head TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE draft_chunks (
		session_id TEXT NOT NULL REFERENCES drafts(session_id) ON DELETE CASCADE,
		n INTEGER NOT NULL,
		body TEXT NOT NULL,
		PRIMARY KEY (session_id, n)
	);
	CREATE TABLE queue (
		session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
		entries TEXT NOT NULL
	);
	CREATE TABLE spend (
		id INTEGER PRIMARY KEY,
		session_id TEXT,
		ts INTEGER NOT NULL,
		provider TEXT NOT NULL,
		model TEXT NOT NULL,
		input INTEGER NOT NULL,
		output INTEGER NOT NULL,
		cache_read INTEGER NOT NULL,
		cache_write INTEGER NOT NULL,
		cost REAL NOT NULL,
		priced INTEGER NOT NULL,
		attempt_output INTEGER NOT NULL,
		stream_ms INTEGER,
		first_token_ms INTEGER,
		duration_ms INTEGER,
		thinking_ms INTEGER,
		prompt INTEGER,
		${TOKEN_PARTS.map((part) => `${partColumn(part)} REAL,`).join("\n\t\t")}
		turns INTEGER,
		tools INTEGER,
		tool_errors INTEGER,
		tool_ms INTEGER,
		miss_tokens INTEGER,
		miss_cost REAL,
		miss_cause TEXT
	);
`;

/** `toolDefs` → `part_tool_defs`。 */
function partColumn(part: UsageTokenPart): string {
	return `part_${part.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`;
}

const MISS_CAUSES: readonly UsageCacheMissCause[] = ["tools", "prompt", "rewrite", "provider", "unknown", "compaction", "rewind", "model"];

/**
 * 生成耗时短于这个数的，不拿来算速度。不流式的中转把整段回答塞进一个包里，量出来只有几毫秒，500 个 token 除以 3ms
 * 是十几万 token/秒，一条就能把一天的平均速度抬到没法读。它们照样算请求、算 token，只是不算速度。
 */
const MIN_STREAM_MS = 100;

/** checkpoint 之后 WAL 文件缩回多大。不设的话它只会被复用、不会变小：删掉一大批会话后磁盘上的占用一点没少。 */
const WAL_LIMIT_BYTES = 16 * 1024 * 1024;

/** 流出来的字在内存里最多攒多久才落盘：进程中途没了，丢的最多是这么长时间的输出。 */
const DRAFT_FLUSH_MS = 80;
/** 攒够这么多字就提前写，快的流不会一攒就是几 MB。 */
const DRAFT_BATCH_CHARS = 8 * 1024;
/** 比对块末尾多少字来区分「接着长」和「整块重写了」。 */
const GROWTH_TAIL = 64;

/** 会话库打不开（被锁、文件坏了、结构版本不对）。带着路径：人得去那里看。 */
export class SessionDbUnavailable extends Error {
	readonly path: string;
	readonly reason: string;

	constructor(path: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		// i18n-exempt：只出现在 agent 进程启动失败的日志里。
		super(`无法打开会话库 ${path}：${reason}`, { cause });
		this.name = "SessionDbUnavailable";
		this.path = path;
		this.reason = reason;
	}
}

export interface SessionDb {
	/** 全部会话的摘要，`running` 一律是 false：存下来的会话没有在跑的。 */
	summaries(): SessionSummary[];
	messages(sessionId: string): Message[];
	context(sessionId: string): ContextRecord | undefined;
	create(summary: SessionSummary): void;
	/** 会话已经删掉时什么都不写：删除之后迟到的写入不能把它写回来。下面几个同理。 */
	saveSummary(summary: SessionSummary): void;
	/** 追加一条消息，连同更新后的摘要；是回复的话顺带清掉它的流式草稿。主请求的回复带上 `note`，见 `insertSpend`。 */
	append(summary: SessionSummary, message: Message, note?: SpendNote): void;
	saveContext(sessionId: string, record: ContextRecord): void;
	/**
	 * 只留前 `keep` 条消息（撤回、编辑重发），连同更新后的摘要和压缩记录，一个事务写完；流式草稿一并清掉。
	 * 后面的记录真删：花销在自己的表里，账不跟着少。
	 */
	truncate(summary: SessionSummary, keep: number, record: ContextRecord): void;
	/** 新建一条会话，带着这些消息和压缩记录（分叉）。花销不拷：那些钱是原会话花的。 */
	copy(summary: SessionSummary, messages: Message[], record: ContextRecord): void;
	/** 删掉这几条会话，一次把空间还回去。 */
	delete(sessionIds: string[]): void;
	/** 记一次不在会话消息里的调用（压缩摘要、插件的一次性调用）的花销。 */
	spend(sessionId: string | null, reply: AssistantMessage): void;
	/** 花销表按小时、供应商、模型合好。 */
	usage(): UsageRequestBucket[];
	stats(sessionId: string): Omit<SessionStats, "children">;
	/** 每条会话的记录占多少字节。 */
	sizes(): Map<string, number>;
	/** 整个库另存到 path，覆盖那里原有的文件。 */
	exportTo(path: string): void;
	/** 只另存这一条会话，含未完成的流式草稿、排着的话和它自己的花销，不带子会话。 */
	exportSession(sessionId: string, path: string): void;
	/** 各会话排着的话，原样读出来，校验由调用方做。 */
	queues(): Map<string, unknown>;
	/** 换掉一个会话排着的话；空数组删掉那一行。会话已经删掉时什么都不写。 */
	saveQueue(sessionId: string, entries: readonly QueuedMessage[]): void;
	/** 流式草稿的最新快照；undefined 表示这次请求流完了。见「流式草稿」。 */
	draft(sessionId: string, draft: AssistantMessage | undefined): void;
	/** 一轮结束时还没变成消息的草稿（流到一半抛错、被拒收后没写进会话的回复）不再要了。 */
	dropDraft(sessionId: string): void;
	close(): void;
}

/** 草稿里块 `i` 新增的字；`reset` 表示整块换掉而不是接在后面。只记文字和思考：写了一半的工具调用从没执行过，恢复时也不要。 */
interface DraftPiece {
	i: number;
	type: "text" | "thinking";
	text: string;
	reset?: true;
}

/** 一个会话正在写的草稿：每块已经交出去多少字，还有没落盘的那些。 */
interface DraftStream {
	taken: Map<number, { type: DraftPiece["type"]; length: number; tail: string }>;
	pending: DraftPiece[];
	chars: number;
	/** 第一段字立刻写，不等节流。 */
	first: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * 打开（第一次时新建）会话库。打不开就抛 `SessionDbUnavailable`，不自动重建：打不开可能只是被锁、或者同步盘拷了一半，
 * 重建会把所有会话清空。打开时把上次进程留下的草稿当成「按了停止」的回复写进会话。
 */
export function openSessionDb(path: string, log: (message: string) => void): SessionDb {
	let db: DatabaseSync | undefined;
	try {
		mkdirSync(dirname(path), { recursive: true });
		db = new DatabaseSync(path, { timeout: 5_000 });
		// 只在建第一张表之前设才生效，所以放最前面。没有它，删掉的会话占的空间不会还给磁盘。
		db.exec("PRAGMA auto_vacuum = INCREMENTAL");
		db.exec("PRAGMA journal_mode = WAL");
		// WAL 下 NORMAL 扛得住进程随时没了，只有断电可能丢最后几次提交；FULL 每次提交都要 fsync，流式草稿一秒要提交十几次。
		db.exec("PRAGMA synchronous = NORMAL");
		db.exec(`PRAGMA journal_size_limit = ${WAL_LIMIT_BYTES}`);
		db.exec("PRAGMA foreign_keys = ON");
		prepareSchema(db);
		recoverDrafts(db);
	} catch (cause) {
		if (db?.isOpen) db.close();
		throw new SessionDbUnavailable(path, cause);
	}
	return sessionStore(db, log);
}

function sessionStore(db: DatabaseSync, log: (message: string) => void): SessionDb {
	const streams = new Map<string, DraftStream>();
	/** 上一批草稿没写进去，还没成功过：只说一次，不是每次重试都说。 */
	let failing = false;

	const updateSummary = (summary: SessionSummary): boolean =>
		Number(db.prepare("UPDATE sessions SET updated_at = ?, summary = ? WHERE id = ?").run(summary.updatedAt, stored(summary), summary.id).changes) > 0;

	function forget(sessionId: string): void {
		const stream = streams.get(sessionId);
		if (stream?.timer) clearTimeout(stream.timer);
		streams.delete(sessionId);
	}

	/** 把攒着的字写进去。写失败的那批留着、排在后来的前面：每段都接在上一段后面，跳过一段，后面的全接错位置。 */
	function flush(sessionId: string, stream: DraftStream): void {
		if (stream.timer) clearTimeout(stream.timer);
		stream.timer = undefined;
		if (stream.pending.length === 0) return;
		try {
			transaction(db, () => {
				// 回复已经写进会话、或者会话删了：草稿没了，这批也就不用写了。
				const known = db
					.prepare(
						"SELECT (SELECT COALESCE(MAX(n), 0) FROM draft_chunks WHERE session_id = ?) AS n, EXISTS (SELECT 1 FROM drafts WHERE session_id = ?) AS open",
					)
					.get(sessionId, sessionId) as {
					n: number;
					open: number;
				};
				if (!known.open) return;
				db.prepare("INSERT INTO draft_chunks (session_id, n, body) VALUES (?, ?, ?)").run(sessionId, known.n + 1, JSON.stringify(mergePieces(stream.pending)));
				db.prepare("UPDATE drafts SET updated_at = ? WHERE session_id = ?").run(Date.now(), sessionId);
			});
			stream.pending = [];
			stream.chars = 0;
			failing = false;
		} catch (error) {
			// 草稿只是进程没了时的后备，写不进去不打断流式输出本身，定时再试。
			if (!failing) log(`会话 ${sessionId} 的流式回复没存上，稍后重试：${error instanceof Error ? error.message : String(error)}`);
			failing = true;
			schedule(sessionId, stream);
		}
	}

	function schedule(sessionId: string, stream: DraftStream): void {
		if (stream.timer || stream.pending.length === 0) return;
		stream.timer = setTimeout(() => {
			stream.timer = undefined;
			// 这期间草稿可能已经结束、换了一份：那就不是这一份的事了。
			if (streams.get(sessionId) === stream) flush(sessionId, stream);
		}, DRAFT_FLUSH_MS);
		stream.timer.unref();
	}

	return {
		summaries() {
			// 条数按记录现数，不信摘要里存的那份：摘要只在变了的时候写，记录才是准的。
			const rows = db
				.prepare("SELECT summary, (SELECT COUNT(*) FROM records r WHERE r.session_id = s.id) AS n FROM sessions s ORDER BY updated_at DESC")
				.all() as { summary: string; n: number }[];
			return rows.map((row) => {
				const summary = JSON.parse(row.summary) as SessionSummary;
				return { ...summary, kind: kindOf(summary), messageCount: Number(row.n), running: false };
			});
		},
		queues() {
			const rows = db.prepare("SELECT session_id, entries FROM queue").all() as { session_id: string; entries: string }[];
			return new Map(rows.map((row) => [row.session_id, JSON.parse(row.entries) as unknown]));
		},
		saveQueue(sessionId, entries) {
			if (entries.length === 0) db.prepare("DELETE FROM queue WHERE session_id = ?").run(sessionId);
			else
				db.prepare(
					"INSERT INTO queue (session_id, entries) SELECT id, ? FROM sessions WHERE id = ? ON CONFLICT (session_id) DO UPDATE SET entries = excluded.entries",
				).run(JSON.stringify(entries), sessionId);
		},
		messages(sessionId) {
			const rows = db.prepare("SELECT body FROM records WHERE session_id = ? ORDER BY seq").all(sessionId) as { body: string }[];
			return rows.map((row) => JSON.parse(row.body) as Message);
		},
		context(sessionId) {
			const row = db.prepare("SELECT context FROM sessions WHERE id = ?").get(sessionId) as { context: string | null } | undefined;
			return row?.context ? (JSON.parse(row.context) as ContextRecord) : undefined;
		},
		create(summary) {
			db.prepare("INSERT INTO sessions (id, updated_at, summary) VALUES (?, ?, ?)").run(summary.id, summary.updatedAt, stored(summary));
		},
		saveSummary(summary) {
			updateSummary(summary);
		},
		append(summary, message, note) {
			transaction(db, () => {
				// 会话删了，迟到的回复不写回会话；钱已经花了，账照记。
				if (message.role === "assistant") insertSpend(db, summary.id, message, note);
				if (!updateSummary(summary)) return;
				appendRecord(db, summary.id, message);
				if (message.role === "assistant") db.prepare("DELETE FROM drafts WHERE session_id = ?").run(summary.id);
			});
			if (message.role === "assistant") forget(summary.id);
		},
		saveContext(sessionId, record) {
			db.prepare("UPDATE sessions SET context = ? WHERE id = ?").run(JSON.stringify(record), sessionId);
		},
		truncate(summary, keep, record) {
			transaction(db, () => {
				if (!updateSummary(summary)) return;
				// seq 从 1 起连续（只追加、只截尾），留前 keep 条就是 seq ≤ keep；之后追加的接着 keep + 1。
				db.prepare("DELETE FROM records WHERE session_id = ? AND seq > ?").run(summary.id, keep);
				db.prepare("UPDATE sessions SET context = ? WHERE id = ?").run(JSON.stringify(record), summary.id);
				db.prepare("DELETE FROM drafts WHERE session_id = ?").run(summary.id);
			});
			forget(summary.id);
		},
		copy(summary, messages, record) {
			transaction(db, () => {
				db.prepare("INSERT INTO sessions (id, updated_at, summary, context) VALUES (?, ?, ?, ?)").run(
					summary.id,
					summary.updatedAt,
					stored(summary),
					JSON.stringify(record),
				);
				for (const message of messages) appendRecord(db, summary.id, message);
			});
		},
		delete(sessionIds) {
			if (sessionIds.length === 0) return;
			transaction(db, () => {
				for (const sessionId of sessionIds) {
					forget(sessionId);
					db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
				}
			});
			// 立刻把空间还回去。vacuum 搬动的页都经过 WAL，不 checkpoint 的话库变小了、WAL 却胀到差不多同样大。
			db.exec("PRAGMA incremental_vacuum");
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		},
		draft(sessionId, draft) {
			let stream = streams.get(sessionId);
			if (!draft) {
				// 流完了：剩下的写出去，草稿留在库里，等回复写进会话时一起清掉；中间进程没了，下次打开照样能恢复。
				if (stream) flush(sessionId, stream);
				forget(sessionId);
				return;
			}
			if (!stream) {
				// 新的一次请求：换掉上一份（被拒收后重发的那次留下的）。
				stream = { taken: new Map(), pending: [], chars: 0, first: true };
				streams.set(sessionId, stream);
				const head: AssistantMessage = { ...draft, content: [] };
				try {
					transaction(db, () => {
						db.prepare("DELETE FROM drafts WHERE session_id = ?").run(sessionId);
						db.prepare("INSERT INTO drafts (session_id, head, updated_at) SELECT id, ?, ? FROM sessions WHERE id = ?").run(
							JSON.stringify(head),
							Date.now(),
							sessionId,
						);
					});
				} catch (error) {
					// 同上：草稿开不了头，这次回复就没有后备，流式输出照常。
					log(`会话 ${sessionId} 的流式回复没存上：${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const pieces = takePieces(stream, draft);
			if (pieces.length === 0) return;
			stream.pending.push(...pieces);
			for (const piece of pieces) stream.chars += piece.text.length;
			if (stream.first || stream.chars >= DRAFT_BATCH_CHARS) {
				stream.first = false;
				flush(sessionId, stream);
			} else schedule(sessionId, stream);
		},
		spend(sessionId, reply) {
			insertSpend(db, sessionId, reply);
		},
		stats(sessionId) {
			const usage = db
				.prepare(`SELECT TOTAL(input) AS input, TOTAL(output) AS output, TOTAL(cache_read) AS cacheRead,
					TOTAL(cache_write) AS cacheWrite, TOTAL(cost) AS cost, TOTAL(priced = 0) AS unpriced FROM spend WHERE session_id = ?`)
				.get(sessionId);
			const counts = db
				.prepare(`SELECT TOTAL(json_extract(body, '$.role') = 'user' AND COALESCE(json_extract(body, '$.synthetic'), 0) = 0) AS turns,
					TOTAL(json_extract(body, '$.role') = 'assistant') AS steps,
					TOTAL(json_extract(body, '$.usage.input')) AS input, TOTAL(json_extract(body, '$.usage.cacheRead')) AS cacheRead, TOTAL(json_extract(body, '$.usage.cacheWrite')) AS cacheWrite FROM records WHERE session_id = ?`)
				.get(sessionId);
			return {
				turns: Number(counts?.turns),
				steps: Number(counts?.steps),
				replyUsage: { input: Number(counts?.input), cacheRead: Number(counts?.cacheRead), cacheWrite: Number(counts?.cacheWrite) },
				usage: { ...usage },
			} as Omit<SessionStats, "children">;
		},
		usage() {
			// 小时按本机时区切，和页面上的「今天」是同一个口径：晚上 11 点的调用算当天的。
			// 耗时构成只看主请求；生成段截在整次以内，思考记的时候已经截过（`thinkingMs`），减出来的等待不会是负数。
			const timedMain = "prompt IS NOT NULL AND duration_ms IS NOT NULL";
			const rows = db
				.prepare(
					`SELECT strftime('%Y-%m-%d %H', ts / 1000, 'unixepoch', 'localtime') AS hour, provider, model,
						COUNT(*) AS requests, TOTAL(input) AS input, TOTAL(output) AS output, TOTAL(cache_read) AS cacheRead,
						TOTAL(cache_write) AS cacheWrite, TOTAL(cost) AS cost, TOTAL(priced = 0) AS unpriced,
						TOTAL(stream_ms >= ${MIN_STREAM_MS} AND attempt_output > 0) AS timed,
						TOTAL(CASE WHEN stream_ms >= ${MIN_STREAM_MS} AND attempt_output > 0 THEN attempt_output END) AS timedOutput,
						TOTAL(CASE WHEN stream_ms >= ${MIN_STREAM_MS} AND attempt_output > 0 THEN stream_ms END) AS streamMs,
						COUNT(first_token_ms) AS firstTokens, TOTAL(first_token_ms) AS firstTokenMs,
						${TOKEN_PARTS.map((part) => `TOTAL(${partColumn(part)}) AS ${part}`).join(", ")},
						json_group_array(DISTINCT session_id) FILTER (WHERE prompt IS NOT NULL) AS sessions, TOTAL(turns) AS turns,
						TOTAL(${timedMain}) AS timedReplies, TOTAL(CASE WHEN ${timedMain} THEN duration_ms END) AS modelMs,
						TOTAL(CASE WHEN ${timedMain} THEN MIN(stream_ms, duration_ms) END) AS generateMs,
						TOTAL(CASE WHEN ${timedMain} THEN thinking_ms END) AS thinkingMs,
						TOTAL(tools) AS tools, TOTAL(tool_errors) AS toolErrors, TOTAL(tool_ms) AS toolMs,
						TOTAL(miss_tokens) AS missTokens, TOTAL(miss_cost) AS missCost, TOTAL(CASE WHEN miss_cost IS NULL THEN miss_tokens END) AS missUnpriced,
						${MISS_CAUSES.map((cause) => `TOTAL(CASE WHEN miss_cause = '${cause}' THEN miss_tokens END) AS miss_${cause}`).join(", ")}
					FROM spend GROUP BY hour, provider, model ORDER BY hour`,
				)
				.all() as Record<string, string | number>[];
			// node:sqlite 给的行没有原型，过 rpc 前拼成普通对象。
			return rows.map(({ sessions, missTokens, missCost, missUnpriced, ...row }) => {
				const bucket: Record<string, unknown> = {};
				const parts: Record<string, unknown> = {};
				const byCause: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(row)) {
					if (key.startsWith("miss_")) {
						if (Number(value) > 0) byCause[key.slice("miss_".length)] = value;
					} else if ((TOKEN_PARTS as readonly string[]).includes(key)) parts[key] = value;
					else bucket[key] = value;
				}
				const cacheMiss = { tokens: missTokens, cost: missCost, unpriced: missUnpriced, byCause };
				return { ...bucket, parts, sessions: JSON.parse(String(sessions)), cacheMiss } as unknown as UsageRequestBucket;
			});
		},
		sizes() {
			const rows = db.prepare("SELECT session_id, TOTAL(length(CAST(body AS BLOB))) AS bytes FROM records GROUP BY session_id").all() as {
				session_id: string;
				bytes: number;
			}[];
			return new Map(rows.map((row) => [row.session_id, row.bytes]));
		},
		exportTo(path) {
			// `VACUUM INTO` 而不是拷文件：WAL 里还没并回库文件的也在里面，流式回复写着的时候也是一份完整的快照。
			// 它不肯覆盖已有的文件，所以先写在旁边再改名；写到一半失败，原来那个文件不受影响。
			const partial = `${path}.${process.pid}.partial`;
			rmSync(partial, { force: true });
			try {
				db.prepare("VACUUM INTO ?").run(partial);
				renameSync(partial, path);
			} catch (error) {
				rmSync(partial, { force: true });
				throw error;
			}
		},
		exportSession(sessionId, path) {
			if (!db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) throw new Error(`Session not found: ${sessionId}`);
			const source = (db.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find((entry) => entry.name === "main")!.file;
			protectSource(source, path);
			const stream = streams.get(sessionId);
			if (stream) {
				flush(sessionId, stream);
				// 流式落盘可以稍后重试，导出却不能悄悄交出缺了尾巴的快照。
				if (stream.pending.length) throw new Error(`Could not flush session draft: ${sessionId}`);
			}
			const temporary = mkdtempSync(join(dirname(path), ".plume-session-export-"));
			const partial = join(temporary, "session.db");
			try {
				// 用副本的连接读源库，不在源连接上附加一个可写的导出库。
				const out = new DatabaseSync(partial);
				try {
					out.exec("PRAGMA foreign_keys = ON");
					prepareSchema(out);
					out.prepare("ATTACH DATABASE ? AS src").run(source);
					// 延迟事务只在源库上取读快照；BEGIN IMMEDIATE 会连附加的源库也抢写锁。
					out.exec("BEGIN");
					out.prepare("INSERT INTO sessions SELECT * FROM src.sessions WHERE id = ?").run(sessionId);
					for (const table of ["records", "drafts", "draft_chunks", "queue", "spend"]) {
						out.prepare(`INSERT INTO ${table} SELECT * FROM src.${table} WHERE session_id = ?`).run(sessionId);
					}
					out.exec("COMMIT");
				} finally {
					out.close();
				}
				renameSync(partial, path);
			} finally {
				// 包括失败留下的 journal、WAL 和 SHM，全部只在自己新建的临时目录里。
				rmSync(temporary, { recursive: true, force: true });
			}
		},
		dropDraft(sessionId) {
			forget(sessionId);
			db.prepare("DELETE FROM drafts WHERE session_id = ?").run(sessionId);
		},
		close() {
			// 正常退出时把还没写出的那批写完；关库会把 WAL 并回库文件。
			for (const [sessionId, stream] of streams) flush(sessionId, stream);
			for (const sessionId of [...streams.keys()]) forget(sessionId);
			if (db.isOpen) db.close();
		},
	};
}

/** 导出不能替换正在用的源库或日志；目录别名、符号链接和硬链接也算同一份文件。 */
export function protectSource(source: string, destination: string): void {
	const target = resolve(realpathSync(dirname(destination)), basename(destination));
	const actual = existsSync(destination) ? realpathSync(destination) : target;
	const targetStat = existsSync(destination) ? statSync(destination) : undefined;
	for (const protectedPath of [resolve(source), realpathSync(source)].flatMap((file) => ["", "-wal", "-shm", "-journal"].map((suffix) => `${file}${suffix}`))) {
		const sourceStat = existsSync(protectedPath) ? statSync(protectedPath) : undefined;
		if (
			target === protectedPath ||
			actual === protectedPath ||
			(sourceStat && targetStat && sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)
		) {
			throw new Error(text("storage.exportSource"));
		}
	}
}

/**
 * 存下来的摘要不带 `running`、`background`：重开以后没有在跑的会话，也没有在等的后台运行；`kind` 读回来时现算；
 * `projectPermission` 跟着项目配置和本机设置走，读这个会话的设置时现算。
 */
function stored(summary: SessionSummary): string {
	const { running: _running, background: _background, kind: _kind, projectPermission: _projectPermission, ...rest } = summary;
	return JSON.stringify(rest);
}

/**
 * 一次调用的花销。`usage` 是这一次的账，含前面几次失败的重试；速度只看最后成功的那一次（`lastAttemptUsage`），
 * 计时只属于它。首字时间是总耗时减去生成耗时。一个 token 都没有的（还没发出去就失败了）不算一次请求。
 *
 * 带着 `note` 的是会话里的主请求：再记各部分 token、这之前的轮次和工具，并和同一会话上一次主请求比缓存（`diagnoseCache`）。
 * 上一次主请求和这个模型报没报过缓存，都从这张表里查：撤回截掉的记录、重开应用都不影响。
 */
function insertSpend(db: DatabaseSync, sessionId: string | null, reply: AssistantMessage, note?: SpendNote): void {
	const { usage } = reply;
	if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return;
	const stream = reply.sseDurationMs;
	const firstToken = stream !== undefined && reply.durationMs !== undefined && reply.durationMs >= stream ? reply.durationMs - stream : null;
	const main = note && sessionId !== null ? mainColumns(db, sessionId, reply, note) : {};
	const columns: Record<string, string | number | null> = {
		session_id: sessionId,
		ts: reply.timestamp,
		provider: reply.provider,
		model: reply.model,
		input: usage.input,
		output: usage.output,
		cache_read: usage.cacheRead,
		cache_write: usage.cacheWrite,
		cost: usage.cost.total,
		// 配了价格时 `computeCost` 记下价从哪来；没配价格的模型费用是 0，但不是免费。
		priced: usage.cost.source ? 1 : 0,
		attempt_output: (reply.lastAttemptUsage ?? usage).output,
		stream_ms: stream ?? null,
		first_token_ms: firstToken,
		duration_ms: reply.durationMs ?? null,
		thinking_ms: thinkingMs(reply),
		...main,
	};
	const names = Object.keys(columns);
	db.prepare(`INSERT INTO spend (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(columns));
}

function mainColumns(db: DatabaseSync, sessionId: string, reply: AssistantMessage, note: SpendNote): Record<string, string | number | null> {
	const previous = db
		.prepare("SELECT prompt, provider, model FROM spend WHERE session_id = ? AND prompt IS NOT NULL ORDER BY id DESC LIMIT 1")
		.get(sessionId) as PreviousRequest | undefined;
	const reported =
		db
			.prepare("SELECT 1 FROM spend WHERE session_id = ? AND provider = ? AND model = ? AND prompt IS NOT NULL AND cache_read + cache_write > 0 LIMIT 1")
			.get(sessionId, reply.provider, reply.model) !== undefined;
	const diagnosis = diagnoseCache(reply, previous, reported, note.boundary);
	const parts = billedParts(reply, note.parts);
	return {
		prompt: diagnosis.prompt,
		...Object.fromEntries(TOKEN_PARTS.map((part) => [partColumn(part), parts[part]])),
		turns: note.turns,
		tools: note.tools,
		tool_errors: note.toolErrors,
		tool_ms: note.toolMs,
		miss_tokens: diagnosis.missed,
		miss_cost: diagnosis.extraCost,
		miss_cause: diagnosis.cause ?? null,
	};
}

function appendRecord(db: DatabaseSync, sessionId: string, message: Message): void {
	db.prepare("INSERT INTO records (session_id, seq, body) SELECT ?, COALESCE(MAX(seq), 0) + 1, ? FROM records WHERE session_id = ?").run(
		sessionId,
		JSON.stringify(message),
		sessionId,
	);
}

/** 在一个写事务里跑 `fn`；已经在事务里时并进外面那个。 */
function transaction<T>(db: DatabaseSync, fn: () => T): T {
	if (db.isTransaction) return fn();
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}

function userVersion(db: DatabaseSync): number {
	return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/** 新库建表；结构版本不是这一版的库不碰：往别的形状的表里写，库就悄悄坏了。 */
function prepareSchema(db: DatabaseSync): void {
	if (userVersion(db) === SCHEMA_VERSION) return;
	transaction(db, () => {
		const found = userVersion(db);
		if (found === SCHEMA_VERSION) return;
		// i18n-exempt：只出现在 agent 进程启动失败的日志里。
		if (found !== 0)
			throw new Error(`会话库的结构版本是 ${found}，这个版本的 Plume 用的是 ${SCHEMA_VERSION}，不做转换。把这个文件移走后重新打开，会建一个新的`);
		db.exec(SCHEMA);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	});
}

/**
 * 上次进程留下的草稿：当成「按了停止」的回复写进会话（`stopReason: "aborted"`），只留文字和思考；一个字都没有就直接删。
 * 会话的更新时间记成草稿最后一次写入的时刻，不是这次打开的时刻：周一断掉的回复周三打开，它还是周一的事。
 * 这一轮记成被中断（`interrupted`）：恢复出的回复只有文字，光看转录像是说完了，界面就不给「继续」。
 */
function recoverDrafts(db: DatabaseSync): void {
	const rows = db.prepare("SELECT d.session_id, d.head, d.updated_at, s.summary FROM drafts d JOIN sessions s ON s.id = d.session_id").all() as {
		session_id: string;
		head: string;
		updated_at: number;
		summary: string;
	}[];
	for (const row of rows) {
		transaction(db, () => {
			const chunks = db.prepare("SELECT body FROM draft_chunks WHERE session_id = ? ORDER BY n").all(row.session_id) as { body: string }[];
			const message = assembleDraft(
				JSON.parse(row.head) as AssistantMessage,
				chunks.map((chunk) => JSON.parse(chunk.body) as DraftPiece[]),
			);
			db.prepare("DELETE FROM drafts WHERE session_id = ?").run(row.session_id);
			if (!message) return;
			const summary = JSON.parse(row.summary) as SessionSummary;
			summary.updatedAt = Math.max(summary.updatedAt, row.updated_at);
			summary.stop = { reason: "interrupted" };
			db.prepare("UPDATE sessions SET updated_at = ?, summary = ? WHERE id = ?").run(summary.updatedAt, JSON.stringify(summary), row.session_id);
			appendRecord(db, row.session_id, message);
		});
	}
}

function textOf(block: AssistantContent): string | null {
	if (block.type === "text") return block.text;
	if (block.type === "thinking") return block.thinking;
	return null;
}

/**
 * 这份快照比上次多出来的字。界面的草稿每次给的是整条回复，整条重写的话，一条 100KB 的回复流几分钟要写几百 MB；
 * 只写新增的尾巴，总共写下的就是回复本身那么大。
 *
 * 只比长度和末尾一小段，不比整段前缀：每次都比整段，长回复是平方级的开销。重试从头写、文字被修剪这类重写会改掉旧末尾
 * 或让块变短，都认得出来，按整块换掉处理。重试清空了内容、块比上次少，或者原位置换成了工具调用：交出去过的那块换成空的，
 * 不然恢复时上一次尝试写的字还在。
 */
function takePieces(stream: DraftStream, draft: AssistantMessage): DraftPiece[] {
	const out: DraftPiece[] = [];
	for (const [i, known] of stream.taken) {
		const block = draft.content[i];
		if (block && textOf(block) !== null) continue;
		if (known.length > 0) out.push({ i, type: known.type, text: "", reset: true });
		stream.taken.delete(i);
	}
	draft.content.forEach((block, i) => {
		const text = textOf(block);
		if (text === null) return;
		const type = block.type as DraftPiece["type"];
		const known = stream.taken.get(i);
		const grew =
			known !== undefined && known.type === type && text.length >= known.length && text.slice(known.length - known.tail.length, known.length) === known.tail;
		if (grew) {
			if (text.length > known.length) out.push({ i, type, text: text.slice(known.length) });
		} else if (known || text.length > 0) out.push({ i, type, text, reset: true });
		stream.taken.set(i, { type, length: text.length, tail: text.slice(-GROWTH_TAIL) });
	});
	return out;
}

/** 同一块挨着的几段并成一段，一批里几十个 token 只占一项。 */
function mergePieces(pieces: DraftPiece[]): DraftPiece[] {
	const out: DraftPiece[] = [];
	for (const piece of pieces) {
		const last = out.at(-1);
		if (last && !piece.reset && last.i === piece.i && last.type === piece.type) last.text += piece.text;
		else out.push({ ...piece });
	}
	return out;
}

/** 草稿拼回成的回复，形状和人按停止时得到的一样；什么都没说时是 null。 */
function assembleDraft(head: AssistantMessage, chunks: DraftPiece[][]): AssistantMessage | null {
	const blocks = new Map<number, { type: DraftPiece["type"]; text: string }>();
	for (const piece of chunks.flat()) {
		const known = blocks.get(piece.i);
		if (piece.reset || !known || known.type !== piece.type) blocks.set(piece.i, { type: piece.type, text: piece.text });
		else known.text += piece.text;
	}
	const content: AssistantContent[] = [...blocks]
		.sort(([a], [b]) => a - b)
		.filter(([, block]) => block.text.length > 0)
		.map(([, block]) => (block.type === "text" ? { type: "text", text: block.text } : { type: "thinking", thinking: block.text }));
	if (content.length === 0) return null;
	return { ...head, content, stopReason: "aborted" };
}
