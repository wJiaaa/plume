/**
 * 一次压缩从问到记：经钩子 context.compact 问插件（内置插件 plume.compaction 决定压不压、怎么压），把结论记进会话的压缩账
 * （`compaction.ts`），转录里那一行压缩（`CompactionRun`）跟着它走：开始、写摘要、等重试、本地整理、收场。
 *
 * 三处发起：循环每次请求前（太满了、或服务商说超长）、人敲的 `/compact`、一轮干净收尾以后（缓存还热时先压掉）。
 * 怎么记账只有这一条路，三处只是给的 `CompactMode` 不同。
 */

import { randomUUID } from "node:crypto";
import type {
	AgentEvent,
	CompactionMark,
	CompactionOutcome,
	CompactionRun,
	CompactSummary,
	ContextCompact,
	Log,
	Message,
	ModelContext,
	SessionSummary,
	ToolResultView,
} from "@plume/contract";
import type { PrefixSegment } from "@plume/llm/prefix-fingerprint";
import type { ModelConfig, ProviderConfig, ThinkingLevel, ToolSpec } from "@plume/llm/types";
import { cacheHotMs } from "@plume/llm/vendors";
import { type ContextRecord, historyFor, latest, oversized } from "./compaction.ts";
import { errorText, type PluginHost } from "./host.ts";
import { sessionScope } from "./session-scope.ts";

/**
 * 上一次真正发出去的主请求：摘要从这里分叉（`ModelCompletion.fork`）。请求头原样记下，分叉只往后接消息：照着主请求
 * 「再拼一份」是拼不准的，差一个工具、换一块系统提示词，前缀就从头对不上。只在内存里：重开应用后缓存也早凉了。
 */
export interface SentRequest {
	/** `ModelConfig.id`。 */
	model: string;
	systemPrompt: string;
	tools: ToolSpec[];
	thinking: ThinkingLevel;
	maxTokens: number;
	cacheKey: string;
	/** 开始发送的时刻：缓存在读前缀时续期，从这里起算它还热不热。 */
	at: number;
	/** 那次请求体的分段指纹，分叉前核对前缀用。 */
	segments?: PrefixSegment[];
}

/** 压缩要读写的那点会话状态。 */
export interface CompactingSession {
	summary: SessionSummary;
	record?: ContextRecord;
	compacting?: boolean;
	sent?: SentRequest;
}

/**
 * 这一次是谁发起的。`force`：不看有多满（超长恢复、`/compact`）。`fork`：可以从上一次主请求分叉（超长恢复不行：
 * 完整历史本来就放不下）。
 */
export interface CompactMode {
	force: boolean;
	fork: boolean;
	manual?: { instructions: string };
	idle?: boolean;
}

export interface CompactorDeps {
	host: PluginHost;
	log: Log;
	emit(event: AgentEvent): void;
	saveContext(sessionId: string, record: ContextRecord): void;
	messagesOf(session: CompactingSession): Promise<Message[]>;
	recordOf(session: CompactingSession): Promise<ContextRecord>;
	model(session: CompactingSession): Promise<{ provider: ProviderConfig; model: ModelConfig }>;
	/** 历史实际缩短或工具结果被裁剪并保存后调用；装配方重置依赖旧历史的循环状态。 */
	onCompacted?(session: CompactingSession): void;
}

export function marks(record: ContextRecord | undefined): CompactionMark[] {
	return (record?.compactions ?? []).map(({ keptFrom, before, after }) => ({ keptFrom, before, after }));
}

export function runsOf(record: ContextRecord | undefined): CompactionRun[] {
	return record?.runs ?? [];
}

/** 从库里读回来时还标着「进行中」的行：那次压缩随进程一起没了，说成被中断。 */
export function settleStaleRuns(record: ContextRecord): ContextRecord {
	if (!record.runs?.some((run) => run.status === "running")) return record;
	return { ...record, runs: record.runs.map((run) => (run.status === "running" ? { ...run, status: "cancelled", code: "cancelled" } : run)) };
}

/** 对话短到这样，没什么可压的：留下的尾部至少四条，再加两条摘要头就和原来一样长了。 */
const TOO_SHORT = 6;

