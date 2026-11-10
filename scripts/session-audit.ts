/**
 * 真实会话的成本体检：钱花在哪、哪条闸门在真的起作用、回合都是怎么结束的。
 *
 * 关于「浪费 token」「死循环」「突然停止」的改动，照着直觉做很容易误伤真实工作：一条「连着很多轮不说话就停」的规则会掐断一次
 * 正常的长任务，一条「花到多少钱就提醒」只会是噪音。所以任何针对循环、截断、停止条件、压缩的改动，前后都跑一遍这个脚本，拿两份
 * 输出对照：
 *
 *   - 省下的量对得上预期吗（第 1、2、5 节）
 *   - 有没有哪条闸门从「从不触发」变成「频繁触发」，或者反过来（第 4 节）
 *   - 回合结束的原因分布变了吗（第 6 节）
 *   - 提示缓存的前缀有没有在哪一次请求被打断（第 10 节的「要查的」那几类）
 *   - 压缩让人干等了多久（第 11 节）
 *   - 压缩后丢了多少、缓存隔多久还读得到（第 13、14 节，`audit-compaction.ts`）
 *
 * 读的是 `<PLUME_HOME>/sessions/sessions.db`（缺省 `~/.plume`）里的真实会话，数字会随着自己的使用而变。**要对照就必须是同一台
 * 机器、同一批会话的前后两次**，不同机器之间的绝对值没有可比性。
 *
 * 「同一批」比听上去难：改代码要几个小时，这期间人还在用这台机器，新会话一进来，改前存下的那份输出就对不上了，分不清是代码变了
 * 还是样本变了。可靠的做法是在同一时刻跑两份代码——把改动前的提交检出到一个临时 worktree（`git worktree add --detach
 * /tmp/plume-base <基线提交>`，`node_modules` 软链过去），两边各跑一次 `--json` 再 `cmp`。
 *
 * 第 4、5、13 节直接 import 生产代码（`RepetitionWatch`、`pruneToolResults`、压缩的 `KEEP_MIN` 和估算）在真实记录上重放，而不是照着
 * 它们的逻辑另写一份：另写的那份只能证明「我以为它是这样」。第 8、10、14 节读花销表（`spend`）：每次计费的调用在那里一行，撤回截掉的
 * 回复也在；缓存诊断是请求当时由生产的 `diagnoseCache` 算好存下的，事后回放拿不到当时发出去的那份请求。
 *
 * 用法：
 *   pnpm audit:sessions
 *   pnpm audit:sessions --json > /tmp/before.json
 */

import { join } from "node:path";
import { KEEP_MIN } from "../packages/builtin/compaction/src/budget.ts";
import { FORK_HOT_MS } from "../packages/builtin/compaction/src/fork.ts";
import { PRUNE_THRESHOLD_CHARS, pruneToolResults } from "../packages/builtin/compaction/src/prune.ts";
import type { CompactionRun, Message, SessionSummary, ToolResultMessage, UsageCacheMissCause } from "../packages/contract/src/index.ts";
import type { Compaction } from "../packages/core/agent/src/compaction.ts";
import { loadCachedModelCatalog } from "../packages/core/agent/src/model-catalog-sync.ts";
import { RepetitionWatch } from "../packages/core/agent/src/repetition.ts";
import { CACHE_NOISE_FLOOR_TOKENS } from "../packages/core/agent/src/usage-record.ts";
import { catalogModelFor } from "../packages/core/llm/src/model-catalog.ts";
import { requestUsage } from "../packages/core/llm/src/types.ts";
import { afterCompaction, type AuditBoundary, cacheLifetime, LIFETIME_BUCKETS, type LifetimeRequest } from "./audit-compaction.ts";
import { copiedCount } from "./audit-copies.ts";
import { PEER_TOOLS, type PeerArrival, type PeerCall, peerStats } from "./audit-peers.ts";
import { plumeHome, openSessionsReadOnly, storedSessions } from "./session-records.ts";

/** 字符数换算 token 的粗系数。绝对值不重要，前后两次用同一个就行。 */
const CHARS_PER_TOKEN = 3.5;
/** 进入「单条最贵」榜的门槛，低于这个的条目太多且都不值得看。 */
const BIG_RESULT_CHARS = 2000;
/** 一轮里自动压缩的 p90 到这个数，等待才算挡人、值得挪到后台。 */
const BLOCKING_COMPACTION_MS = 30_000;

const asJson = process.argv.includes("--json");

interface Call {
	id: string;
	name: string;
	args: unknown;
	/** 第几个助手回合发出的，用来算这条结果之后还要被重发多少轮。 */
	round: number;
	/** 发出它的那条助手消息在会话消息里的下标，和压缩边界对位用。 */
	at: number;
	/**
	 * 这次调用的结果：跟在这条回复后面、下一条回复之前、id 对得上的那条。按回复找，不按 id 在整个会话里查：中转每一轮都从
	 * `bash:0` / `call_0` 重新编号（`packages/core/llm/src/ai/anthropic-messages-request.ts` 的替身表按轮建），全会话按 id 查会让
	 * 前面那几次都拿到最后一次的结果。
	 */
	result?: ToolResultMessage;
}

/** 一个助手回合：谁答的、发了几个调用、花了多少。 */
interface Turn {
	model: string;
	toolCalls: number;
	cost: number;
	/** 这次请求带了多少上下文（不含丢掉的重试）。 */
	context: number;
	/** 这次请求按哪档输入单价计的；同一模型里比最低档贵，就是越过了价格分档线。没定价为 0。 */
	inputRate: number;
}

/** 一步：一条回复发出的调用，和按写进会话的先后跟在它后面的结果。循环就是这样把一步交给 `RepetitionWatch.observe` 的。 */
interface Step {
	at: number;
	calls: { name: string; arguments: unknown }[];
	results: ToolResultMessage[];
	/** 停下、出错的回复：循环不观察这一步。 */
	settled: boolean;
}

/** 主会话；插件建的子会话（子 Agent、侧边聊天）；插件不挂在会话下的独立会话。 */
type SessionKind = "main" | "child" | "standalone";

interface Session {
	id: string;
	kind: SessionKind;
	/** 建它的插件；侧栏里的会话没有。 */
	owner?: string;
	/** 去掉分叉抄来的那段之后的消息。 */
	messages: Message[];
	rounds: number;
	calls: Call[];
	steps: Step[];
	/** 每个助手回合的 stopReason。 */
	stops: string[];
	/** 会话的最后一轮是怎么结束的（`SessionSummary.stop`）；正在跑、没记下时没有。 */
	lastStop?: string;
	turns: Turn[];
	userPrompts: { text: string; synthetic: boolean }[];
	fileEdits: Map<string, number>;
	/** 这个会话自己的压缩（分叉抄来的不算），和它们写下的边界（第 13 节）。 */
	compactions: Compaction[];
	boundaries: AuditBoundary[];
	/** 转录里那几行压缩（`CompactionRun`），这个会话自己的。 */
	runs: CompactionRun[];
	peerCalls: PeerCall[];
	peerArrivals: PeerArrival[];
}

function kindOf(summary: SessionSummary): SessionKind {
	if (summary.parentId) return "child";
	return summary.owner ? "standalone" : "main";
}

function pathArg(args: unknown): string | undefined {
	const record = args as { path?: unknown; file_path?: unknown } | undefined;
	const path = record?.path ?? record?.file_path;
	return typeof path === "string" ? path : undefined;
}

