/**
 * 长会话留在上下文窗口里。三样办法，便宜的在前，各答一个不同的问题：
 *
 *   1. 剪掉过大的工具结果（`prune.ts`、`stale-results.ts`）。不用模型、不发请求，常常单靠它就够——在大仓库里跑过三次 grep 的会话，
 *      大半就是那三个结果。
 *   2. 较早的那一半换成一份结构化的摘要（这里），把边界交给宿主记下：只交回一份短的历史、不记边界的话，下一轮从会话重建历史，
 *      每条原文都回来了，又从头压一遍——对话永远不会比会话小，会话只会长。
 *   3. `recall` 工具按需把原文读回来：摘要过的东西没丢，只是移出了窗口，等人问起。
 *
 * 第三样让第二样可以压得狠：摘要生来有损，旁边有一份搜得到的转录就不是。
 *
 * 这里只决定压不压、从哪切、摘要怎么写、头里放什么；摘要、边界和剪过的结果由宿主记下，发请求时由它把历史拼回来，会话里的消息一条不动。
 */

import type { CompactSummary, ContextCompact, Message, TokenEstimate, ToolResultView } from "@plume/contract";
import { type BudgetModel, type CompactionBudget, compactionBudget, KEEP_MIN } from "./budget.ts";
import { forkable, forkSummary } from "./fork.ts";
import { droppedMessage, type KindOf, type ReplyOrigin, RetiredHistory, summaryMessages } from "./head.ts";
import type { ManualWords, Models, Observer } from "./models.ts";
import { type ArtifactSink, dropUneventful, FRESH_RESULT_MAX_CHARS, freshView, pruneToolResults } from "./prune.ts";
import { dropStaleResults } from "./stale-results.ts";
import { fallbackSummary, summarize } from "./summary.ts";

type Via = "fork" | "independent" | "fallback" | "dropped";

/** 压完的历史：`kept` 是末尾原样（或剪过）留下的条数，不给是只剪了工具结果、边界没动。 */
interface Compacted {
	messages: Message[];
	summary: string;
	kept?: number;
	via?: Via;
}

export interface CompactDeps {
	models: Models;
	/** 剪掉的原文存到哪，占位标记里的 `artifact://` 地址指向它。不给时剪掉的只在会话里。 */
	artifacts?: ArtifactSink;
	/** 手动压缩失败时报给人的话。 */
	words: ManualWords;
	/** 哪个工具读文件、写改文件、跑命令：按工具表里的声明认，见 `KindOf`。 */
	kindOf: KindOf;
}

/**
 * 钩子 context.compact 最里层：该压的话压，交回宿主要记下的结论；不用压、压不小时不给。手动压缩（`/compact`）的失败抛出，
 * 自动压缩的摘要请求失败退回本地整理，不抛。
 */
export async function compact(input: ContextCompact, deps: CompactDeps): Promise<CompactSummary> {
	const { history } = input;
	/*
	 * 一轮收尾后问的：只有能热分叉时才值得提前压——前缀几秒前刚写进缓存，摘要请求基本只付输出的钱。缓存凉了、换了模型的，
	 * 提前做一次凉的独立请求不省钱，人还可能根本不回来，留给下一轮开头照常压。
	 */
	if (input.idle && !forkable(input.lineage, input.model.id)) return undefined;
	const origin = replyOrigin(history);
	if (!origin) return undefined;
	const observer: Observer = { signal: input.signal, progress: (event) => input.progress(event) };
	const result = await compactIfNeeded({
		// 和发送路径（逻辑入口的 model.context 层）同一份：量的、切的、分叉接上的都是真正发出去的样子。
		messages: freshView(history, deps.artifacts),
		model: input.model,
		origin,
		models: deps.models,
		overhead: input.estimate.text(input.request.systemPrompt) + input.estimate.tools(input.request.tools),
		request: input.request,
		usage: input.usage,
		estimate: input.estimate,
		force: input.force,
		floor: input.previous?.head ?? 0,
		...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
		...(input.manual ? { manual: { instructions: input.manual.instructions, signal: input.signal, words: deps.words } } : {}),
		observer,
		...(input.lineage ? { lineage: input.lineage } : {}),
		cwd: input.cwd,
		kindOf: deps.kindOf,
		modelId: input.model.id,
	});
	if (!result || input.signal.aborted) return undefined;
	return summaryOf(history, result);
}

