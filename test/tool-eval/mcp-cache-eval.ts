/**
 * MCP 延迟加载有没有真的保住提示缓存：拿服务商返回的 cacheRead / cacheWrite 量，不是只比请求字节。
 *
 *   node --experimental-transform-types test/tool-eval/mcp-cache-eval.ts <模型 id ...> [--mode deferred|inline]
 *
 * 一个会话连跑 5 轮：Linear（mcp_search + mcp_call）→ Slack → 新增一台 Twilio 后用它 → 移除 Notion 后查 Sentry →
 * 不用 MCP 的收尾。对照组同一剧本，30 台全部「常驻」，增减服务器会改工具表。
 *
 * 整条路都是产品的：服务器经 plume.mcp 的配置真的连上、断开（`mcp-fixture-server.ts`），延迟与否由插件定（切过去不切回）；
 * 系统提示词由 plume.prompt 第一轮冻结，之后目录变了作为增量接在那一轮的用户消息后面；缓存键、请求前缀指纹由本体带上；
 * 每次主请求的缓存诊断是本体记进会话库 `spend` 表的那一行（`diagnoseCache`），这里只读出来。内置工具的执行换成记录器。
 *
 * 模型 id 写成设置里的 `<供应商 id>/<模型 id>`，经 `model.ts` 从 `PLUME_HOME` 解析，不读出任何密钥。
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage } from "../../packages/core/llm/src/types.ts";
import { requestUsage } from "../../packages/core/llm/src/types.ts";
import { evalAgent } from "./agent.ts";
import { FIXTURE_SERVERS, type FixtureServer, TWILIO } from "./mcp-fixture.ts";
import { evaluationNote, FixtureMcp, MCP_BUILTINS, recordBuiltins } from "./mcp-servers.ts";
import { type EvalModel, loadModel } from "./model.ts";

const say = (line = "") => process.stderr.write(`${line}\n`);

const REMOVED = "notion";

interface Turn {
	label: string;
	prompt: string;
	/** 这一轮开始前连着的服务器。 */
	servers: FixtureServer[];
	/** 这一轮应当调到的 MCP 工具（服务器那边的名字）；没有就是「不用 MCP」那一轮。 */
	tool?: string;
}

const base = FIXTURE_SERVERS;
const added = [...base, TWILIO];
const removed = added.filter((server) => server.id !== REMOVED);

const TURNS: Turn[] = [
	{
		label: "T1 Linear",
		servers: base,
		tool: "create_issue",
		prompt: 'In Linear, create an issue titled "Login fails on Safari" for the ENG team with High priority.',
	},
	{ label: "T2 Slack", servers: base, tool: "slack_post_message", prompt: 'Now post "Deploy finished" to the Slack channel with ID C024BE91L.' },
	{ label: "T3 +Twilio", servers: added, tool: "send_sms", prompt: 'Text +15551234567 from +15557654321 via Twilio: "Build is green".' },
	{ label: "T4 -Notion", servers: removed, tool: "get_issue_details", prompt: "Show me the details of Sentry issue PROJECT-1Z43 in the acme organization." },
	{ label: "T5 无MCP", servers: removed, prompt: "Without calling any tool, tell me in one sentence which services you used in this conversation." },
];

interface Row {
	turn: string;
	request: number;
	event: string;
	prompt: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	/** 理应从缓存读到的：上一次主请求的输入总量（不超过这一次的），本体按它算未命中。 */
	expected: number;
	/** 本体记下的未命中 token（噪声以内记 0）。 */
	missed: number;
	cause: string;
	/** 本地前缀指纹给出的第一处不同；没有就是前缀原样延续。 */
	breakAt: string;
	calls: string;
}

/** 本体为每次主请求记下的那一行。 */
interface Spend {
	ts: number;
	prompt: number;
	miss_tokens: number | null;
	miss_cause: string | null;
}

function spendOf(dataDir: string, sessionId: string): Spend[] {
	const db = new DatabaseSync(join(dataDir, "sessions", "sessions.db"), { readOnly: true });
	try {
		return db
			.prepare("SELECT ts, prompt, miss_tokens, miss_cause FROM spend WHERE session_id = ? AND prompt IS NOT NULL ORDER BY id")
			.all(sessionId) as unknown as Spend[];
	} finally {
		db.close();
	}
}

/** plume.prompt 给这个会话记下的增量：每条是哪几段变了，`text: null` 是移除。 */
async function promptUpdates(dir: string, sessionId: string): Promise<{ changes: { section: string; text: string | null }[] }[]> {
	const raw = await readFile(join(dir, "frozen", `${sessionId}.json`), "utf8").catch(() => "");
	return raw ? ((JSON.parse(raw) as { updates?: { changes: { section: string; text: string | null }[] }[] }).updates ?? []) : [];
}

