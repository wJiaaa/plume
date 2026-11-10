/**
 * 会话审计怎么数调用、怎么认分叉抄来的那段、花销按什么分。
 *
 * 跨回复重复的 id 照算：中转每一轮都从 `bash:0` / `call_0` 重新编号，这是支持的契约（`anthropic-messages-request.ts` 的替身表按轮建）。
 * 每次调用配的是跟在它那条回复后面的结果，不是全会话里最后一条同 id 的。
 *
 * 脚本一 import 就去读会话库，所以这里用生产的 `openSessionDb` 在临时目录里建一份库、用子进程跑它，`PLUME_HOME` 指向临时目录。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message, SessionSummary } from "../../packages/contract/src/index.ts";
import { openSessionDb, type SessionDb } from "../../packages/core/agent/src/session-db.ts";
import type { InputParts } from "../../packages/core/agent/src/usage-record.ts";
import { emptyUsage } from "../../packages/core/llm/src/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PARTS: InputParts = { system: 0, instructions: 0, skills: 0, toolDefs: 0, user: 0, injected: 0, assistant: 0, toolResults: 0 };
const NOTE = { parts: PARTS, turns: 0, tools: 0, toolErrors: 0, toolMs: 0 };

const summary = (id: string, createdAt: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
	id,
	title: id,
	cwd: "/tmp/audit",
	createdAt,
	updatedAt: createdAt,
	running: false,
	...extra,
});

const reply = (content: AssistantMessage["content"], timestamp: number, cost = 0): AssistantMessage => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "p",
	model: "m",
	stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
	usage: { ...emptyUsage(), input: 10, output: 5, total: 15, cost: { ...emptyUsage().cost, total: cost } },
	timestamp,
});
const call = (id: string): AssistantMessage["content"][number] => ({ type: "toolCall", id, name: "bash", arguments: { command: id } });
const result = (id: string, body: string, timestamp: number): Message => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	isError: false,
	content: [{ type: "text", text: body }],
	timestamp,
});

/** 在临时目录里建一份会话库，跑一次审计，返回 `--json` 的解析结果。 */
function audit(build: (db: SessionDb) => void): any {
	const home = mkdtempSync(join(tmpdir(), "plume-audit-"));
	const db = openSessionDb(join(home, "sessions", "sessions.db"), () => undefined);
	try {
		build(db);
	} finally {
		db.close();
	}
	const run = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts/session-audit.ts"), "--json"], {
		cwd: root,
		env: { ...process.env, PLUME_HOME: home },
		encoding: "utf8",
	});
	rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout);
}

test("跨回复复用的调用 id：每一轮都算，各配各的结果", () => {
	const out = audit((db) => {
		const s = summary("a", 1);
		db.create(s);
		db.append(s, reply([call("bash:0")], 2), NOTE);
		db.append(s, result("bash:0", "x".repeat(350), 3));
		db.append(s, reply([call("bash:0")], 4), NOTE);
		db.append(s, result("bash:0", "y".repeat(700), 5));
		db.append(s, reply([{ type: "text", text: "好了" }], 6), NOTE);
	});
	assert.equal(out.tools.bash.calls, 2, "两次都是真的跑过");
	assert.equal(out.tools.bash.tokens, Math.round(1050 / 3.5), "两次的结果各算各的");
	// 第一条结果之后还有两轮、第二条之后还有一轮。
	assert.equal(out.tools.bash.carried, Math.round((350 * 2 + 700) / 3.5));
});

test("分叉开头抄来的那段不再数一遍", () => {
	const out = audit((db) => {
		const source = summary("source", 1);
		db.create(source);
		const copied = [reply([call("c1")], 2), result("c1", "x".repeat(70), 3)];
		for (const message of copied) db.append(source, message, message.role === "assistant" ? NOTE : undefined);
		const fork = summary("fork", 100, { forkedFrom: { sessionId: "source" } });
		db.copy(fork, copied, { compactions: [], withheld: [] });
		db.append(fork, reply([call("c2")], 101), NOTE);
		db.append(fork, result("c2", "y".repeat(35), 102));
	});
	assert.equal(out.tools.bash.calls, 2, "原会话一次、分叉自己一次");
	assert.equal(out.rounds, 2);
});

test("花销按来源分：主会话、子会话、不属于会话一步的调用", () => {
	const out = audit((db) => {
		const main = summary("main", 1);
		db.create(main);
		db.append(main, reply([{ type: "text", text: "在" }], 2, 1), NOTE);
		const child = summary("child", 3, { parentId: "main", owner: "plume.subagents" });
		db.create(child);
		db.append(child, reply([{ type: "text", text: "查完了" }], 4, 2), NOTE);
		db.spend("main", reply([{ type: "text", text: "标题" }], 5, 4));
	});
	assert.deepEqual(out.spend.bySource, { main: 1, child: 2, aux: 4, deleted: 0 });
	assert.deepEqual(out.spend.children, { "plume.subagents": { sessions: 1, requests: 1, cost: 2 } });
	assert.deepEqual(out.byKind, { main: 1, child: 1, standalone: 0 });
});