/** 确认回复记的来历：照历史里最近一条回复。一条回复都没有的历史也没什么可压。 */
function replyOrigin(history: readonly Message[]): ReplyOrigin | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i] as Message;
		if (message.role === "assistant") return { api: message.api, provider: message.provider, model: message.model };
	}
	return undefined;
}

/** 压完的历史换成宿主要的结论：边界、头，和留下的那截里剪过的工具结果。 */
function summaryOf(history: readonly Message[], result: Compacted): CompactSummary {
	if (result.kept === undefined) {
		const views = viewsOf(history, result.messages, 0);
		return views.length > 0 ? { pruneOnly: true, views } : undefined;
	}
	const keep = history.length - result.kept;
	const head = result.messages.slice(0, result.messages.length - result.kept);
	return {
		keep,
		summary: result.summary,
		head,
		...(result.via ? { via: result.via } : {}),
		views: viewsOf(history, result.messages.slice(head.length), keep),
	};
}

/** `tail` 和 `history` 从 `from` 起一一对应；文字和原来不一样的工具结果记成剪枝视图。 */
function viewsOf(history: readonly Message[], tail: readonly Message[], from: number): ToolResultView[] {
	const views: ToolResultView[] = [];
	tail.forEach((message, index) => {
		const original = history[from + index];
		if (message.role !== "toolResult" || original?.role !== "toolResult") return;
		const texts = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
		const before = original.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
		if (texts.length === before.length && texts.every((text, at) => text === before[at])) return;
		views.push({ toolCallId: message.toolCallId, texts });
	});
	return views;
}

export interface CompactionRequest {
	/** 要压的历史，和发出去的那份一致（剪枝视图、`freshView` 都已经用上）。 */
	messages: Message[];
	model: BudgetModel;
	modelId: string;
	origin: ReplyOrigin;
	models: Models;
	/**
	 * 请求里对话以外的部分：系统提示词和整份工具表。固定不变，对话却会被切；两样当成一样算，切对话时开销也在纸面上跟着缩，
	 * 实际每次整份发，结果落在要落的线上方。
	 */
	overhead: number;
	/** 下一次要发的那份请求（经过 model.context）：分叉接在它后面。 */
	request: ContextCompact["request"];
	/** `request` 有多满，宿主算好的（`ContextCompact.usage`）。 */
	usage: ContextCompact["usage"];
	/** 宿主估 token 的那一份（`ContextCompact.estimate`）：切在哪、摘要请求放不放得下都按它量。 */
	estimate: TokenEstimate;
	/** 不管量出来多满都压：超长恢复、`/compact`。 */
	force: boolean;
	/** 上一次换上的头占了开头几条：新边界要在它后面。 */
	floor: number;
	artifacts?: ArtifactSink;
	/** `/compact <说明>`，和取消它的信号。 */
	manual?: { instructions?: string; signal?: AbortSignal; words: ManualWords };
	observer?: Observer;
	/** 从哪一次请求分叉出摘要请求（`fork.ts`）。不给就只有独立的摘要请求——超长恢复不给，完整历史本来就放不下。 */
	lineage?: ContextCompact["lineage"];
	/** 工具调用里的相对路径按它解析：判断一次读取是否被后来的读写覆盖要知道两个路径是不是同一个文件。 */
	cwd: string;
	/** 见 `CompactDeps.kindOf`。 */
	kindOf: KindOf;
}