export function createCompactor(deps: CompactorDeps) {
	const { host, log, emit } = deps;

	function changed(session: CompactingSession): void {
		emit({
			type: "compaction",
			sessionId: session.summary.id,
			compacting: session.compacting === true,
			compactions: marks(session.record),
			runs: runsOf(session.record),
		});
	}

	/**
	 * 问插件要不要压、压了记下来。返回这一次的结果；`compacted` 是历史变了（循环据此重组上下文）。
	 * 失败只记在那一行上：循环接着发这一步（超长了由超长恢复兜着），`/compact` 把原因交给人。
	 */
	async function compact(
		session: CompactingSession,
		context: ModelContext,
		mode: CompactMode,
		signal: AbortSignal,
	): Promise<{ compacted: boolean; outcome: CompactionOutcome }> {
		const sessionId = session.summary.id;
		const { provider, model } = await deps.model(session);
		const messages = await deps.messagesOf(session);
		const record = await deps.recordOf(session);
		const previous = latest(record, messages);
		const history = historyFor(messages, record);
		// 历史里上一次换上的头占了前面几条，之后的和会话里从边界起的一一对应。
		const head = history.length - (messages.length - (previous?.keptFrom ?? 0));

		let run: CompactionRun | undefined;
		const put = (next: CompactionRun) => {
			run = next;
			const runs = record.runs ?? [];
			const at = runs.findIndex((each) => each.id === next.id);
			record.runs = at < 0 ? [...runs, next] : runs.map((each, index) => (index === at ? next : each));
			changed(session);
		};
		// 自动压缩定下要压（插件第一次报进度）才画那一行：没压的那些请求前检查不该在转录里留下什么。
		const open = (): CompactionRun => {
			if (run) return run;
			session.compacting = true;
			const created: CompactionRun = {
				id: randomUUID(),
				at: messages.length,
				startedAt: Date.now(),
				status: "running",
				phase: "summarizing",
				retries: 0,
				...(mode.manual ? { input: `/compact${mode.manual.instructions ? ` ${mode.manual.instructions}` : ""}` } : {}),
				...(mode.idle ? { idle: true } : {}),
			};
			put(created);
			return created;
		};
		const settle = (patch: Partial<CompactionRun>, show: boolean) => {
			if (!run && !show) return;
			const current = open();
			session.compacting = false;
			put({ ...current, ...patch });
		};
		const finish = (outcome: CompactionOutcome, compacted: boolean) => {
			deps.saveContext(sessionId, record);
			if (compacted) {
				host.sessionContextReset(sessionId);
				deps.onCompacted?.(session);
			}
			if (session.compacting) {
				session.compacting = false;
				changed(session);
			}
			return { compacted, outcome };
		};
		if (mode.manual) open();

		if (mode.manual && history.length <= TOO_SHORT) {
			settle({ status: "skipped", code: "too-short" }, true);
			return finish({ ok: false, code: "too-short" }, false);
		}

		const sent = session.sent;
		const lineage =
			mode.fork && sent && sent.model === model.id
				? { model: sent.model, at: sent.at, ...withHot(cacheHotMs(provider.baseUrl, model.modelId || model.id)) }
				: undefined;
		const tierLines = (model.pricing?.tiers ?? []).map((tier) => tier.aboveTokens).sort((a, b) => a - b);
		// 历史最近一次被改写：上一次压缩完成的时刻和最近一次剪枝（`viewsAt`）里晚的那个。
		const rewritten = Math.max(previous?.at ?? -Infinity, record.viewsAt ?? -Infinity);
		const rewrittenAt = Number.isFinite(rewritten) ? rewritten : undefined;
		const input: ContextCompact = {
			sessionId,
			session: sessionScope(session.summary),
			cwd: session.summary.cwd,
			model: {
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				maxOutputTokens: model.maxOutputTokens,
				...(tierLines.length > 0 ? { tierLines } : {}),
			},
			history: structuredClone(history),
			...(previous ? { previous: { head } } : {}),
			...(rewrittenAt !== undefined ? { rewrittenAt } : {}),
			request: { systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools },
			force: mode.force,
			...(mode.manual ? { manual: { instructions: mode.manual.instructions } } : {}),
			...(mode.idle ? { idle: true } : {}),
			...(lineage ? { lineage } : {}),
			signal,
			progress: (event) => {
				if (signal.aborted) return;
				const current = open();
				const phase = event?.phase === "retrying" || event?.phase === "fallback" ? event.phase : "summarizing";
				put({ ...current, phase, retries: current.retries + (phase === "retrying" ? 1 : 0) });
			},
		};

		let result: CompactSummary;
		try {
			result = await host.run("context.compact", input, async () => undefined);
		} catch (error) {
			if (signal.aborted) {
				settle({ status: "cancelled", code: "cancelled" }, mode.manual !== undefined);
				return finish({ ok: false, code: "cancelled" }, false);
			}
			log("agent", "error", `会话 ${sessionId} 压缩失败：${errorText(error)}`);
			settle({ status: "failed", code: "failed", error: errorText(error) }, true);
			return finish({ ok: false, code: "failed", error: errorText(error) }, false);
		}
		if (signal.aborted) {
			settle({ status: "cancelled", code: "cancelled" }, mode.manual !== undefined);
			return finish({ ok: false, code: "cancelled" }, false);
		}

		if (result === undefined) {
			// 自动压缩已经开了那一行（定下要压了）却没压成：说出来，不然那一行一直挂着。
			settle(mode.manual ? { status: "skipped", code: "already-tight" } : { status: "failed", code: "already-tight" }, mode.manual !== undefined);
			return finish({ ok: false, code: "already-tight" }, false);
		}

		const tail = new Set(history.slice(head).flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));
		if ("pruneOnly" in result && result.pruneOnly === true) {
			const previousViews = record.views;
			// i18n-exempt：invalid() 的理由只进日志。
			if (!adoptViews(record, result.views, tail)) return invalid(`context.compact 给的剪枝视图对不上历史里的工具结果`);
			settle({ status: mode.manual ? "skipped" : "done", code: "prune-only", before: history.length, after: history.length }, mode.manual !== undefined);
			return finish({ ok: false, code: "prune-only" }, record.views !== previousViews);
		}

		const { keep, summary, head: given, via, views } = result as Exclude<CompactSummary, undefined | { pruneOnly: true }>;
		const replacement = validHead(given);
		if (
			!Number.isInteger(keep) ||
			keep <= head ||
			keep >= history.length ||
			history[keep]?.role === "toolResult" ||
			typeof summary !== "string" ||
			!replacement ||
			(!summary.trim() && via !== "dropped")
		) {
			// i18n-exempt：invalid() 的理由只进日志。
			return invalid(`context.compact 给的边界（${String(keep)}）会拆开历史，或者头、摘要不对`);
		}
		const kept = new Set(history.slice(keep).flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));
		// i18n-exempt：invalid() 的理由只进日志。
		if (views !== undefined && !adoptViews(record, views, kept)) return invalid(`context.compact 给的剪枝视图对不上留下的工具结果`);
		const keptFrom = keep - head + (previous?.keptFrom ?? 0);
		const after = history.length - keep + replacement.length;
		record.compactions.push({
			at: Date.now(),
			keptFrom,
			keptStamp: (messages[keptFrom] as Message).timestamp,
			count: messages.length,
			summary: summary.trim(),
			head: replacement,
			...(isVia(via) ? { via } : {}),
			before: history.length,
			after,
		});
		settle({ status: "done", code: "done", before: history.length, after, ...(isVia(via) ? { via } : {}) }, mode.manual !== undefined);
		return finish({ ok: true, before: history.length, after }, true);

		function invalid(reason: string) {
			log("agent", "error", `会话 ${sessionId} 压缩失败：${reason}`);
			settle({ status: "failed", code: "failed" }, true);
			return finish({ ok: false, code: "failed" }, false);
		}
	}

	/** 服务商拒收以后，把发给模型的历史里过大的工具结果剪成一行，记下来，重启以后照样剪着。剪了返回 true。 */
	async function withhold(session: CompactingSession): Promise<boolean> {
		const record = await deps.recordOf(session);
		const ids = oversized(historyFor(await deps.messagesOf(session), record), record);
		if (ids.length === 0) return false;
		record.withheld.push(...ids);
		deps.saveContext(session.summary.id, record);
		host.sessionContextReset(session.summary.id);
		deps.onCompacted?.(session);
		return true;
	}

	return { compact, withhold, changed };
}