function textOf(message: Message): string {
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function loadSession(summary: SessionSummary, all: Message[], record: { compactions: Compaction[]; runs?: CompactionRun[] } | undefined): Session {
	const offset = copiedCount(summary, all);
	const messages = all.slice(offset);
	// 分叉时压缩记录跟着消息一起抄过来；早于这个会话创建的那几次、那几行是原会话的。
	const own = summary.forkedFrom ? (at: number) => at >= summary.createdAt : () => true;
	const compactions = (record?.compactions ?? []).filter((compaction) => own(compaction.at));
	const runs = (record?.runs ?? []).filter((run) => own(run.startedAt));
	const calls: Call[] = [];
	const steps: Step[] = [];
	const stops: string[] = [];
	const turns: Turn[] = [];
	const userPrompts: Session["userPrompts"] = [];
	const peerArrivals: PeerArrival[] = [];
	const fileEdits = new Map<string, number>();
	let round = 0;
	let waiting = new Map<string, Call>();
	let step: Step | undefined;
	messages.forEach((message, at) => {
		if (message.role === "user") {
			userPrompts.push({ text: message.displayText ?? textOf(message), synthetic: message.synthetic === true });
			if (message.peer) peerArrivals.push({ steered: message.steered === true, letters: message.peer });
			return;
		}
		if (message.role === "toolResult") {
			step?.results.push(message);
			const call = waiting.get(message.toolCallId);
			if (call) {
				call.result = message;
				waiting.delete(message.toolCallId);
			}
			return;
		}
		round++;
		stops.push(message.stopReason);
		waiting = new Map();
		const own = message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
		step = {
			at,
			calls: own.map((block) => ({ name: block.name, arguments: block.arguments })),
			results: [],
			settled: message.stopReason === "aborted" || message.stopReason === "error",
		};
		steps.push(step);
		for (const block of own) {
			const call: Call = { id: block.id, name: block.name, args: block.arguments, round, at };
			calls.push(call);
			waiting.set(block.id, call);
			if (block.name === "edit" || block.name === "write") {
				const path = pathArg(block.arguments);
				if (path) fileEdits.set(path, (fileEdits.get(path) ?? 0) + 1);
			}
		}
		const usage = requestUsage(message);
		turns.push({
			model: message.model,
			toolCalls: own.length,
			cost: message.usage.cost.total,
			context: usage.input + usage.cacheRead + usage.cacheWrite,
			inputRate: usage.cost.rates?.input ?? 0,
		});
	});
	return {
		id: summary.id.slice(0, 8),
		kind: kindOf(summary),
		...(summary.owner ? { owner: summary.owner } : {}),
		messages,
		rounds: round,
		calls,
		steps,
		stops,
		...(summary.stop ? { lastStop: summary.stop.reason } : {}),
		turns,
		userPrompts,
		fileEdits,
		compactions,
		boundaries: compactions.map((compaction) => ({ at: compaction.count - offset, kept: compaction.count - compaction.keptFrom })),
		runs,
		peerCalls: calls
			.filter((call) => (PEER_TOOLS as readonly string[]).includes(call.name))
			.map((call) => {
				const kind = (call.result?.details as { kind?: unknown } | undefined)?.kind;
				return { name: call.name, isError: call.result?.isError === true, ...(typeof kind === "string" ? { kind } : {}) };
			}),
		peerArrivals,
	};
}

/** 一条工具结果的正文长度——模型真正要为之付钱的部分。 */
function charsOf(result: Message | undefined): number {
	if (!result || result.role !== "toolResult") return 0;
	let total = 0;
	for (const part of result.content) if (part.type === "text") total += part.text.length;
	return total;
}

const tk = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);
const pad = (value: string | number, width: number) => String(value).padStart(width);
const share = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

interface SpendRow {
	session_id: string | null;
	ts: number;
	provider: string;
	model: string;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	cost: number;
	/** 会话里一步步发的主请求才有：这次请求的输入总量。 */
	prompt: number | null;
	miss_tokens: number | null;
	miss_cost: number | null;
	miss_cause: UsageCacheMissCause | null;
}

const { db } = openSessionsReadOnly();
const stored = storedSessions(db);
const spendRows = db
	.prepare(
		"SELECT session_id, ts, provider, model, input, output, cache_read, cache_write, cost, prompt, miss_tokens, miss_cost, miss_cause FROM spend ORDER BY id",
	)
	.all() as unknown as SpendRow[];
db.close();

const summaries = new Map(stored.map((entry) => [entry.summary.id, entry.summary]));
const allSessions = stored.map((entry) => loadSession(entry.summary, entry.messages, entry.record));
const sessions = allSessions.filter((session) => session.rounds > 0);

// ---------------------------------------------------------------------------
// 1&2. 每个工具的一次性体积，以及它真正的代价：体积 × 之后还要被重发的轮数
// ---------------------------------------------------------------------------

interface ToolCost {
	n: number;
	chars: number;
	/** 字符·轮。一条结果留在上下文里，之后每一轮都要重新发一遍。 */
	carried: number;
}
const byTool = new Map<string, ToolCost>();
const biggest: { session: string; tool: string; chars: number; after: number; carried: number; args: string }[] = [];
let allChars = 0;
let allCarried = 0;

for (const session of sessions) {
	for (const call of session.calls) {
		const chars = charsOf(call.result);
		const after = session.rounds - call.round;
		const carried = chars * after;
		const entry = byTool.get(call.name) ?? { n: 0, chars: 0, carried: 0 };
		entry.n++;
		entry.chars += chars;
		entry.carried += carried;
		byTool.set(call.name, entry);
		allChars += chars;
		allCarried += carried;
		if (chars >= BIG_RESULT_CHARS)
			biggest.push({ session: session.id, tool: call.name, chars, after, carried, args: JSON.stringify(call.args ?? {}).slice(0, 60) });
	}
}

// ---------------------------------------------------------------------------
// 3. read 的重复：改过再读是正常的，一字不差地再读一遍不是
// ---------------------------------------------------------------------------

let readCalls = 0;
let readChars = 0;
let rereadCalls = 0;
let rereadChars = 0;
let identicalCalls = 0;
let identicalChars = 0;

for (const session of sessions) {
	const seenPath = new Set<string>();
	const seenExact = new Set<string>();
	for (const call of session.calls) {
		if (call.name !== "read") continue;
		const path = pathArg(call.args);
		if (path === undefined) continue;
		const chars = charsOf(call.result);
		readCalls++;
		readChars += chars;
		if (seenPath.has(path)) {
			rereadCalls++;
			rereadChars += chars;
		}
		seenPath.add(path);
		const exact = JSON.stringify(call.args);
		if (seenExact.has(exact)) {
			identicalCalls++;
			identicalChars += chars;
		}
		seenExact.add(exact);
	}
}

/*
 * 读和改之间多出来的那几轮。
 *
 * - 折叠之后又按段读：结构视图本意是让模型只读需要的那段，可要改、要读懂的文件，最后常被一段段读完，比一次读完多跑好几轮。
 * - 改完紧接着重读：模型要再读一遍才敢接着改，多一轮。
 */
