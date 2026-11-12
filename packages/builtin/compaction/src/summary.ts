/**
 * 写摘要：独立的摘要请求，以及请求失败时的本地兜底整理。从主请求分叉的那条路在 `fork.ts`；选哪条路、压到多大在 `compaction.ts`。
 */

import type { Message, TokenEstimate } from "@plume/contract";
import { type BudgetModel, SUMMARY_INPUT, summaryReplyTokens } from "./budget.ts";
import type { KindOf, ReplyOrigin } from "./head.ts";
import type { ManualWords, Models, Observer } from "./models.ts";
import { FIRST_SUMMARY, focusNote, hasSummary, SUMMARY_SYSTEM, UPDATE_SUMMARY } from "./prompts.ts";
import { allowance } from "./prune.ts";

/**
 * 历史一次放不进摘要请求时，最多分几段写。每多一段就多一次不吃缓存的请求，还要多等一份摘要写完。超长恢复时历史大约一个窗口，摘要请求的
 * 输入占四成，两三段就够；只有 `/compact` 交来一份从没压过的长历史才会碰到这条线，那时每段先各自截短（`condense`）。
 */
const MAX_PASSES = 4;

/** 手动压缩：说明、停止信号，和失败时报给人的话。手动的失败要说出来，自动的退回本地整理。 */
export interface Manual {
	instructions?: string;
	signal?: AbortSignal;
	words: ManualWords;
}

export async function summarize(
	messages: Message[],
	/** 本体估 token 的那一份（`ContextCompact.estimate`）。 */
	estimate: TokenEstimate,
	model: BudgetModel,
	models: Models,
	origin: ReplyOrigin,
	manual?: Manual,
	observer?: Observer,
	/** 实测用量与字符估算之比，见 `compactIfNeeded` 里的 `scale`。 */
	scale = 1,
): Promise<string | null> {
	const focus = focusNote(manual?.instructions);
	const instructionFor = (iterative: boolean): string => [iterative ? UPDATE_SUMMARY : FIRST_SUMMARY, focus].filter(Boolean).join("\n\n");
	const instructionTokens = (iterative: boolean) =>
		estimate.messages([{ role: "user", content: [{ type: "text", text: instructionFor(iterative) }], timestamp: 0 }]);
	/*
	 * 预算按实测比例折回字符估算的单位：估算在中文和密集 JSON 上会低估到三分之一，不校正的话四成的预算实际发出去超过整个窗口，摘要请求被拒。
	 * 只往保守方向校正：估算偏高时不据此多塞。历史那份还要扣掉系统提示词、指令和回复——小窗口上、或 `/compact` 说明很长时，四成比剩下的多。
	 * 按两种指令里长的那个算，分段写的每一段都放得进同一个预算。
	 */
	const inflate = Math.max(1, scale);
	const reply = summaryReplyTokens(model);
	const fixed = estimate.text(SUMMARY_SYSTEM) + Math.max(instructionTokens(true), instructionTokens(false));
	const budget = Math.min((model.contextWindow * SUMMARY_INPUT) / inflate, (model.contextWindow - reply) / inflate - fixed);
	const ask = (history: Message[], iterative: boolean) =>
		requestSummary(history, instructionFor(iterative), { estimate, model, models, manual, observer, inflate, reply, fixed });

	// 有没有上一份摘要决定用哪条指令：重写一份和写第一份是两件事，这个差别让会话开头的那句话活过第十次压缩。
	if (estimate.messages(messages) <= budget) return ask(messages, hasSummary(messages));

	/*
	 * 一次放不下：按顺序一段一段地写，每段都更新上一段写下的摘要——和会话的第二次压缩做的是同一件事。把每条消息都截到同一个长度、塞进一次
	 * 请求的话，超长恢复时每条只剩几百字，报错原文、人的长指令、一个决定的理由都跟着中段没了；分段写，每段都整段读。
	 */
	const draftRoom = reply / inflate + estimate.messages([draftMessage("", origin)[0] as Message]);
	const parts = splitHistory(messages, Math.max(1, budget - draftRoom), estimate);
	let draft: string | null = null;
	for (const part of parts) {
		const history = draft === null ? part : [...draftMessage(draft, origin), ...part];
		const written = await ask(history, draft !== null || hasSummary(part));
		if (written === null) return null;
		draft = written;
	}
	return draft;
}

/** 上一段写下的摘要，接在下一段历史前面。和压缩头一样以 `<session-summary>` 开头，`UPDATE_SUMMARY` 说的「开头的摘要」就是它。 */
function draftMessage(summary: string, origin: ReplyOrigin): Message[] {
	return [
		{ role: "user", content: [{ type: "text", text: `<session-summary>\n${summary}\n</session-summary>` }], timestamp: 0, synthetic: true },
		{
			role: "assistant",
			content: [{ type: "text", text: "Understood. Continuing from that summary." }],
			api: origin.api,
			provider: origin.provider,
			model: origin.model,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		},
	];
}