function withHot(ms: number | undefined): { cacheHotMs?: number } {
	return ms === undefined ? {} : { cacheHotMs: ms };
}

function isVia(via: unknown): via is NonNullable<CompactionRun["via"]> {
	return via === "fork" || via === "independent" || via === "fallback" || via === "dropped";
}

/** 插件给的头：以用户消息开头的一串消息。形状不对的当作没给对，整次压缩作废。 */
function validHead(head: unknown): Message[] | undefined {
	if (!Array.isArray(head) || head.length === 0) return undefined;
	const ok = head.every(
		(message: unknown) =>
			typeof message === "object" &&
			message !== null &&
			((message as Message).role === "user" || (message as Message).role === "assistant") &&
			Array.isArray((message as Message).content),
	);
	if (!ok || (head[0] as Message).role !== "user") return undefined;
	return structuredClone(head as Message[]);
}

/** 剪过的结果记下来；只认 `allowed` 里的调用、文字块是字符串的。有一份不对就一份都不记。 */
function adoptViews(record: ContextRecord, views: unknown, allowed: ReadonlySet<string>): boolean {
	if (!Array.isArray(views)) return false;
	const valid = views.every(
		(view: unknown) =>
			typeof view === "object" &&
			view !== null &&
			typeof (view as ToolResultView).toolCallId === "string" &&
			allowed.has((view as ToolResultView).toolCallId) &&
			Array.isArray((view as ToolResultView).texts) &&
			(view as ToolResultView).texts.every((text) => typeof text === "string"),
	);
	if (!valid) return false;
	if (
		!(views as ToolResultView[]).some((view) => {
			const previous = record.views?.[view.toolCallId];
			return previous?.length !== view.texts.length || view.texts.some((text, index) => text !== previous?.[index]);
		})
	)
		return true;
	record.views = { ...record.views, ...Object.fromEntries((views as ToolResultView[]).map((view) => [view.toolCallId, [...view.texts]])) };
	record.viewsAt = Date.now();
	return true;
}
