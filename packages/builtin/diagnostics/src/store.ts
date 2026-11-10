import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { SessionObservation } from "@plume/contract";

/** 请求与状态归诊断插件保存；正文和工具结果仍读会话原件，不再复制一份。 */
export class DiagnosticStore {
	private readonly db: DatabaseSync;
	private readonly generation = randomUUID();
	private readonly versions = new Map<string, number>();
	constructor(path: string) {
		closeSync(openSync(path, "a", 0o600));
		this.db = new DatabaseSync(path);
		this.db.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS observations (seq INTEGER PRIMARY KEY, session TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS by_session ON observations(session, seq)",
		);
	}
	append(value: SessionObservation): void {
		const { sessionId, at, event } = value;
		if (event.type === "rewound") this.db.prepare("DELETE FROM observations WHERE session = ? AND at >= ?").run(sessionId, event.count);
		else if ((event.type === "approval" && !event.approval) || (event.type === "hiccups" && !event.hiccups.length)) return;
		else {
			// 像素和供应商的不透明签名不属于可读诊断；保留图片的媒体标识。
			const payload = JSON.stringify(value, (_key, entry: unknown) => {
				if (!entry || typeof entry !== "object" || !("type" in entry)) return entry;
				const block = entry as Record<string, unknown>;
				if (block.type === "image" && typeof block.mimeType === "string") return { ...block, data: "" };
				if (block.type === "thinking" && typeof block.thinking === "string") return { ...block, signature: undefined, encrypted: undefined };
				return entry;
			});
			this.db.prepare("INSERT INTO observations(session, at, payload) VALUES (?, ?, ?)").run(sessionId, at, payload);
		}
		this.versions.set(sessionId, (this.versions.get(sessionId) ?? 0) + 1);
	}
	version(sessionId: string): string {
		return `${this.generation}:${this.versions.get(sessionId) ?? 0}`;
	}
	read(sessionId: string): SessionObservation[] {
		return this.db
			.prepare("SELECT payload FROM observations WHERE session = ? ORDER BY seq")
			.all(sessionId)
			.map((row) => JSON.parse(String(row.payload)) as SessionObservation);
	}
	delete(sessionId: string): void {
		this.db.prepare("DELETE FROM observations WHERE session = ?").run(sessionId);
		this.versions.delete(sessionId);
	}
	close(): void {
		this.db.close();
	}
}