/**
 * 按顺序切成至多 `MAX_PASSES` 段，每段放进 `budget`。只在完整的单元之间切：回复和回答它的工具结果是一个单元，拆开两种协议都拒收。
 * 一个单元自己就超过预算的那一段截短到预算。段数超过上限时把每段放大到「总量 / 上限」，再各自截短——截短只发生在放不下的那几段里。
 */
function splitHistory(messages: Message[], budget: number, estimate: TokenEstimate): Message[][] {
	const units: Message[][] = [];
	for (let at = 0; at < messages.length;) {
		let to = at + 1;
		while (to < messages.length && messages[to]?.role === "toolResult") to++;
		units.push(messages.slice(at, to));
		at = to;
	}
	const weights = units.map((unit) => estimate.messages(unit));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	const pack = (target: number) => {
		const parts: Message[][] = [];
		let current: Message[] = [];
		let weight = 0;
		units.forEach((unit, index) => {
			const size = weights[index] as number;
			if (current.length > 0 && weight + size > target) {
				parts.push(current);
				current = [];
				weight = 0;
			}
			current.push(...unit);
			weight += size;
		});
		if (current.length > 0) parts.push(current);
		return parts;
	};
	let parts = pack(budget);
	if (parts.length > MAX_PASSES) {
		parts = pack(Math.ceil(total / MAX_PASSES));
		// 按单元装箱会多出零头：并进最后一段，由下面的截短收住。
		while (parts.length > MAX_PASSES) parts.splice(-2, 2, [...(parts.at(-2) as Message[]), ...(parts.at(-1) as Message[])]);
	}
	return parts.map((part) => condense(part, budget, estimate));
}

interface RequestScope {
	estimate: TokenEstimate;
	model: BudgetModel;
	models: Models;
	manual: Manual | undefined;
	observer: Observer | undefined;
	inflate: number;
	reply: number;
	fixed: number;
}

/** 发一次摘要请求。放不下、失败、返回空的，手动压缩抛出说明，自动压缩交回 null 走兜底。 */
async function requestSummary(
	history: Message[],
	instruction: string,
	{ estimate, model, models, manual, observer, inflate, reply, fixed }: RequestScope,
): Promise<string | null> {
	const decline = () => {
		if (!observer?.signal?.aborted) observer?.progress({ phase: "fallback" });
		return null;
	};
	/*
	 * 发之前就核对，不等服务商拒收：`condense` 不总能落到预算里——图片的分量是固定的，比窗口还长的说明留不下任何预算。明知放不下的请求只会
	 * 白等一轮重试再被拒，有的中转还拒成看起来能重试的样子。
	 */
	if ((fixed + estimate.messages(history)) * inflate + reply > model.contextWindow) {
		if (manual) throw new Error(manual.words.tooBig);
		return decline();
	}
	let text: string;
	try {
		const signal = manual?.signal ?? observer?.signal;
		text = await models.complete({
			systemPrompt: SUMMARY_SYSTEM,
			messages: history,
			prompt: instruction,
			maxTokens: reply,
			...(signal ? { signal } : {}),
			...(observer ? { onRetry: ({ delayMs }: { delayMs: number }) => observer.progress({ phase: "retrying", delayMs }) } : {}),
		});
	} catch (cause) {
		if (manual?.signal?.aborted) throw new Error(manual.words.cancelled, { cause });
		if (manual) throw cause;
		return decline();
	}
	if (manual?.signal?.aborted) throw new Error(manual.words.cancelled);
	const trimmed = text.trim();
	if (manual && !trimmed) throw new Error(manual.words.empty);
	return trimmed || decline();
}

/**
 * 把一段历史收进 token 预算：每条消息都剪短，不整条丢。整条丢会丢掉整步——改过的文件、失败的命令——而那正是摘要要的。每条留头留尾：
 * 头说在做什么，尾说结果怎样，九百行文件的中段谁的摘要都用不上。
 *
 * 预算对结果整体成立：每条限在同一个额度下（总数还放得下的最大额度），短消息整条留着；一条里的几部分也这样分。只有每条剪到
 * `CONDENSE_FLOOR` 还放不下（几千条消息）时才丢步，丢开头之后最早的那几步（见 `elide`）。
 */