let outlinedReads = 0;
let rangedAfterOutline = 0;
let editsOk = 0;
let readAfterEdit = 0;
for (const session of sessions) {
	const folded = new Set<string>();
	for (const [i, call] of session.calls.entries()) {
		const path = pathArg(call.args);
		if (path === undefined) continue;
		const result = call.result;
		if (call.name === "read") {
			const args = call.args as { offset?: unknown; limit?: unknown };
			if ((result?.details as { outlined?: unknown } | undefined)?.outlined === true) {
				outlinedReads++;
				folded.add(path);
			} else if (folded.has(path) && (args.offset !== undefined || args.limit !== undefined)) rangedAfterOutline++;
		}
		if (call.name !== "edit" || !result || result.isError) continue;
		editsOk++;
		const next = session.calls.slice(i + 1).find((later) => pathArg(later.args) === path && (later.name === "read" || later.name === "edit"));
		if (next?.name === "read") readAfterEdit++;
	}
}

// ---------------------------------------------------------------------------
// 4. 重复检测这条闸门实际拦下了什么——用生产代码重放，不是照着它重写一份
//
// 和循环一样一步一观察（`loop.ts`），也在同样的地方清零：人说了新的话、压缩之后（`agent.ts`）。撤回截掉的那段已经不在会话里，
// 重放看不到。
// ---------------------------------------------------------------------------

let warns = 0;
let corrected = 0;
let correctedChars = 0;
let wouldStop = 0;

for (const session of sessions) {
	const watch = new RepetitionWatch();
	const resets = new Set(session.boundaries.map((boundary) => boundary.at));
	const steps = new Map(session.steps.map((step) => [step.at, step]));
	let stopped = false;
	session.messages.forEach((message, at) => {
		if (resets.has(at) || (message.role === "user" && !message.synthetic)) watch.reset();
		const step = steps.get(at);
		if (!step || step.settled || step.results.length === 0) return;
		const before = new Map(watch.replaced);
		watch.observe(step.calls, step.results);
		if (watch.takeHint() !== undefined) warns++;
		for (const result of step.results) {
			const notice = watch.replaced.get(result.toolCallId);
			if (notice === undefined || before.get(result.toolCallId) === notice) continue;
			corrected++;
			correctedChars += charsOf(result);
		}
		if (!stopped && watch.exhausted()) {
			stopped = true;
			wouldStop++;
		}
	});
}

// ---------------------------------------------------------------------------
// 5. 如果超大结果在产生 N 轮之后就被裁掉，能省多少
//
// 裁剪后的大小是真的裁一遍量出来的：`pruneToolResults` 是 plume.compaction 的生产代码，头尾各留多少由它说了算。照着它的常量自己
// 加一遍，只能证明「我以为它留这么多」。
// ---------------------------------------------------------------------------

/** 把一条工具结果单独交给生产的裁剪函数，看它会被裁到多大。 */
function prunedCharsOf(result: ToolResultMessage): number {
	const [pruned] = pruneToolResults([result]);
	return charsOf(pruned);
}

const DELAYS = [0, 5, 12, 20, 40, 80];
/** 按裁剪延迟 N 轮算出来的总携带成本（字符·轮）。 */
const curve = new Map<number, number>(DELAYS.map((n) => [n, 0]));
let bigCount = 0;
let bigCarried = 0;
let allCount = 0;

for (const session of sessions) {
	for (const call of session.calls) {
		const chars = charsOf(call.result);
		const after = session.rounds - call.round;
		allCount++;
		// 没到裁剪线的结果，在任何 N 下成本都一样，直接计入每一档
		if (!call.result || chars <= PRUNE_THRESHOLD_CHARS) {
			for (const n of DELAYS) curve.set(n, curve.get(n)! + chars * after);
			continue;
		}
		bigCount++;
		bigCarried += chars * after;
		const small = prunedCharsOf(call.result);
		for (const n of DELAYS) {
			const atFullSize = Math.min(n, after);
			curve.set(n, curve.get(n)! + chars * atFullSize + small * Math.max(0, after - n));
		}
	}
}

// ---------------------------------------------------------------------------
// 6. 回合是怎么结束的
// ---------------------------------------------------------------------------

