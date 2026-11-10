/**
 * MCP 工具多了以后延迟加载，模型还找不找得到、调不调得对，多花多少：「延迟」对「全部常驻」。
 *
 *   node --experimental-transform-types test/tool-eval/mcp-search-eval.ts <模型 id ...> [--runs 2] [--task <id>]
 *
 * 两边都有同一张内置工具表（见 `MCP_BUILTINS`），加上 `mcp-fixture.ts` 那 30 台假 MCP 服务器（真的经 plume.mcp 连上，
 * 每台一个 `mcp-fixture-server.ts` 进程）。唯一的差别是这些服务器常驻（每台都拨了「常驻」）还是按插件的阈值改成按需搜索
 * （产品默认）。工具表、系统提示词里的目录、`mcp_search` / `mcp_call`、循环都是产品的。
 *
 * 内置工具的执行换成记录器：只记下被叫了什么、回一句话，不碰文件和网络（`recordBuiltins`）；MCP 工具的调用由假服务器记下。
 * 每个任务只有一个正确答案：某台服务器的某个工具，带上任务里说出的几个参数值。
 *
 * 模型 id 写成设置里的 `<供应商 id>/<模型 id>`，经 `model.ts` 从 `PLUME_HOME` 解析，不读出任何密钥。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "../../packages/core/llm/src/types.ts";
import { requestUsage } from "../../packages/core/llm/src/types.ts";
import { type EvalAgent, evalAgent } from "./agent.ts";
import { FIXTURE_SERVERS } from "./mcp-fixture.ts";
import { evaluationNote, FixtureMcp, MCP_BUILTINS, recordBuiltins } from "./mcp-servers.ts";
import { type EvalModel, loadModel } from "./model.ts";

const say = (line = "") => process.stderr.write(`${line}\n`);

interface Task {
	id: string;
	prompt: string;
	/** 该调的那一个：服务器 id 和它那边的工具名（模型看到的名字由插件按服务器名起）。 */
	server: string;
	tool: string;
	/** 参数对不对：任务里说出的几个值都在。 */
	check: (args: Record<string, unknown>) => boolean;
}

const same = (a: unknown, b: unknown) =>
	typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : JSON.stringify(a) === JSON.stringify(b);
const fields = (expected: Record<string, unknown>) => (args: Record<string, unknown>) =>
	Object.entries(expected).every(([key, value]) => same(args[key], value));

const TASKS: Task[] = [
	{
		id: "linear-issue",
		prompt: 'In Linear, create an issue titled "Login fails on Safari" for the ENG team with High priority.',
		server: "linear",
		tool: "create_issue",
		check: fields({ title: "Login fails on Safari", team: "ENG", priority: 2 }),
	},
	{
		id: "slack-post",
		prompt: 'Post "Deploy finished" to the Slack channel with ID C024BE91L.',
		server: "slack",
		tool: "slack_post_message",
		check: fields({ channel_id: "C024BE91L", text: "Deploy finished" }),
	},
	{
		id: "sentry-issue",
		prompt: "Show me the details of Sentry issue PROJECT-1Z43 in the acme organization.",
		server: "sentry",
		tool: "get_issue_details",
		check: fields({ organizationSlug: "acme", issueId: "PROJECT-1Z43" }),
	},
	{
		id: "github-pr",
		prompt: 'Open a draft pull request on GitHub in acme/web from branch fix-login into main, titled "Fix login".',
		server: "github",
		tool: "create_pull_request",
		check: fields({ owner: "acme", repo: "web", head: "fix-login", base: "main", title: "Fix login", draft: true }),
	},
	{
		id: "cloudflare-dns",
		prompt: "Add a Cloudflare DNS A record for api.example.com pointing to 203.0.113.7 in zone 023e105f4ecef8ad9ca31a8372d0c353.",
		server: "cloudflare",
		tool: "create_dns_record",
		check: fields({ zone_id: "023e105f4ecef8ad9ca31a8372d0c353", type: "A", name: "api.example.com", content: "203.0.113.7" }),
	},
	{
		id: "stripe-refund",
		prompt: "Refund Stripe payment intent pi_3MtwBwLkdIwHu7ix28a3tqPa in full; the customer asked for it.",
		server: "stripe",
		tool: "create_refund",
		check: fields({ payment_intent: "pi_3MtwBwLkdIwHu7ix28a3tqPa", reason: "requested_by_customer" }),
	},
	{
		id: "calendar-event",
		prompt: 'Put a meeting called "Design review" on my primary Google Calendar from 2026-10-14T15:00:00Z to 2026-10-14T16:00:00Z.',
		server: "google-calendar",
		tool: "create_event",
		check: fields({ calendar_id: "primary", summary: "Design review", start: "2026-10-14T15:00:00Z", end: "2026-10-14T16:00:00Z" }),
	},
	{
		id: "k8s-logs",
		prompt: "Get the logs of pod api-7d9f in the prod namespace on Kubernetes.",
		server: "kubernetes",
		tool: "get_pod_log",
		check: fields({ namespace: "prod", pod: "api-7d9f" }),
	},
];

type Mode = "deferred" | "inline";

interface Arm {
	agent: EvalAgent;
	mcp: FixtureMcp;
	builtinCalls: { name: string; args: Record<string, unknown> }[];
}