async function runSession(model: EvalModel, mode: "deferred" | "inline"): Promise<{ rows: Row[]; mcpCalls: string[] }> {
	const agent = await evalAgent({ model, builtins: MCP_BUILTINS, plugins: [evaluationNote(), recordBuiltins([])] });
	try {
		const mcp = new FixtureMcp(agent);
		const cwd = await mkdtemp(join(tmpdir(), "plume-mcp-cache-eval-"));
		const sessionId = await agent.session(cwd);
		const rows: Row[] = [];
		let previousServers = TURNS[0]!.servers;
		let previousPrompt: number | undefined;
		let updatesSeen = 0;
		let spendSeen = 0;

		for (const turn of TURNS) {
			await mcp.use(turn.servers, mode === "inline");
			const seen = (await mcp.calls()).length;
			const result = await agent.send(sessionId, turn.prompt, { maxSteps: 8 });

			const events: string[] = [];
			if (turn === TURNS[0]) events.push("冷启动");
			if (turn.servers !== previousServers) events.push(`服务器 ${previousServers.length}→${turn.servers.length} 台`);
			previousServers = turn.servers;
			const updates = await promptUpdates(agent.pluginDataDir("plume.prompt"), sessionId);
			const fresh = updates.slice(updatesSeen).flatMap((update) => update.changes.map((change) => `${change.section}${change.text === null ? " 移除" : ""}`));
			updatesSeen = updates.length;
			if (fresh.length > 0) events.push(`目录增量 ${fresh.join(", ")}`);

			const spend = spendOf(agent.dataDir, sessionId);
			const byTime = new Map(spend.slice(spendSeen).map((row) => [row.ts, row]));
			spendSeen = spend.length;
			let request = 0;
			for (const message of result.messages) {
				if (message.role !== "assistant") continue;
				const reply = message as AssistantMessage;
				const recorded = byTime.get(reply.timestamp);
				if (!recorded) {
					say(`  ${turn.label} 请求失败：${reply.errorMessage ?? reply.stopReason}`);
					continue;
				}
				const usage = requestUsage(reply);
				const calls = reply.content
					.filter((block) => block.type === "toolCall")
					.map((block) => (block.name === "mcp_call" ? `mcp_call(${String((block.arguments as { tool?: unknown }).tool)})` : block.name));
				rows.push({
					turn: turn.label,
					request: ++request,
					event: request === 1 ? events.join("；") : "",
					prompt: recorded.prompt,
					input: usage.input,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					expected: previousPrompt === undefined ? 0 : Math.min(previousPrompt, recorded.prompt),
					missed: recorded.miss_tokens ?? 0,
					cause: recorded.miss_cause ?? "—",
					breakAt: reply.prefix?.change
						? `${reply.prefix.change.segment}（${reply.prefix.change.before}→${reply.prefix.change.after} 字符）`
						: reply.prefix
							? "无"
							: "—",
					calls: calls.join(" "),
				});
				previousPrompt = recorded.prompt;
			}
			for (const error of result.errors) say(`  ${turn.label} 出错：${error}`);
			const calls = (await mcp.calls()).slice(seen);
			if (turn.tool && !calls.some((call) => call.tool === turn.tool)) say(`  ${turn.label}：没有调到 ${turn.tool}`);
		}
		return { rows, mcpCalls: (await mcp.calls()).map((call) => `${call.server}.${call.tool}`) };
	} finally {
		await agent.close();
	}
}

function print(rows: Row[]): void {
	say("| 轮次 | 次 | 事件 | 输入 | cacheRead | cacheWrite | 命中率 | 应读 | 未命中 | 诊断 | 本地前缀断点 | 调用 |");
	say("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const row of rows) {
		const rate = row.prompt > 0 ? `${((row.cacheRead / row.prompt) * 100).toFixed(1)}%` : "—";
		say(
			`| ${row.turn} | ${row.request} | ${row.event} | ${row.prompt} | ${row.cacheRead} | ${row.cacheWrite} | ${rate} | ${row.expected} | ${row.missed} | ${row.cause} | ${row.breakAt} | ${row.calls} |`,
		);
	}
	const read = rows.reduce((sum, row) => sum + row.cacheRead, 0);
	const total = rows.reduce((sum, row) => sum + row.prompt, 0);
	say(
		`合计：${rows.length} 次请求，输入 ${total}，cacheRead ${read}（${total > 0 ? ((read / total) * 100).toFixed(1) : 0}%），cacheWrite ${rows.reduce((sum, row) => sum + row.cacheWrite, 0)}`,
	);
}

async function main(): Promise<void> {
	const at = process.argv.indexOf("--mode");
	const only = at >= 0 ? process.argv[at + 1] : undefined;
	const models = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && all[i - 1] !== "--mode");
	if (models.length === 0) throw new Error("给一个或几个模型 id（设置里的 `<供应商 id>/<模型 id>`）");
	const modes = (["deferred", "inline"] as const).filter((mode) => !only || mode === only);
	const resolved = await Promise.all(models.map((id) => loadModel(id)));
	// plume.mcp 还会读 `PLUME_HOME` 下 Magpie 分发的服务：指到一个空目录，评测里只有剧本里的那些。
	process.env.PLUME_HOME = await mkdtemp(join(tmpdir(), "plume-mcp-eval-home-"));
	const out: Record<string, unknown> = {};
	for (const [index, modelId] of models.entries()) {
		for (const mode of modes) {
			say(`\n## ${modelId} · ${mode === "deferred" ? "延迟加载" : "全部常驻"}\n`);
			const result = await runSession(resolved[index]!, mode).catch((error: unknown) => {
				say(`失败：${String(error)}`);
				return undefined;
			});
			if (!result) continue;
			print(result.rows);
			say(`MCP 调用：${result.mcpCalls.join(", ") || "（无）"}`);
			out[`${modelId}#${mode}`] = result;
		}
	}
	process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

await main();