const stopKinds = new Map<string, number>();
const endedWith = new Map<string, number>();
const lastStops = new Map<string, number>();
for (const session of sessions) {
	for (const stop of session.stops) stopKinds.set(stop, (stopKinds.get(stop) ?? 0) + 1);
	const last = session.stops.at(-1);
	if (last) endedWith.set(last, (endedWith.get(last) ?? 0) + 1);
	if (session.lastStop) lastStops.set(session.lastStop, (lastStops.get(session.lastStop) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// 7. 并行度：一个回合发几个调用，按模型分
//
// 这是「慢」的直接原因，和「贵」是两件事。一个回合只发一个调用，123 次调用就要 123 个回合，每个回合都要等模型想一遍——
// 工具本身可能只花了一分半，人却等了十五分钟。按模型分组是因为差距能到两个数量级，同一套代码换个模型就完全不同。
// ---------------------------------------------------------------------------

interface Par {
	turns: number;
	calls: number;
	/** 一个回合里发了两个及以上调用的回合数。 */
	parallel: number;
}
const byModel = new Map<string, Par>();
let parTurns = 0;
let parCalls = 0;
let parMulti = 0;

for (const session of sessions) {
	for (const turn of session.turns) {
		if (turn.toolCalls === 0) continue;
		const e = byModel.get(turn.model) ?? { turns: 0, calls: 0, parallel: 0 };
		e.turns++;
		e.calls += turn.toolCalls;
		if (turn.toolCalls > 1) e.parallel++;
		byModel.set(turn.model, e);
		parTurns++;
		parCalls += turn.toolCalls;
		if (turn.toolCalls > 1) parMulti++;
	}
}

/** 被改道挡回去的 bash：模型要用 shell 干工具的活（plume.tools 的 `rerouteShellCommand`），这一个回合白费了。 */
let blockedTurns = 0;
for (const session of sessions)
	for (const call of session.calls) if ((call.result?.details as { kind?: unknown } | undefined)?.kind === "reroute") blockedTurns++;

// ---------------------------------------------------------------------------
// 8. 缓存与真实花销
//
// 读花销表：每次计费的调用一行，含撤回截掉的回复、压缩摘要和插件经 `ctx.model.complete` 发的那些（不属于会话的一步，`prompt` 为空），
// 删掉的会话花的也还在。主会话、子会话、辅助请求加起来才是账单。
// ---------------------------------------------------------------------------

type SpendSource = "main" | "child" | "aux" | "deleted";
function sourceOf(row: SpendRow): SpendSource {
	if (row.prompt === null) return "aux";
	const summary = row.session_id === null ? undefined : summaries.get(row.session_id);
	if (!summary) return "deleted";
	return kindOf(summary) === "main" ? "main" : "child";
}

let cacheRead = 0;
let cacheWrite = 0;
let rawInput = 0;
let output = 0;
const spendBy: Record<SpendSource, number> = { main: 0, child: 0, aux: 0, deleted: 0 };
const childSpend = new Map<string, { sessions: Set<string>; requests: number; cost: number }>();
for (const row of spendRows) {
	cacheRead += row.cache_read;
	cacheWrite += row.cache_write;
	rawInput += row.input;
	output += row.output;
	const source = sourceOf(row);
	spendBy[source] += row.cost;
	if (source !== "child") continue;
	const owner = summaries.get(row.session_id!)?.owner ?? "(unknown)";
	const entry = childSpend.get(owner) ?? { sessions: new Set<string>(), requests: 0, cost: 0 };
	entry.sessions.add(row.session_id!);
	entry.requests++;
	entry.cost += row.cost;
	childSpend.set(owner, entry);
}
const cost = spendBy.main + spendBy.child + spendBy.aux + spendBy.deleted;
const billed = rawInput + cacheRead + cacheWrite;

/*
 * 每次请求的花费按它带了多少上下文分桶。cacheRead 的钱和上下文大小成正比，大窗口模型压缩线靠后时，钱集中在最上面几桶——
 * 压缩线怎么定，看这里的前后对照。只数会话里的主请求。
 */
const conversationRows = spendRows.filter((row) => row.prompt !== null);
const CONTEXT_BUCKETS = [0, 50_000, 100_000, 200_000, 300_000, Infinity];
const contextSpend = CONTEXT_BUCKETS.slice(0, -1).map((from, i) => {
	const to = CONTEXT_BUCKETS[i + 1]!;
	const inBucket = conversationRows.filter((row) => row.prompt! >= from && row.prompt! < to);
	return { from, to, requests: inBucket.length, cost: inBucket.reduce((sum, row) => sum + row.cost, 0) };
});

/*
 * 越过价格分档线的请求：上下文过了这个模型在目录里最低的分档线，输入单价又比同一模型线以下的请求都贵。线按模型查，不写死：
 * 目录里有各种线。目录里没有分档的模型不参与。不能只比「最便宜的那档」：有的服务商有分时折扣，同样的上下文白天和夜里单价不同。
 * 单价是请求当时记在回复上的那份（`usage.cost.rates`），所以从会话里的回复读，撤回截掉的那些不在里面。
 */
await loadCachedModelCatalog(join(plumeHome(), "model-catalog.json"));
const tierLines = new Map<string, number>();
const tierLineOf = (model: string): number => {
	let line = tierLines.get(model);
	if (line === undefined) {
		// 回复里只有模型 ID，没有端点，按目录的参考条目（厂商官方或 OpenRouter）查。
		const entry = catalogModelFor({ baseUrl: "" }, model)?.model;
		line = entry?.tiers?.reduce((lowest, tier) => Math.min(lowest, tier.aboveTokens), Infinity) ?? Infinity;
		tierLines.set(model, line);
	}
	return line;
};
const allTurns = sessions.flatMap((session) => session.turns);
const baseRate = new Map<string, number>();
for (const turn of allTurns) if (turn.context <= tierLineOf(turn.model)) baseRate.set(turn.model, Math.max(baseRate.get(turn.model) ?? 0, turn.inputRate));
const tiered = allTurns.filter((turn) => turn.context > tierLineOf(turn.model) && turn.inputRate > (baseRate.get(turn.model) ?? Infinity));
const tieredByModel = new Map<string, { requests: number; cost: number }>();
for (const turn of tiered) {
	const row = tieredByModel.get(turn.model) ?? { requests: 0, cost: 0 };
	row.requests++;
	row.cost += turn.cost;
	tieredByModel.set(turn.model, row);
}

// ---------------------------------------------------------------------------
// 9. 任务完成质量与用户体验（省 token 不能伤及完成质量）
// ---------------------------------------------------------------------------

const FRUSTRATION_REGEX = /(上一轮|刚才|不对|怎么又|别再|不是让|做错了|还原|重来|为什么不|卡住|死循环|没按要求|报错了|恢复原样)/;
const RESTATEMENT_REGEX = /(再说一遍|重新说|我要的是|我刚才说的是|听我说|我的意思是|不是这个意思|按我说的做)/;
let totalUserPrompts = 0;
let frustrationPrompts = 0;
let restatementPrompts = 0;

const frustMaxEdits: number[] = [];
const smoothMaxEdits: number[] = [];

for (const session of sessions) {
	let isFrustSession = false;
	for (const u of session.userPrompts) {
		if (u.synthetic) continue;
		totalUserPrompts++;
		if (FRUSTRATION_REGEX.test(u.text)) {
			frustrationPrompts++;
			isFrustSession = true;
		}
		if (RESTATEMENT_REGEX.test(u.text)) restatementPrompts++;
	}
	if (session.fileEdits.size > 0) {
		const maxCount = Math.max(...session.fileEdits.values());
		if (isFrustSession) frustMaxEdits.push(maxCount);
		else smoothMaxEdits.push(maxCount);
	}
}

const avgMaxEdits = (arr: number[]) => (arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 0);
const frustAvgEdits = avgMaxEdits(frustMaxEdits);
const smoothAvgEdits = avgMaxEdits(smoothMaxEdits);
// 最近秩的 P90，只用来描述，不拿来当运行时的停止线。
const p90 = (values: number[]) => (values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1]! : 0);

// ---------------------------------------------------------------------------
// 10. 逐次请求的缓存未命中：本该命中而没命中多少、多花多少、为什么
//
// 第 8 节的累计占比只能说「整体还行」；前缀修复的验收要看这里没有正当理由的那几类：本地改了工具、提示词、历史，或前缀没变服务商
// 却没读到，它们指向前缀被打断的那一次请求。诊断是请求当时由 `diagnoseCache` 算好、和花销一起存下的（`miss_*` 那几列）；「应命中」
// 按同一会话上一次主请求的输入算，和它用的是同一个口径。不按猜的缓存有效期归类：隔了很久的未命中照样按前缀证据归，下面逐条列出
// 间隔，由人对照。
// ---------------------------------------------------------------------------

const CAUSES: readonly UsageCacheMissCause[] = ["compaction", "rewind", "model", "tools", "prompt", "rewrite", "provider", "unknown"];
const CAUSE_LABELS: Record<UsageCacheMissCause, string> = {
	compaction: "压缩后前缀重写",
	rewind: "撤回后重发",
	model: "换了模型或服务商",
	tools: "本地工具定义变了",
	prompt: "本地系统提示词变了",
	rewrite: "本地改写了已发出的消息",
	provider: "前缀未变，服务商没读到（清掉或已过期）",
	unknown: "原因不明（没有前缀记录，或变的是 thinking 这类参数）",
};
/** 没有正当理由的未命中：不是有意改写或换模型，是要去查的那几类。 */
const SUSPECT = new Set<UsageCacheMissCause>(["tools", "prompt", "rewrite", "provider", "unknown"]);

interface Diagnosed {
	row: SpendRow;
	/** 第几次主请求（这个会话里）。 */
	ordinal: number;
	expected: number;
	idleMs?: number;
}
const diagnosed: Diagnosed[] = [];
const lifetimeRequests: LifetimeRequest[] = [];
const previousOf = new Map<string, { row: SpendRow; ordinal: number }>();
for (const row of conversationRows) {
	const previous = row.session_id === null ? undefined : previousOf.get(row.session_id);
	const ordinal = (previous?.ordinal ?? 0) + 1;
	if (row.session_id !== null) previousOf.set(row.session_id, { row, ordinal });
	if (!previous) {
		diagnosed.push({ row, ordinal, expected: 0 });
		continue;
	}
	const expected = Math.min(previous.row.prompt!, row.prompt!);
	const idleMs = row.ts - previous.row.ts;
	diagnosed.push({ row, ordinal, expected, idleMs });
	if (previous.row.provider !== row.provider || previous.row.model !== row.model) continue;
	// 没记下原因又没读到缓存：这个模型在这个会话里从没报过缓存，判不了。
	const cause = row.miss_cause ?? (row.cache_read > 0 ? "hit" : undefined);
	if (cause) lifetimeRequests.push({ model: row.model, idleMs, expected, cause });
}
const cacheSummary = {
	requests: diagnosed.length,
	expected: diagnosed.reduce((sum, entry) => sum + entry.expected, 0),
	missed: diagnosed.reduce((sum, entry) => sum + (entry.row.miss_tokens ?? 0), 0),
	extraCost: diagnosed.reduce((sum, entry) => sum + (entry.row.miss_cost ?? 0), 0),
	unpricedMissed: diagnosed.reduce((sum, entry) => sum + (entry.row.miss_cost === null ? (entry.row.miss_tokens ?? 0) : 0), 0),
	byCause: Object.fromEntries(
		CAUSES.map((cause) => {
			const rows = diagnosed.filter((entry) => entry.row.miss_cause === cause);
			return [
				cause,
				{
					requests: rows.length,
					missed: rows.reduce((sum, entry) => sum + (entry.row.miss_tokens ?? 0), 0),
					extraCost: rows.reduce((sum, entry) => sum + (entry.row.miss_cost ?? 0), 0),
				},
			];
		}),
	) as Record<UsageCacheMissCause, { requests: number; missed: number; extraCost: number }>,
};
const cacheBySession = new Map<string, { id: string; requests: number; missed: number; extraCost: number; suspect: number; suspectMissed: number }>();
for (const { row } of diagnosed) {
	const id = row.session_id === null ? "(none)" : row.session_id.slice(0, 8);
	const entry = cacheBySession.get(id) ?? { id, requests: 0, missed: 0, extraCost: 0, suspect: 0, suspectMissed: 0 };
	entry.requests++;
	entry.missed += row.miss_tokens ?? 0;
	entry.extraCost += row.miss_cost ?? 0;
	if (row.miss_cause && SUSPECT.has(row.miss_cause)) {
		entry.suspect++;
		entry.suspectMissed += row.miss_tokens ?? 0;
	}
	cacheBySession.set(id, entry);
}
const worstSuspect = diagnosed
	.filter((entry) => entry.row.miss_cause && SUSPECT.has(entry.row.miss_cause))
	.sort((a, b) => (b.row.miss_tokens ?? 0) - (a.row.miss_tokens ?? 0))
	.slice(0, 10);

/** 那次请求的前缀指纹：回复还在会话里时从它上面读；撤回截掉、会话删了的就没有了。 */
function prefixOf(row: SpendRow) {
	const session = stored.find((entry) => entry.summary.id === row.session_id);
	const reply = session?.messages.find((message) => message.role === "assistant" && message.timestamp === row.ts);
	return reply?.role === "assistant" ? reply.prefix : undefined;
}

/** 本地前缀有没有变、变在哪：变了是本地改写，量过没变是服务商那边没读到，没量的分不清。 */
function prefixNote(row: SpendRow): string {
	const session = row.session_id === null ? undefined : summaries.get(row.session_id);
	if (!session) return "会话已删除";
	const prefix = prefixOf(row);
	if (!prefix) return "前缀未记录";
	if (!prefix.change) return "本地前缀未变";
	return `本地前缀变于 ${prefix.change.segment}（${prefix.change.before}→${prefix.change.after} 字符）`;
}

// ---------------------------------------------------------------------------
// 11–12. 压缩：让人干等了多久，摘要是怎么来的
//
// 转录里那一行压缩（`CompactionRun`）记着开始的时刻；写下边界的那次压缩（`Compaction.at`）记着完成的时刻，两者按「开始时会话有
// 几条消息」对上。一轮里自动触发的会让这一轮停下来等它；一轮收尾以后、人还没开口时压的（`idle`）和人敲的 `/compact` 不挡这一轮。
// ---------------------------------------------------------------------------

type CompactionKind = "automatic" | "idle" | "manual";
const compactionKind = (run: CompactionRun): CompactionKind => (run.input !== undefined ? "manual" : run.idle ? "idle" : "automatic");
const compactionRuns = sessions.flatMap((session) =>
	session.runs.map((run) => {
		const written = run.code === "done" ? session.compactions.find((compaction) => compaction.count === run.at && compaction.at >= run.startedAt) : undefined;
		return { run, kind: compactionKind(run), ...(written ? { ms: written.at - run.startedAt } : {}) };
	}),
);
const compactionStats = (kind: CompactionKind) => {
	const runs = compactionRuns.filter((entry) => entry.kind === kind);
	const ms = runs.flatMap((entry) => (entry.ms === undefined ? [] : [entry.ms])).sort((a, b) => a - b);
	return {
		count: ms.length,
		p50Ms: ms.length ? ms[Math.ceil(ms.length / 2) - 1]! : 0,
		p90Ms: p90(ms),
		maxMs: ms.at(-1) ?? 0,
		totalMs: ms.reduce((a, b) => a + b, 0),
		unfinished: runs.filter((entry) => entry.run.status === "failed" || entry.run.status === "cancelled").length,
	};
};
const blockingCompactions = compactionStats("automatic");
const idleCompactions = compactionStats("idle");
const manualCompactions = compactionStats("manual");
const VIA_ORDER = ["fork", "independent", "fallback", "dropped"] as const;
const byVia = Object.fromEntries(VIA_ORDER.map((via) => [via, compactionRuns.filter((entry) => entry.run.code === "done" && entry.run.via === via).length]));
const byCode: Record<string, number> = {};
for (const { run } of compactionRuns) byCode[run.code ?? run.status] = (byCode[run.code ?? run.status] ?? 0) + 1;

const folded = afterCompaction(
	sessions.map((session) => {
		const results = new Map(session.calls.map((call) => [call.id, charsOf(call.result)]));
		return { messages: session.messages, calls: session.calls, boundaries: session.boundaries, resultChars: (id: string) => results.get(id) ?? 0 };
	}),
);
const lifetime = [...cacheLifetime(lifetimeRequests)].sort(([a], [b]) => a.localeCompare(b));
const peers = peerStats(sessions.map((session) => ({ calls: session.peerCalls, arrivals: session.peerArrivals })));

/*
 * 样本太薄时先说出来，写在 stderr，不进 `--json` 的输出。只有一两个会话时改前改后的输出逐字节相同，看上去是「行为没变」的有力
 * 证据，其实只是十几轮对话没碰到改动的那几条路。数字只在样本够多时才说明问题。
 */
const THIN_SAMPLE = 10;
const allRounds = sessions.reduce((n, s) => n + s.rounds, 0);
if (sessions.length < THIN_SAMPLE) {
	console.error(`⚠ 只读到 ${sessions.length} 个会话、${allRounds} 轮：前后两次一致说明不了多少，结论要打折扣。`);
}

const tools = [...byTool.entries()].sort((a, b) => b[1].carried - a[1].carried);
const countKinds = (kind: SessionKind) => sessions.filter((session) => session.kind === kind).length;

if (asJson) {
	console.log(
		JSON.stringify(
			{
				sessions: sessions.length,
				byKind: { main: countKinds("main"), child: countKinds("child"), standalone: countKinds("standalone") },
				rounds: allRounds,
				totalTokens: tk(allChars),
				totalCarried: tk(allCarried),
				tools: Object.fromEntries(tools.map(([name, v]) => [name, { calls: v.n, tokens: tk(v.chars), carried: tk(v.carried) }])),
				read: {
					calls: readCalls,
					tokens: tk(readChars),
					reread: rereadCalls,
					rereadTokens: tk(rereadChars),
					identical: identicalCalls,
					identicalTokens: tk(identicalChars),
					outlined: outlinedReads,
					rangedAfterOutline,
					editsOk,
					readAfterEdit,
				},
				repetition: { warns, corrected, savedTokens: tk(correctedChars), wouldStop },
				pruneGain: Object.fromEntries(
					DELAYS.map((n) => [`delay${n}`, { carried: tk(curve.get(n)!), savedShare: share(allCarried - curve.get(n)!, allCarried) }]),
				),
				stops: Object.fromEntries(stopKinds),
				endedWith: Object.fromEntries(endedWith),
				lastStops: Object.fromEntries(lastStops),
				parallelism: {
					callsPerTurn: parTurns ? +(parCalls / parTurns).toFixed(3) : 0,
					parallelShare: share(parMulti, parTurns),
					blockedTurns,
					byModel: Object.fromEntries(
						[...byModel.entries()].map(([name, v]) => [
							name,
							{ turns: v.turns, calls: v.calls, perTurn: +(v.calls / v.turns).toFixed(3), parallelShare: share(v.parallel, v.turns) },
						]),
					),
				},
				spend: {
					rawInput,
					cacheRead,
					cacheWrite,
					output,
					cost: +cost.toFixed(2),
					cacheReadShare: share(cacheRead, billed),
					cacheWriteShare: share(cacheWrite, billed),
					bySource: Object.fromEntries(Object.entries(spendBy).map(([source, value]) => [source, +value.toFixed(2)])),
					byContext: contextSpend.map((row) => ({
						from: row.from,
						to: row.to === Infinity ? null : row.to,
						requests: row.requests,
						cost: +row.cost.toFixed(2),
					})),
					tiered: {
						requests: tiered.length,
						cost: +tiered.reduce((sum, turn) => sum + turn.cost, 0).toFixed(2),
						byModel: Object.fromEntries([...tieredByModel].map(([model, row]) => [model, { requests: row.requests, cost: +row.cost.toFixed(2) }])),
					},
					children: Object.fromEntries(
						[...childSpend].map(([owner, row]) => [owner, { sessions: row.sessions.size, requests: row.requests, cost: +row.cost.toFixed(2) }]),
					),
				},
				quality: {
					totalUserPrompts,
					frustrationPrompts,
					restatementPrompts,
					frustrationRate: share(frustrationPrompts, totalUserPrompts),
					restatementRate: share(restatementPrompts, totalUserPrompts),
					frustAvgMaxEdits: frustAvgEdits,
					smoothAvgMaxEdits: smoothAvgEdits,
					frustP90MaxEdits: p90(frustMaxEdits),
					smoothP90MaxEdits: p90(smoothMaxEdits),
					frustSessions: frustMaxEdits.length,
					smoothSessions: smoothMaxEdits.length,
					classification: "Uncalibrated keyword proxy, not a task-success metric",
				},
				peers,
				compactions: { automatic: blockingCompactions, idle: idleCompactions, manual: manualCompactions, byVia, byCode },
				afterCompaction: { ...folded, foldedRereadChars: undefined, foldedRereadTokens: tk(folded.foldedRereadChars) },
				cacheLifetime: Object.fromEntries(
					lifetime.map(([model, cells]) => [model, Object.fromEntries(LIFETIME_BUCKETS.map((bucket, i) => [bucket.label, cells[i]]))]),
				),
				cacheMisses: {
					requests: cacheSummary.requests,
					expected: cacheSummary.expected,
					missed: cacheSummary.missed,
					extraCost: +cacheSummary.extraCost.toFixed(4),
					unpricedMissed: cacheSummary.unpricedMissed,
					byCause: Object.fromEntries(
						CAUSES.map((cause) => [cause, { ...cacheSummary.byCause[cause], extraCost: +cacheSummary.byCause[cause].extraCost.toFixed(4) }]),
					),
					bySession: [...cacheBySession.values()].map((row) => ({ ...row, extraCost: +row.extraCost.toFixed(4) })),
					worstSuspect: worstSuspect.map(({ row, ordinal, expected, idleMs }) => ({
						session: row.session_id?.slice(0, 8) ?? null,
						request: ordinal,
						missed: row.miss_tokens,
						expected,
						idleMs,
						model: row.model,
						cause: row.miss_cause,
						prefix: prefixOf(row),
					})),
				},
			},
			null,
			2,
		),
	);
	process.exit(0);
}

console.log(
	`会话 ${sessions.length} 个（主会话 ${countKinds("main")}、子会话 ${countKinds("child")}、插件独立会话 ${countKinds("standalone")}），助手回合 ${allRounds} 次\n`,
);

console.log("── 1. 工具结果的一次性体积，与它的携带成本 ──");
console.log(`合计 ${tk(allChars).toLocaleString()} token，携带 ${(tk(allCarried) / 1e6).toFixed(0)}M token·轮\n`);
console.log("工具            次数     token    平均   携带(token·轮)   占比");
for (const [name, v] of tools.slice(0, 12))
	console.log(
		`${name.padEnd(14)} ${pad(v.n, 5)}  ${pad(tk(v.chars).toLocaleString(), 9)}  ${pad(tk(v.chars / v.n), 6)}  ` +
			`${pad(`${(tk(v.carried) / 1e6).toFixed(1)}M`, 13)}  ${pad(share(v.carried, allCarried), 6)}`,
	);

console.log("\n── 2. 单条最贵：体积 × 之后还要重发多少轮 ──");
for (const item of biggest.sort((a, b) => b.carried - a.carried).slice(0, 10))
	console.log(
		`  ${item.session} ${item.tool.padEnd(7)} ${pad(tk(item.chars).toLocaleString(), 8)} token × 之后${pad(item.after, 4)}轮 ` +
			`= ${pad(`${(tk(item.carried) / 1e6).toFixed(0)}M`, 5)}  ${item.args}`,
	);

console.log("\n── 3. read 的重复 ──");
console.log(`  ${readCalls} 次 / ${tk(readChars).toLocaleString()} token`);
console.log(`  这个 path 之前读过：${rereadCalls} 次 (${share(rereadCalls, readCalls)})，${tk(rereadChars).toLocaleString()} token —— 改过再读是正常的`);
console.log(`  参数一字不差：      ${identicalCalls} 次 (${share(identicalCalls, readCalls)})，${tk(identicalChars).toLocaleString()} token —— 这些是纯重复`);
console.log(
	`  折叠成结构视图：    ${outlinedReads} 次，之后又按段读同一文件 ${rangedAfterOutline} 次` +
		`（平均 ${outlinedReads ? (rangedAfterOutline / outlinedReads).toFixed(1) : "0"} 次）`,
);
console.log(`  edit 成功后下一步就是重读同一文件：${readAfterEdit} / ${editsOk} 次 (${share(readAfterEdit, editsOk)})`);

console.log("\n── 4. 重复检测这条闸门 ──");
console.log(`  提醒（精确重复、翻页、切图测距合计）：${warns} 次`);
console.log(`  改写成「第 N 次」的结果：${corrected} 条，省下 ${tk(correctedChars).toLocaleString()} token (${share(correctedChars, allChars)})`);
console.log(`  会被 exhausted() 停掉的会话：${wouldStop} 个；实际被叫停（stalled）的：${lastStops.get("stalled") ?? 0} 个（只看最后一轮）`);
if (wouldStop === 0) console.log("  ⚠ 一个都没有 —— 这条停止线在这批数据上是死的");

console.log("\n── 5. 提前裁剪超大结果能省多少 ──");
console.log(
	`  超过 ${PRUNE_THRESHOLD_CHARS} 字符的结果：${bigCount}/${allCount} 条 (${share(bigCount, allCount)})，却占携带成本的 ${share(bigCarried, allCarried)}`,
);
for (const n of DELAYS)
	console.log(
		`  产生 ${pad(n, 2)} 轮后就裁：剩 ${pad(`${(tk(curve.get(n)!) / 1e6).toFixed(0)}M`, 5)} token·轮，省 ${share(allCarried - curve.get(n)!, allCarried)}`,
	);

console.log("\n── 6. 回合怎么结束的 ──");
console.log(`  全部助手回合：${[...stopKinds].map(([k, v]) => `${k} ${v}`).join("，")}`);
console.log(`  会话的最后一个：${[...endedWith].map(([k, v]) => `${k} ${v}`).join("，")}`);
console.log(`  会话最后一轮的结束原因（SessionSummary.stop）：${[...lastStops].map(([k, v]) => `${k} ${v}`).join("，") || "没有"}`);
console.log(
	`  记着结束原因的会话：${sessions.filter((session) => session.lastStop).length}/${sessions.length}；没记的是正在跑或进程没来得及记下，不由 stopReason 猜。`,
);

console.log("\n── 7. 并行度：一个回合发几个调用（这是「慢」，不是「贵」） ──");
console.log(`  总体 ${parTurns ? (parCalls / parTurns).toFixed(2) : "0"} 个/轮，并行率 ${share(parMulti, parTurns)}`);
console.log("  模型                        有工具的轮次    调用    每轮    并行率");
for (const [name, v] of [...byModel.entries()].sort((a, b) => b[1].turns - a[1].turns).slice(0, 8))
	console.log(
		`  ${name.slice(0, 26).padEnd(26)} ${pad(v.turns, 9)} ${pad(v.calls, 8)}  ${pad((v.calls / v.turns).toFixed(2), 6)}  ${pad(share(v.parallel, v.turns), 7)}`,
	);
console.log(`  若把总体提到 5 个/轮：${parCalls} 次调用只需 ${Math.ceil(parCalls / 5)} 轮（现在 ${parTurns} 轮）`);
console.log(`  被改道挡回、白费一整轮的 bash：${blockedTurns} 次`);

console.log("\n── 8. 缓存与花销 ──");
console.log(
	`  计费 token：未命中 ${rawInput.toLocaleString()}｜cacheRead ${cacheRead.toLocaleString()}｜cacheWrite ${cacheWrite.toLocaleString()}｜输出 ${output.toLocaleString()}`,
);
console.log(`  cacheRead 占输入侧 ${share(cacheRead, billed)}，cacheWrite 占 ${share(cacheWrite, billed)}`);
console.log(
	`  记录在案的花销合计 $${cost.toFixed(2)}：主会话 $${spendBy.main.toFixed(2)}｜子会话 $${spendBy.child.toFixed(2)} (${share(spendBy.child, cost)})｜` +
		`辅助请求 $${spendBy.aux.toFixed(2)}｜已删除会话 $${spendBy.deleted.toFixed(2)}`,
);
console.log("  按每次请求带的上下文分桶（会话里的主请求，含子会话）：");
const allRequests = contextSpend.reduce((sum, row) => sum + row.requests, 0);
const replyCost = contextSpend.reduce((sum, row) => sum + row.cost, 0);
for (const row of contextSpend)
	console.log(
		`    ${pad(`${row.from / 1000}k–${row.to === Infinity ? "" : `${row.to / 1000}k`}`, 10)}  ${pad(row.requests, 5)} 次 (${pad(share(row.requests, allRequests), 6)})  $${pad(row.cost.toFixed(2), 7)} (${share(row.cost, replyCost)})`,
	);
console.log(
	`  越过价格分档线、按高一档计费的请求：${tiered.length} 次，$${tiered.reduce((sum, turn) => sum + turn.cost, 0).toFixed(2)}` +
		(tiered.length ? `（${[...tieredByModel].map(([model, row]) => `${model} ${row.requests} 次`).join("，")}）` : ""),
);
if (childSpend.size) {
	console.log("  子会话、插件独立会话按建它的插件：");
	for (const [owner, row] of [...childSpend].sort((a, b) => b[1].cost - a[1].cost))
		console.log(
			`    ${owner.padEnd(18)} ${pad(row.sessions.size, 3)} 个  ${pad(row.requests, 5)} 次请求  $${pad(row.cost.toFixed(2), 7)}  每个 $${(row.cost / row.sessions.size).toFixed(2)}`,
		);
}
if (cacheWrite === 0) console.log("  ⚠ cacheWrite 恒为 0：OpenAI 的 Chat Completions、Responses 两条链路都不上报它，所以它不能用作验收指标。");
console.log(`  ⚠ 看 cacheRead 占比（现在 ${share(cacheRead, billed)}）：改动后它明显下降 = 前缀缓存被反复打断，八成是把裁剪写成了「每轮都改历史」。`);
console.log(`  ⚠ 携带成本（第 1 节）里有 ${share(cacheRead, billed)} 是缓存命中的，单价约为未命中的十分之一。`);
console.log("    所以省下的 token 量 ≠ 省下的钱，裁剪的收益要按这个比例打折，以本节的 $ 为准。");

console.log("\n── 9. 完成质量与用户体验 ──");
console.log(
	`  用户发言：真实输入 ${totalUserPrompts} 条，含挫败信号 ${frustrationPrompts} 条 (${share(frustrationPrompts, totalUserPrompts)})，` +
		`含需求重述 ${restatementPrompts} 条 (${share(restatementPrompts, totalUserPrompts)})`,
);
console.log(`  单文件最大修改均值：顺利组 ${smoothAvgEdits} 次 vs 挫败组 ${frustAvgEdits} 次（纯事后观测，不在运行时据此打断）`);
console.log(
	`  单文件最大修改 P90：顺利组 ${p90(smoothMaxEdits)}（n=${smoothMaxEdits.length}），挫败组 ${p90(frustMaxEdits)}（n=${frustMaxEdits.length}）。关键词分类没校准过，不等于任务成没成。`,
);

console.log("\n── 10. 逐次请求的缓存未命中（前缀修复验收看这里） ──");
console.log(`  会话里的主请求 ${cacheSummary.requests} 次；按同一会话上一次请求的输入算，应命中 ${cacheSummary.expected.toLocaleString()} token`);
console.log(
	`  本该命中而没命中：${cacheSummary.missed.toLocaleString()} token (${share(cacheSummary.missed, cacheSummary.expected)})，多花 $${cacheSummary.extraCost.toFixed(4)}` +
		(cacheSummary.unpricedMissed ? `（另有 ${cacheSummary.unpricedMissed.toLocaleString()} token 的模型没配价格，算不出钱）` : ""),
);
console.log("      次数    未命中 token        多花  原因");
for (const cause of CAUSES) {
	const v = cacheSummary.byCause[cause];
	if (v.requests === 0) continue;
	console.log(`  ${pad(v.requests, 8)}  ${pad(v.missed.toLocaleString(), 14)}  ${pad(`$${v.extraCost.toFixed(4)}`, 10)}  ${CAUSE_LABELS[cause]}`);
}
console.log(`  （未命中 ≤ ${CACHE_NOISE_FLOOR_TOKENS} token 算粒度噪声、记为命中；本地改动、服务商没读到和原因不明是前缀被打断的嫌疑）`);
const sessionsWithMiss = [...cacheBySession.values()].filter((row) => row.missed > 0).sort((a, b) => b.missed - a.missed);
if (sessionsWithMiss.length) {
	console.log("  未命中最多的会话：");
	for (const row of sessionsWithMiss.slice(0, 8))
		console.log(
			`    ${row.id}  未命中 ${pad(row.missed.toLocaleString(), 12)} token  多花 $${row.extraCost.toFixed(4)}  ` +
				`其中要查的 ${row.suspect} 次 / ${row.suspectMissed.toLocaleString()} token`,
		);
}
if (worstSuspect.length) {
	console.log("  要查的未命中里最严重的几次（同一模型、中间没有压缩或撤回，前缀却没读到；间隔长的可能只是缓存过期）：");
	for (const { row, ordinal, expected, idleMs } of worstSuspect)
		console.log(
			`    ${(row.session_id?.slice(0, 8) ?? "(none)").padEnd(8)} 第 ${pad(ordinal, 4)} 次请求  未命中 ${pad((row.miss_tokens ?? 0).toLocaleString(), 10)} / 应命中 ${pad(expected.toLocaleString(), 10)}  ` +
				`间隔 ${pad(Math.round((idleMs ?? 0) / 1000), 5)}s  ${row.model}  ${CAUSE_LABELS[row.miss_cause!]}  ${prefixNote(row)}`,
		);
} else console.log("  没有要查的未命中。");

console.log("\n── 11. 压缩让人干等了多久（后台压缩值不值得做看这里） ──");
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
for (const [label, v] of [
	["一轮里自动触发（这一轮停下来等它）", blockingCompactions],
	["一轮收尾以后自动压的", idleCompactions],
	["手动 /compact", manualCompactions],
] as const) {
	if (v.count === 0 && v.unfinished === 0) {
		console.log(`  ${label}：没有`);
		continue;
	}
	console.log(
		`  ${label}：完成 ${v.count} 次，p50 ${seconds(v.p50Ms)}，p90 ${seconds(v.p90Ms)}，最长 ${seconds(v.maxMs)}，合计 ${seconds(v.totalMs)}；失败或取消 ${v.unfinished} 次`,
	);
}
if (blockingCompactions.count === 0) console.log("  ⚠ 只有一轮里自动触发的那种在挡路，这批会话里没有。");
else if (blockingCompactions.p90Ms < BLOCKING_COMPACTION_MS)
	console.log(`  ⚠ 只有一轮里自动触发的那种在挡路。p90 只有 ${seconds(blockingCompactions.p90Ms)}，挪到一轮收尾以后做省不下多少等待。`);
else
	console.log(
		`  ⚠ 只有一轮里自动触发的那种在挡路：p90 ${seconds(blockingCompactions.p90Ms)}、合计 ${seconds(blockingCompactions.totalMs)}，人真的在等，值得看能不能挪到一轮收尾以后做。`,
	);

console.log("\n── 12. 压缩的摘要是怎么来的 ──");
const VIA_LABELS: Record<(typeof VIA_ORDER)[number], string> = { fork: "分叉", independent: "独立请求", fallback: "本地兜底", dropped: "按条丢弃" };
console.log(`  写下边界的：${VIA_ORDER.map((via) => `${VIA_LABELS[via]} ${byVia[via]}`).join("，")}`);
console.log(
	`  每次压缩的结果：${
		Object.entries(byCode)
			.map(([code, n]) => `${code} ${n}`)
			.join("，") || "没有"
	}`,
);
console.log(`  ⚠ 分叉沿用上一次主请求的前缀，只在缓存还热时走（FORK_HOT_MS = ${seconds(FORK_HOT_MS)}）；「本地兜底」多说明摘要请求常失败。`);
console.log("    摘要请求的花销在第 8 节的辅助请求里：花销表不记一次非主请求是哪个插件发的，分不出哪几次是摘要。");

console.log("\n── 13. 压缩之后（摘要丢了多少看这里） ──");
if (folded.boundaries === 0) console.log("  没有写下过边界的压缩。");
else {
	console.log(
		`  写下边界 ${folded.boundaries} 次；保留的尾部中位 ${folded.keptMedian} 条、约 ${folded.tailTokensMedian.toLocaleString()} token，最少 ${folded.keptMin} 条，少于 ${KEEP_MIN} 条的 ${folded.keptBelowMin} 次`,
	);
	console.log(
		`  压缩后到下一次压缩前：read ${folded.reads} 次，其中重读折叠掉的、期间没改过的文件 ${folded.foldedRereads} 次 / ${tk(folded.foldedRereadChars).toLocaleString()} token；recall ${folded.recalls} 次`,
	);
	console.log(
		`  压缩后用户发言 ${folded.userAfter} 条，其中提到「之前说过」或把折叠掉的原话又说了一遍 ${folded.repeatedAfter} 条 (${share(folded.repeatedAfter, folded.userAfter)})`,
	);
}
console.log(`  ⚠ 少于 ${KEEP_MIN} 条说明保留尾部被删过了头；折叠后重读多而 recall 少，说明摘要没让模型确信它已经读过；用户重说的多，说明丢的是找不回的东西。`);

console.log("\n── 14. 缓存隔多久还读得到（分叉摘要的「缓存还热」那条线看这里） ──");
if (lifetime.length === 0) console.log("  没有可判断的请求。");
else {
	console.log(`  模型                            ${LIFETIME_BUCKETS.map((bucket) => bucket.label.padStart(12)).join("")}`);
	for (const [model, cells] of lifetime)
		console.log(
			`  ${model.slice(0, 30).padEnd(30)}  ${cells.map((cell) => pad(cell.hit + cell.lost + cell.unproven ? `${cell.hit}/${cell.hit + cell.lost + cell.unproven}` : "·", 12)).join("")}`,
		);
}
console.log("  每格是「命中 / 本该命中」：只数前缀有理由命中的请求，压缩、撤回、换模型和本地改写不算。");
console.log(`  ⚠ ${+(FORK_HOT_MS / 60_000).toFixed(1)}m 之后那几格仍然稳定命中的上游，分叉的时限才值得为它放宽。`);

console.log("\n── 15. 会话之间的消息 ──");
const counts = (map: Record<string, number>) =>
	Object.entries(map)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k} ${v}`)
		.join("，") || "没有";
console.log(`  有往来的会话 ${peers.involvedSessions} 个；工具调用：${counts(peers.calls)}`);
console.log(`  寄信的结果（ask、reply、notify）：${counts(peers.outcomes)}`);
console.log(`  收到的信：${counts(peers.letters)}；插进正在跑的那一轮 ${peers.arrivals.steered} 条，为它开一轮 ${peers.arrivals.opened} 条`);
console.log(`  有往来的会话平均每个发通知 ${peers.noticesPerInvolvedSession} 条`);
console.log("  ⚠ 问成没成看 answer:replied 占 request 的比例；answer:unreplied 多说明对方常忘了 reply_session，refused 多说明地址或限速挡得多。");