/** 一种方式一个 agent：30 台服务器只连一次，每次评测开一个新会话（延迟与否按会话记）。 */
async function arm(model: EvalModel, mode: Mode): Promise<Arm> {
	const builtinCalls: Arm["builtinCalls"] = [];
	const agent = await evalAgent({ model, builtins: MCP_BUILTINS, plugins: [evaluationNote(), recordBuiltins(builtinCalls)] });
	const mcp = new FixtureMcp(agent);
	// 唯一的差别：每台都常驻，还是照插件的阈值改成按需搜索。
	await mcp.use(FIXTURE_SERVERS, mode === "inline");
	return { agent, mcp, builtinCalls };
}

async function runOnce(task: Task, { agent, mcp, builtinCalls }: Arm) {
	const cwd = await mkdtemp(join(tmpdir(), "plume-mcp-search-eval-"));
	const seen = (await mcp.calls()).length;
	const builtinSeen = builtinCalls.length;
	const turn = await agent.run(cwd, task.prompt, { maxSteps: 8 });
	const calls = (await mcp.calls()).slice(seen);
	const hits = calls.filter((call) => call.server === task.server && call.tool === task.tool);
	const replies = turn.messages.filter((m): m is AssistantMessage => m.role === "assistant");
	const input = replies.reduce((sum, m) => {
		const u = requestUsage(m);
		return sum + u.input + u.cacheRead + u.cacheWrite;
	}, 0);
	return {
		pass: hits.some((call) => task.check(call.args)),
		toolOk: hits.length > 0,
		refused: turn.calls.filter((call) => call.isError).length,
		// 调错了的：别的 MCP 工具，和被记录器接下的内置工具。`mcp_search` / `mcp_call` 是路，不算错。
		wrongTool: calls.length - hits.length + (builtinCalls.length - builtinSeen),
		requests: replies.length,
		input,
		error: turn.errors[0],
		got: hits[0]?.args,
	};
}

type Row = Awaited<ReturnType<typeof runOnce>>;
type Total = { pass: number; n: number; input: number; requests: number; refused: number };

async function main(): Promise<void> {
	const flag = (name: string) => {
		const at = process.argv.indexOf(name);
		return at >= 0 ? process.argv[at + 1] : undefined;
	};
	const runs = Number(flag("--runs") ?? 2);
	const one = flag("--task");
	const models = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && !["--runs", "--task"].includes(all[i - 1]!));
	if (models.length === 0) throw new Error("给一个或几个模型 id（设置里的 `<供应商 id>/<模型 id>`）");
	const tasks = TASKS.filter((task) => !one || task.id === one);
	if (tasks.length === 0) throw new Error(`没有任务 ${one}；有：${TASKS.map((task) => task.id).join(", ")}`);
	const resolved = await Promise.all(models.map((id) => loadModel(id)));
	// plume.mcp 还会读 `PLUME_HOME` 下 Magpie 分发的服务：指到一个空目录，评测里只有那 30 台。
	process.env.PLUME_HOME = await mkdtemp(join(tmpdir(), "plume-mcp-eval-home-"));
	for (const [index, modelId] of models.entries()) {
		say(`\nMCP 延迟 vs 全部常驻 · ${modelId} · 每个任务 ${runs} 次\n`);
		const arms = { deferred: await arm(resolved[index]!, "deferred"), inline: await arm(resolved[index]!, "inline") };
		say(`${"任务".padEnd(16)} ${"方式".padEnd(9)} 结果  工具对 拦下 错工具 请求 输入 token`);
		const totals: Record<string, Total> = {};
		const add = (key: string, r: Row) => {
			const t = (totals[key] ??= { pass: 0, n: 0, input: 0, requests: 0, refused: 0 });
			t.n++;
			t.pass += r.pass ? 1 : 0;
			t.input += r.input;
			t.requests += r.requests;
			t.refused += r.refused;
		};
		try {
			for (const task of tasks) {
				for (const mode of ["deferred", "inline"] as const) {
					for (let i = 0; i < runs; i++) {
						const r: Row = await runOnce(task, arms[mode]).catch((error: unknown) => ({
							pass: false,
							toolOk: false,
							refused: 0,
							wrongTool: 0,
							requests: 0,
							input: 0,
							error: String(error),
							got: undefined,
						}));
						add(mode, r);
						say(
							`${task.id.padEnd(16)} ${mode.padEnd(9)} ${r.pass ? "通过" : "失败"}  ${r.toolOk ? "是" : "否"}     ${String(r.refused).padEnd(4)} ${String(r.wrongTool).padEnd(6)} ${String(r.requests).padEnd(4)} ${r.input}${r.error ? `  ${r.error.slice(0, 80)}` : ""}${!r.pass && r.got ? `  得到 ${JSON.stringify(r.got).slice(0, 120)}` : ""}`,
						);
					}
				}
			}
		} finally {
			await arms.deferred.agent.close();
			await arms.inline.agent.close();
		}
		for (const [key, t] of Object.entries(totals)) {
			say(
				`${key.padEnd(17)} 通过 ${t.pass}/${t.n} · 平均请求 ${(t.requests / t.n).toFixed(2)} 次 · 平均输入 ${Math.round(t.input / t.n)} token · 被退回共 ${t.refused} 次`,
			);
		}
	}
}

await main();