export async function compactIfNeeded(request: CompactionRequest): Promise<Compacted | null> {
	const { model, origin, artifacts, manual, observer, overhead, force, floor, estimate } = request;
	let messages = request.messages;
	/*
	 * 服务商自己量的数，不是估算：估算在中文和密集 JSON 上低得厉害，而且两样错的方向一致，200k 窗口里已经 200.7k 的对话估出来
	 * 八十几 k，永远到不了线。没量过（第一条回复落地前、刚压完）才退回估算，那时宿主连系统提示词和工具表一起估。
	 */
	const measured = request.usage;
	const originalMessages = messages;
	const used = measured.tokens;
	const budget = compactionBudget(model, overhead, force ? Math.max(0, used - overhead) : undefined);
	if (!force && used < budget.trigger) return null;

	/*
	 * 先剪大的工具结果，看看够不够：剪是字符串活，摘要是一次慢、计费、偏偏在窗口紧时最容易失败的模型调用。
	 *
	 * 什么都没有的结果最先清，不碰有内容的：没搜到、空目录占着地方，又不回答任何以后会再问的问题。被后来的观察覆盖的结果也只在
	 * 这里清：会话中途不改写已经发出去的内容，压缩本来就要重写前缀。
	 */
	const tidied = dropUneventful(messages);
	const stale = dropStaleResults(tidied, request.cwd, request.kindOf);
	/*
	 * 模型还没看过的新结果（最后一条回复之后）只剪炸开的那种，和发送路径第一次发出前的那条线相同。`read` 把输出控制在这条线以内、
	 * 并把返回的行记成读过；这里照常剪到 8k 的话，它记下的多于模型看到的，`edit` 会放行没见过的行。
	 */
	const unseenFrom = stale.findLastIndex((message) => message.role === "assistant") + 1;
	const seenPart = stale.slice(0, unseenFrom);
	const unseenPart = stale.slice(unseenFrom);
	const seenPruned = pruneToolResults(seenPart, undefined, artifacts);
	const unseenPruned = pruneToolResults(unseenPart, FRESH_RESULT_MAX_CHARS, artifacts);
	const pruned = seenPruned === seenPart && unseenPruned === unseenPart ? stale : [...seenPruned, ...unseenPruned];
	if (pruned !== messages) {
		/*
		 * 用量过的那份校准估算，再把同一个校准用到剪过的那份上。拿实测除以剪过那份的估算，任何剪法算出来都还是 `used`，有实测时
		 * 这条路永远走不到。`messages` 代表上一次发出去的那份：宿主给的历史已经用上了记下的剪枝视图，剪过的再剪不会再省一次。
		 */
		const sent = estimate.messages(messages);
		const calibration = measured.measured && sent > 0 ? Math.max(0, used - overhead) / sent : 1;
		const next = estimate.messages(pruned) * calibration;
		/*
		 * 要越过线一段余量：乘积两边都是估算，往乐观那边错就会发出一轮放不下的请求，回来一样大、再没什么可剪。点名要压
		 * （`/compact`）时不走这条近路：剪工具输出不动对话本身，而那正是敲 `/compact` 的人想收起来的。
		 */
		if (!force && next < budget.settled) return { messages: pruned, summary: "" };
		messages = pruned;
	}

	// 短到没有值得摘要的过去，多大都一样。
	if (messages.length <= KEEP_MIN + 2) return pruned !== originalMessages ? { messages: pruned, summary: "" } : null;

	/*
	 * 估算按它整体错了多少校正，切点才落在该落的地方。触发线用实测，但下面的预算是一条一条花的，服务商没给每条的数。校正只作用于
	 * 消息、不作用于开销。除以剪过的那份，不除以发出去的：`/compact` 交来的可能是实测好几倍的历史，偏低的比例会让摘要请求和留下的
	 * 尾部超出窗口；除以剪过的只会偏高，往安全的方向。
	 */
	const raw = estimate.messages(messages);
	const conversation = Math.max(0, used - overhead);
	const scale = measured.measured && raw > 0 ? conversation / raw : 1;

	/*
	 * 从后往前留最近的几轮，直到预算用完再切——不切在回复和回答它的工具结果之间，两种协议都拒收。也不切进上一次换上的头里：
	 * 头会和中间那段一起重写。手动压缩在大窗口里也收起做完的事（`budget.keep`）。
	 */
	const lowest = Math.max(1, floor);
	let cut = messages.length;
	let kept = 0;
	while (cut > lowest) {
		const next = estimate.messages([messages[cut - 1] as Message]) * scale;
		if (messages.length - cut >= KEEP_MIN && kept + next > budget.keep) break;
		kept += next;
		cut--;
	}
	while (cut < messages.length && messages[cut]?.role === "toolResult") cut++;
	if (cut <= lowest || cut >= messages.length) return null;

	const recent = messages.slice(cut);

	/*
	 * 留下的尾部从最老的往后删，直到真的放得下：要的不是变小，是放得下。277k 压到 250k 也还是发不出去，下一轮到的是一段越线、
	 * 再没什么可试的对话。变的只是摘要旁边留多少原文，重新考虑不花钱。工具结果和它回答的调用一起删。删到 `settled` 为止，
	 * 不删到按条丢弃的那条线：尾部是它的预算选中的正在做的事，摘要旁边通常本来就远在线下。
	 */
	const target = budget.settled;
	const scaled = (list: Message[]) => estimate.messages(list) * scale;
	const costs = messages.map((message) => estimate.messages([message]));
	/*
	 * `from` 总是 `messages` 的一段后缀。折进头里的那段和尾部的估算都逐条增减（`RetiredHistory`），不是每删一条就对整段重算——
	 * 估算不取整、能逐条相加，算出来的和每次 `scaled([...头, ...尾])` 是同一个数。
	 */
	const fit = (text: string, from: Message[]) => {
		let start = messages.length - from.length;
		// 删尾部可能又折进去一句请求、一次计划更新；它们的事实也要留在摘要外面。
		const retired = new RetiredHistory(request.kindOf);
		let tailCost = 0;
		for (let at = 0; at < messages.length; at++) {
			if (at < start) retired.add(messages[at] as Message);
			else tailCost += costs[at] as number;
		}
		const withHead = () => summaryMessages(text, origin, model, retired.files(), retired.taskContext());
		const weight = (head: Message[]) => (estimate.messages(head) + tailCost) * scale;
		let head = withHead();
		while (weight(head) > target && messages.length - start > 1) {
			let drop = 1;
			while (start + drop < messages.length && messages[start + drop]?.role === "toolResult") drop++;
			// 删到只剩一个单元为止：最后一条是工具结果时，再删就没有可留的了。
			if (start + drop >= messages.length) break;
			for (const end = start + drop; start < end; start++) {
				retired.add(messages[start] as Message);
				tailCost -= costs[start] as number;
			}
			head = withHead();
		}
		const tail = messages.slice(start);
		return { tail, compacted: [...head, ...tail] };
	};

	/*
	 * 先试从主请求分叉（`fork.ts`）：同一个前缀，缓存照常命中，看到的是没剪过的完整历史。它摘要的是整段，包括下面原样保留的尾部——
	 * 那几条说两遍，比整段历史按原价重读一遍便宜得多。没有分叉起点、换了模型、缓存凉了、放不下、或者它没交回一份摘要，就退回独立请求。
	 */
	let summary: string | null = null;
	let via: Via = "independent";
	if (forkable(request.lineage, request.modelId)) {
		observer?.progress({ phase: "summarizing" });
		const signal = manual?.signal ?? observer?.signal;
		const forked = await forkSummary({ messages: request.request.messages, usage: request.usage, estimate }, model, request.models, {
			...(force && manual?.instructions ? { instructions: manual.instructions } : {}),
			...(signal ? { signal } : {}),
			...(observer ? { observer } : {}),
		});
		if (manual?.signal?.aborted) throw new Error(manual.words.cancelled);
		if (observer?.signal?.aborted) return null;
		if (forked) {
			summary = forked;
			via = "fork";
		}
	}
	/*
	 * 独立请求只看得到交给它的那段。分叉摘要的是整段，之后从尾部再删的它都写过；独立的不是——摘要之后为了放得下再从尾部删掉的那几条，
	 * 既不在摘要里也不在结果里，是最近的工作。要删的时候把它们并进要摘要的那段重写一次。为了少重写，发请求前先按不带摘要正文的头
	 * 收一次尾部——头里的最新请求、任务上下文、文件清单是确定的，只有摘要正文要等写出来才知道。只重写一次：第二次还要删的，按原样删。
	 */
	let tail = recent;
	if (!summary) {
		tail = fit("", recent).tail;
		for (let attempt = 0; attempt < 2; attempt++) {
			const summarised = messages.slice(0, messages.length - tail.length);
			let written: string | null = null;
			if (via !== "fallback") {
				observer?.progress({ phase: "summarizing" });
				written = await summarize(
					summarised,
					estimate,
					model,
					request.models,
					origin,
					force && manual
						? {
								...(manual.instructions ? { instructions: manual.instructions } : {}),
								...(manual.signal ? { signal: manual.signal } : {}),
								words: manual.words,
							}
						: undefined,
					observer,
					scale,
				);
				if (observer?.signal?.aborted) return null;
			}
			if (!written) {
				written = fallbackSummary(summarised, request.kindOf);
				via = "fallback";
			}
			summary = written;
			const fitted = fit(written, tail).tail;
			if (fitted.length === tail.length || attempt === 1) break;
			tail = fitted;
		}
	}
	if (!summary) return dropOldest(messages, estimate, model, budget, scale, floor, request.kindOf);
	const text = summary;

	// 摘要写好了，按它的实际长度再收一次尾部：分叉那份覆盖整段，删多少都在摘要里；独立的那份已经按最长留过位置。
	const fitted = fit(text, tail);
	tail = fitted.tail;
	const compacted = fitted.compacted;

	// 没压小的摘要不值它那条消息。同一个单位比——校正过的估算——拿估算和实测比，答案就由估算自己的误差定了。
	let result: Compacted | null = scaled(compacted) < scaled(messages) ? { messages: compacted, summary: text, kept: tail.length, via } : null;

	/*
	 * 尾部删光了仍在触发线以上，是摘要本身太大——多半是兜底摘要带着整段历史请求。先试按条丢弃：落到线下就用它。都落不到的，取两份里
	 * 小的那份，但它必须在窗口以内——交回一份发不出去的历史当作压缩成功，下一轮只会原样超长。比的是触发线而不是 `target`：后者是想
	 * 落到的位置，落不到那里但已在线下的结果照样能用。光开销就占满触发线时什么历史都放不下，丢弃也救不了，不走这一步。
	 */
	const { room } = budget;
	if (room > 0 && scaled(compacted) >= room) {
		const dropped = dropOldest(messages, estimate, model, budget, scale, floor, request.kindOf);
		if (dropped && scaled(dropped.messages) < room) return dropped;
		if (dropped && scaled(dropped.messages) < scaled(result?.messages ?? messages)) result = dropped;
		if (result && scaled(result.messages) + overhead > model.contextWindow) return null;
	}
	return result;
}