function condense(messages: Message[], budget: number, estimate: TokenEstimate): Message[] {
	if (estimate.messages(messages) <= budget) return messages;
	const fits = (list: Message[], limit: number) => estimate.messages(clipAll(list, limit)) <= budget;
	const kept = fits(messages, CONDENSE_FLOOR) ? messages : elide(messages, budget, estimate);

	let low = 0;
	let high = 1;
	for (const message of kept)
		high = Math.max(
			high,
			message.content.reduce((sum, part) => sum + partLength(part), 0),
		);
	// 放得下的最大额度；总数只随额度变大，二分就找得到。
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(kept, mid)) low = mid;
		else high = mid - 1;
	}
	return clipAll(kept, low);
}

/** 一条消息最短剪到多少再改为丢步：大约一行，够说哪个文件、哪个命令。再短，步骤都在、却一句话也不说。 */
const CONDENSE_FLOOR = 100;

function partLength(part: Message["content"][number]): number {
	if (part.type === "text") return part.text.length;
	if (part.type === "thinking") return part.thinking.length;
	if (part.type === "toolCall") return (part.argumentsText ?? JSON.stringify(part.arguments ?? {})).length;
	return 0;
}

/**
 * 每条消息限在大约 `limit` 个字以内，按 `allowance` 分给它的各部分——思考只拿它那份的三分之一，最用不上。「大约」：工具调用的参数是逐个
 * 字符串剪完再重新序列化的，`condense` 量结果，不信这里。
 */
function clipAll(messages: Message[], limit: number): Message[] {
	return messages.map((message) => {
		const share = allowance(message.content.map(partLength), limit);
		if (message.role === "assistant") {
			return {
				...message,
				content: message.content.map((part) => {
					if (part.type === "text") return { ...part, text: clip(part.text, share) };
					if (part.type === "thinking") return { ...part, thinking: clip(part.thinking, Math.floor(share / 3)) };
					/*
					 * 剪参数对象里的长字符串，再让原文跟着它重新序列化。只剪原文、把参数置空的话，只读 `arguments` 的协议看到的每一次调用
					 * 都是 `{}`，摘要写不出改过哪个文件。两份同源，任何协议读到的都是同一份剪短的参数。
					 */
					const args = clipValues(part.arguments ?? {}, share) as Record<string, unknown>;
					if (args !== part.arguments) return { ...part, arguments: args, argumentsText: JSON.stringify(args) };
					// 参数没解析出来、只剩流式原文（截断 JSON 的抢救稿）时，能剪的只有原文。
					if (Object.keys(args).length === 0 && part.argumentsText && part.argumentsText.length > share) {
						return { ...part, argumentsText: clip(part.argumentsText, share) };
					}
					return part;
				}),
			};
		}
		if (message.role === "user") {
			return { ...message, content: message.content.map((part) => (part.type === "text" ? { ...part, text: clip(part.text, share) } : part)) };
		}
		return { ...message, content: message.content.map((part) => (part.type === "text" ? { ...part, text: clip(part.text, share) } : part)) };
	});
}

/**
 * 去掉开头之后最早的那几步，直到剩下的按 `CONDENSE_FLOOR` 放得下。开头是目标——人的第一句话，或带着它的上一份摘要；最新的那几步是摘要
 * 要更新到的地方；所以丢的是紧挨开头的那段。原处留一句说明，摘要模型知道这里有个缺口，不把隔得很远的两步读成相邻的。按完整的单元丢。
 */
function elide(messages: Message[], budget: number, estimate: TokenEstimate): Message[] {
	const unit = (from: number) => {
		let to = from + 1;
		while (to < messages.length && messages[to]?.role === "toolResult") to++;
		return to;
	};
	const head = unit(0);
	const cost = messages.map((message) => estimate.messages(clipAll([message], CONDENSE_FLOOR)));
	const note = (count: number): Message => ({
		role: "user",
		content: [
			{
				type: "text",
				text: `[${count} earlier messages omitted here to fit the summary request. They are still in the session log; summarise around the gap and do not guess what was in it.]`,
			},
		],
		timestamp: messages[head]?.timestamp ?? messages[0]?.timestamp ?? 0,
		synthetic: true,
	});
	let rest = cost.slice(head).reduce((sum, value) => sum + value, 0);
	const fixed = cost.slice(0, head).reduce((sum, value) => sum + value, 0) + estimate.messages([note(messages.length)]);
	let from = head;
	while (from < messages.length && fixed + rest > budget) {
		const to = unit(from);
		for (let at = from; at < to; at++) rest -= cost[at] as number;
		from = to;
	}
	if (from === head) return messages;
	return [...messages.slice(0, head), note(from - head), ...messages.slice(from)];
}

