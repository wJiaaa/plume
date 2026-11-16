import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ThinkingLevel } from "@plume/contract";
import type { AgentSettings, ModelChoice, TaskRecord } from "./types.ts";
import { isDispatch } from "./types.ts";

const STATES = new Set(["queued", "running", "done", "failed", "stopped"]);

function parse(body: unknown): TaskRecord {
	const task = JSON.parse(String(body)) as TaskRecord;
	if (
		!isDispatch(task) ||
		typeof task.description !== "string" ||
		typeof task.prompt !== "string" ||
		typeof task.identity?.prompt !== "string" ||
		!STATES.has(task.state) ||
		!Number.isInteger(task.attempt)
	) {
		throw new Error("Invalid sub-agent registry");
	}
	return task;
}

/**
 * 私有登记簿不复制对话；只保存身份、派发状态和最终交付。每个任务一行，改了哪个只写哪个：任务越派越多，
 * 写一次的代价不跟着涨。`state`、`resumable` 另存一列，启动时对账不用把每一行都读出来。
 * 写入是同步的：交回报告之前，任务的结束状态已经在盘上。
 */
export class Store {
	/** 每种子智能体挑的模型和思考档位。 */
	readonly choices: AgentSettings = {};
	/** 关掉的种类，按名字；内置的一样能关。 */
	readonly disabled = new Set<string>();
	private readonly db: DatabaseSync;

	constructor(directory: string) {
		const path = join(directory, "subagents.db");
		closeSync(openSync(path, "a", 0o600));
		this.db = new DatabaseSync(path);
		this.db.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, parent TEXT NOT NULL, session TEXT NOT NULL, state TEXT NOT NULL, resumable INTEGER NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent); CREATE INDEX IF NOT EXISTS tasks_session ON tasks(session); CREATE TABLE IF NOT EXISTS choices (agent TEXT PRIMARY KEY, model TEXT, thinking TEXT) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS disabled (agent TEXT PRIMARY KEY) WITHOUT ROWID",
		);
		for (const row of this.db.prepare("SELECT agent, model, thinking FROM choices").all()) {
			this.choices[String(row.agent)] = {
				...(row.model ? { model: String(row.model) } : {}),
				...(row.thinking ? { thinking: String(row.thinking) as ThinkingLevel } : {}),
			};
		}
		for (const row of this.db.prepare("SELECT agent FROM disabled").all()) this.disabled.add(String(row.agent));
	}

	get(id: string): TaskRecord | undefined {
		const row = this.db.prepare("SELECT body FROM tasks WHERE id = ?").get(id);
		return row ? parse(row.body) : undefined;
	}

	/** 按派发的先后。 */
	byParent(parent: string): TaskRecord[] {
		return this.db
			.prepare("SELECT body FROM tasks WHERE parent = ? ORDER BY rowid")
			.all(parent)
			.map((row) => parse(row.body));
	}

	bySession(session: string): TaskRecord[] {
		return this.db
			.prepare("SELECT body FROM tasks WHERE session = ? ORDER BY rowid")
			.all(session)
			.map((row) => parse(row.body));
	}

	put(tasks: readonly TaskRecord[]): void {
		if (tasks.length === 0) return;
		const statement = this.db.prepare(
			"INSERT INTO tasks (id, parent, session, state, resumable, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent = excluded.parent, session = excluded.session, state = excluded.state, resumable = excluded.resumable, body = excluded.body",
		);
		this.transaction(() => {
			for (const task of tasks) statement.run(task.id, task.parent, task.session, task.state, task.resumable ? 1 : 0, JSON.stringify(task));
		});
	}

	deleteByParent(parent: string): void {
		this.db.prepare("DELETE FROM tasks WHERE parent = ?").run(parent);
	}

	/**
	 * 启动时对账：删掉父会话已不在的任务，交回还要改的——停在半路的（上次没跑完就退出了），和记着能续跑、
	 * 子会话却已不在（或不再是这个父会话的子会话）的。`children` 是还在的子会话，写成 `<子会话>\n<父会话>`。
	 */
	reconcile(sessions: readonly string[], children: readonly string[]): TaskRecord[] {
		this.db.prepare("DELETE FROM tasks WHERE parent NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify(sessions));
		return this.db
			.prepare(
				"SELECT body FROM tasks WHERE state IN ('queued', 'running') OR (resumable = 1 AND session || char(10) || parent NOT IN (SELECT value FROM json_each(?))) ORDER BY rowid",
			)
			.all(JSON.stringify(children))
			.map((row) => parse(row.body));
	}

	setChoice(agent: string, choice: ModelChoice): void {
		this.db
			.prepare(
				"INSERT INTO choices (agent, model, thinking) VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET model = excluded.model, thinking = excluded.thinking",
			)
			.run(agent, choice.model ?? null, choice.thinking ?? null);
		this.choices[agent] = { ...(choice.model ? { model: choice.model } : {}), ...(choice.thinking ? { thinking: choice.thinking } : {}) };
	}

	setDisabled(agent: string, disabled: boolean): void {
		if (disabled) {
			this.db.prepare("INSERT OR IGNORE INTO disabled (agent) VALUES (?)").run(agent);
			this.disabled.add(agent);
		} else {
			this.db.prepare("DELETE FROM disabled WHERE agent = ?").run(agent);
			this.disabled.delete(agent);
		}
	}

	close(): void {
		this.db.close();
	}

	private transaction(work: () => void): void {
		this.db.exec("BEGIN");
		try {
			work();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