/**
 * 摘要拿不到时不靠模型落到线下。摘要是一次请求，请求会失败——中转没了额度、key 被拒、这一轮被取消。拿「不用压」回答它，调用方带着
 * 一段越过窗口的对话接着走，下一轮量出同样满的历史、要同样的摘要、同样失败。整段丢掉最老的几轮比摘要它们差，比唯一的另一条路——
 * 一轮根本发不出去——好。两样都不毁掉什么：会话留着全部，`recall` 照样找得到。按完整的单元丢：调用被丢了的工具结果两种协议都拒收。
 *
 * `floor`：上一次换上的头占了开头几条，丢要丢过它们。
 */
function dropOldest(
	messages: Message[],
	estimate: TokenEstimate,
	model: BudgetModel,
	budget: CompactionBudget,
	scale: number,
	floor: number,
	kindOf: KindOf,
): Compacted | null {
	const target = budget.dropped;
	const weight = (list: Message[]) => estimate.messages(list) * scale;

	if (weight(messages) <= target) return null;
	// 预算的是交出去的整份：前面那条说明带着最新请求和任务上下文，中文下能有好几千 token。丢掉的那段和留下的估算逐条增减，同 `fit`。
	const costs = messages.map((message) => estimate.messages([message]));
	const older = new RetiredHistory(kindOf);
	let rest = costs.reduce((sum, value) => sum + value, 0);
	let head: Message | undefined;
	let start = 0;
	while (start < messages.length - 1) {
		const from = start;
		start++;
		// 不从一个刚丢了问题的回答开始。
		while (start < messages.length && messages[start]?.role === "toolResult") start++;
		for (let at = from; at < start; at++) {
			older.add(messages[at] as Message);
			rest -= costs[at] as number;
		}
		if (start >= messages.length) return null;
		head = droppedMessage(older.taskContext(), model, older.files());
		if (start > floor && (estimate.messages([head]) + rest) * scale <= target) break;
	}
	if (!head || start <= floor) return null;
	const result = [head, ...messages.slice(start)];
	// 丢到只剩最后一条仍可能放不下；放不放得下由调用方和摘要结果一起比（见 `compactIfNeeded`）。
	return { messages: result, summary: "", kept: result.length - 1, via: "dropped" };
}