/** 参数对象里超长的字符串逐个剪短；没有要剪的就原样返回同一个对象。 */
function clipValues(value: unknown, limit: number): unknown {
	if (typeof value === "string") return clip(value, limit);
	if (Array.isArray(value)) {
		const next = value.map((item) => clipValues(item, limit));
		return next.some((item, i) => item !== value[i]) ? next : value;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value);
		const next = entries.map(([key, item]) => [key, clipValues(item, limit)] as const);
		return next.some(([, item], i) => item !== entries[i]?.[1]) ? Object.fromEntries(next) : value;
	}
	return value;
}

function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = Math.ceil(limit * 0.7);
	const tail = limit - head;
	// i18n-exempt：发给摘要模型的省略标记，不随界面语言变。
	const clipped = `${text.slice(0, head)}\n…（省略 ${text.length - limit} 字）…\n${text.slice(text.length - tail)}`;
	// 刚过线时标记比它替掉的还长；剪不能让字变多。
	return clipped.length < text.length ? clipped : text;
}

/**
 * 摘要请求失败时的本地兜底：不至于连目标和指令一起丢光，机械地取出人的请求、最近的几个动作和碰过的文件。
 *
 * 上一份摘要是最初目标唯一还在的地方：第二次压缩时，带着人开头那句话的消息早就换成了摘要头，只读人发的消息，「目标」一节什么也找不到。
 * 这条路恰好在摘要模型够不着时走，那正是会话最经不起再丢掉目的的时候。所以上一份摘要原样带过来——它已经是要的格式，也写着模型还看得见时
 * 记下的目标。
 */
export function fallbackSummary(messages: readonly Message[], kindOf: KindOf): string {
	const userPrompts: string[] = [];
	const touchedFiles = new Set<string>();
	const keyActions: string[] = [];
	const carried = previousSummary(messages);

	for (const msg of messages) {
		if (msg.role === "user" && !msg.synthetic) {
			const text = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text.trim())
				.filter(Boolean)
				.join("\n");
			// 有上限：一段贴进来的长日志不该让兜底摘要本身放不下。
			const points = [...text];
			const excerpt = points.length <= 2000 ? text : `${points.slice(0, 2000).join("")}…`;
			if (excerpt && !userPrompts.includes(excerpt)) userPrompts.push(excerpt);
		} else if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type !== "toolCall") continue;
				const name = part.name;
				const args = (part.arguments ?? {}) as Record<string, unknown>;
				const path = typeof args.path === "string" ? args.path : undefined;
				if (path) touchedFiles.add(path);
				// 动过东西的才算关键动作：写、改文件和跑命令（注册它的插件声明的 `ToolDefinition.kind`）。
				const kind = kindOf(name);
				if (kind === "create" || kind === "modify" || kind === "command") {
					const desc = (args.description as string | undefined) ?? (args.command as string | undefined)?.split("\n")[0];
					const line = desc ? `${name}: ${desc}` : path ? `${name} ${path}` : name;
					if (!keyActions.includes(line)) keyActions.push(line);
				}
			}
		}
	}

	const sections: string[] = [];
	// 带过来的摘要放最前、保留它自己的结构：后面接机械整理的几节，读起来是一份交接文档的更新，不是两份文档钉在一起。
	if (carried) sections.push(carried);
	// 只列带过来的摘要还没提到的请求：不然目标每次兜底都出现两遍，重复的摘要读的人会学着跳过。
	const fresh = userPrompts.filter((prompt) => !carried?.includes(prompt));
	if (fresh.length > 0) {
		sections.push(
			carried
				? `## Newer User Requests (since the summary above)\n${fresh.map((p) => `- ${p}`).join("\n")}`
				: `## Goal & Original User Intent\n${fresh.map((p) => `- ${p}`).join("\n")}`,
		);
	}
	if (keyActions.length > 0)
		sections.push(
			`## Key Work & Task Progress\n### Recent Key Actions\n${keyActions
				.slice(-10)
				.map((a) => `- ${a}`)
				.join("\n")}`,
		);
	if (touchedFiles.size > 0) sections.push(`## Critical Context\n- Touched files: ${Array.from(touchedFiles).slice(-15).join(", ")}`);
	return sections.join("\n\n") || "Previous turns were compacted.";
}

/**
 * 上一次压缩留下的摘要，从带着它的那条消息里取出来。以 `<session-summary>` 开头的合成用户消息才算：别的合成消息里引用到的同名标签不是。
 * 后面跟着的最新请求不取：每次都从真消息重算，摘要里那份旧的会和旁边新的打架。
 */
function previousSummary(messages: readonly Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message;
		if (message.role !== "user" || !message.synthetic) continue;
		const first = message.content[0];
		const match = first?.type === "text" ? /^<session-summary>\n?([\s\S]*?)\n?<\/session-summary>/.exec(first.text) : null;
		const text = match?.[1]?.trim();
		if (text) return text;
	}
	return null;
}
