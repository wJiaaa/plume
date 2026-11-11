import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { SessionObservation } from "@plume/contract";
import type { RequestInput, TraceObservation } from "./api.ts";

type Request = Extract<SessionObservation["event"], { type: "request" }>;
/** 落盘的请求：系统提示词、工具表和每条消息都换成 `parts` 里的指纹。 */
type StoredRequest = Omit<Request, "systemPrompt" | "tools" | "messages"> & { systemPrompt: string; tools: string; messages: string[] };

/** 像素和供应商的不透明签名不属于可读诊断；保留图片的媒体标识。 */
function readable(_key: string, entry: unknown): unknown {
	if (!entry || typeof entry !== "object" || !("type" in entry)) return entry;
	const block = entry as Record<string, unknown>;
	if (block.type === "image" && typeof block.mimeType === "string") return { ...block, data: "" };
	if (block.type === "thinking" && typeof block.thinking === "string") return { ...block, signature: undefined, encrypted: undefined };
	return entry;
}

/**
 * 请求与状态归诊断插件保存；会话正文和工具结果读会话原件。一次请求实际发出去的东西（压缩后的历史、剪过的结果、插件补的上下文）
 * 会话里没有，得存：每次请求都带着整段历史，原样一条一行会随请求数平方增长，所以系统提示词、工具表和每条消息按内容指纹在会话内
 * 只存一份（`parts`），请求只记指纹，打开详情时再拼回来（`request`）。
 */
export class DiagnosticStore {
	private readonly db: DatabaseSync;
	private readonly generation = randomUUID();
	private readonly versions = new Map<string, number>();
	constructor(path: string) {
		closeSync(openSync(path, "a", 0o600));
		this.db = new DatabaseSync(path);
		this.db.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS observations (seq INTEGER PRIMARY KEY, session TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS by_session ON observations(session, seq); CREATE TABLE IF NOT EXISTS parts (session TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (session, hash)) WITHOUT ROWID",
		);
	}
	append(value: SessionObservation): void {
		const { sessionId, event } = value;
		if (event.type === "rewound")
			this.transaction(() => {
				this.db.prepare("DELETE FROM observations WHERE session = ? AND at >= ?").run(sessionId, event.count);
				this.prune(sessionId);
			});
		else if ((event.type === "approval" && !event.approval) || (event.type === "hiccups" && !event.hiccups.length)) return;
		else if (event.type === "request") this.transaction(() => this.insert(value, this.keep(sessionId, event)));
		else this.insert(value, event);
		this.versions.set(sessionId, (this.versions.get(sessionId) ?? 0) + 1);
	}
	version(sessionId: string): string {
		return `${this.generation}:${this.versions.get(sessionId) ?? 0}`;
	}
	/** 给轨迹列表的：请求只带消息条数和系统提示词的指纹，系统提示词按指纹一份（`prompts`）。 */
	read(sessionId: string): { observations: TraceObservation[]; prompts: Record<string, string> } {
		const wanted = new Set<string>();
		const observations = this.db
			.prepare("SELECT payload FROM observations WHERE session = ? ORDER BY seq")
			.all(sessionId)
			.map((row) => {
				const value = JSON.parse(String(row.payload)) as Omit<SessionObservation, "event"> & {
					event: Exclude<SessionObservation["event"], { type: "request" }> | StoredRequest;
				};
				if (value.event.type !== "request") return value as TraceObservation;
				const { tools: _tools, messages, ...rest } = value.event;
				wanted.add(rest.systemPrompt);
				return { ...value, event: { ...rest, messages: messages.length } };
			});
		const prompts: Record<string, string> = {};
		for (const [hash, prompt] of this.parts(sessionId, [...wanted])) prompts[hash] = prompt as string;
		return { observations, prompts };
	}
	/** 一次请求实际发出去的系统提示词、消息和工具表；请求或它的某一份内容已不在时是 undefined。 */
	request(sessionId: string, requestId: string): RequestInput | undefined {
		const row = this.db
			.prepare(
				"SELECT payload FROM observations WHERE session = ? AND json_extract(payload, '$.event.type') = 'request' AND json_extract(payload, '$.event.id') = ?",
			)
			.get(sessionId, requestId);
		if (!row) return undefined;
		const event = (JSON.parse(String(row.payload)) as { event: StoredRequest }).event;
		const hashes = [event.systemPrompt, event.tools, ...event.messages];
		const found = this.parts(sessionId, hashes);
		if (hashes.some((hash) => !found.has(hash))) return undefined;
		return {
			systemPrompt: found.get(event.systemPrompt) as string,
			tools: found.get(event.tools) as RequestInput["tools"],
			messages: event.messages.map((hash) => found.get(hash) as RequestInput["messages"][number]),
		};
	}
	delete(sessionId: string): void {
		this.transaction(() => {
			this.db.prepare("DELETE FROM observations WHERE session = ?").run(sessionId);
			this.db.prepare("DELETE FROM parts WHERE session = ?").run(sessionId);
		});
		this.versions.delete(sessionId);
	}
	close(): void {
		this.db.close();
	}

	private insert(value: SessionObservation, event: SessionObservation["event"] | StoredRequest): void {
		this.db
			.prepare("INSERT INTO observations(session, at, payload) VALUES (?, ?, ?)")
			.run(value.sessionId, value.at, JSON.stringify({ ...value, event }, readable));
	}
	/** 把请求里的大块内容按指纹存进 `parts`（已有的不再写），换成指纹。 */
	private keep(sessionId: string, event: Request): StoredRequest {
		const statement = this.db.prepare("INSERT OR IGNORE INTO parts(session, hash, body) VALUES (?, ?, ?)");
		const put = (part: unknown) => {
			const body = JSON.stringify(part, readable);
			const hash = createHash("sha256").update(body).digest("base64url").slice(0, 22);
			statement.run(sessionId, hash, body);
			return hash;
		};
		return { ...event, systemPrompt: put(event.systemPrompt), tools: put(event.tools), messages: event.messages.map(put) };
	}
	private parts(sessionId: string, hashes: string[]): Map<string, unknown> {
		const rows = this.db
			.prepare("SELECT hash, body FROM parts WHERE session = ? AND hash IN (SELECT value FROM json_each(?))")
			.all(sessionId, JSON.stringify(hashes));
		return new Map(rows.map((row) => [String(row.hash), JSON.parse(String(row.body)) as unknown]));
	}
	/** 撤回删掉了一段请求：只有它们用到的内容跟着删，撤回的话不留在诊断库里。 */
	private prune(sessionId: string): void {
		const used = new Set<string>();
		for (const row of this.db
			.prepare("SELECT payload FROM observations WHERE session = ? AND json_extract(payload, '$.event.type') = 'request'")
			.all(sessionId)) {
			const event = (JSON.parse(String(row.payload)) as { event: StoredRequest }).event;
			for (const hash of [event.systemPrompt, event.tools, ...event.messages]) used.add(hash);
		}
		const remove = this.db.prepare("DELETE FROM parts WHERE session = ? AND hash = ?");
		for (const row of this.db.prepare("SELECT hash FROM parts WHERE session = ?").all(sessionId)) {
			if (!used.has(String(row.hash))) remove.run(sessionId, String(row.hash));
		}
	}
	private transaction(fn: () => void): void {
		this.db.exec("BEGIN");
		try {
			fn();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
