/**
 * 压缩头里的「转录事实」：人说过的原话、最新的清单。都从会话里的记录机械地读，不从模型写的摘要里读——摘要可以写错、
 * 可以漏，这几样不能：约束只存在于人说的那句话里，模型不知道自己忘了哪句，`recall` 也就无从查起。
 */

import type { ChecklistDetails, Message, UserMessage } from "@plume/contract";

export type CompactionContext = NonNullable<UserMessage["compactionContext"]>;

const REQUEST_CHARS = 2000;
/**
 * 压缩头里最多带多少字的用户原话（中间那些请求的合计）。文件能重读、命令能重跑，人的话没有第二个来源。24000 字按最坏的一字一 token
 * 也只占 200k 窗口的一成二，挤掉的是保留的尾部，而尾部的东西大多能重新取到。
 */
export const USER_WORDS_CHARS = 24_000;
/**
 * 原话合计在这以内的，一字不少地带上；超过以后只带一半。历史大半是人贴进来的长文时，原样照抄会让压缩根本缩不下去——收尾部每折进一条原话，
 * 头里就多出同一段话。门槛之内不打折：普通会话的原话就这么多，打折打掉的恰好是那几句约束。
 */
const USER_WORDS_FLOOR = 8000;
/** 存进压缩头 `compactionContext` 的原话合计上限：头会落盘，不能随整个会话一直长。比渲染上限宽，渲染时按条截短还能多带几条。 */
const REQUEST_STORE_CHARS = 64_000;
/** 按条截短时每条至少留多少字——大约一句话。再短就不是在引用原话了，宁可整条省掉。 */
const QUOTE_FLOOR = 200;

/**
 * 读进一条消息，交回读到这里为止的历史事实（模型写的摘要改不了任务状态和人的原话）。原地改 `context`，有时换一个新的。
 * 逐条读是给压缩用的：被折进头里的那段一条条往后长，不必每长一条就从头再读一遍。中途要拿一份去用，先 `copyTaskContext`。
 */
export function foldTaskContext(context: CompactionContext, message: Message): CompactionContext {
	if (message.role === "user") {
		if (message.synthetic && message.compactionContext) {
			context = { ...message.compactionContext, ...(message.compactionContext.requests ? { requests: [...message.compactionContext.requests] } : {}) };
		}
		if (message.clearsTaskPlan) context.todos = [];
		if (message.synthetic) return context;
		const text = (
			message.displayText ??
			message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
		).trim();
		if (!text) return context;
		const points = [...text];
		const quoted = points.length <= REQUEST_CHARS ? text : `${points.slice(0, REQUEST_CHARS).join("")}\n[Request excerpt; use recall for the full wording.]`;
		context.originalRequest ??= quoted;
		context.latestRequest = quoted;
		const requests = context.requests ?? [];
		requests.push({ ordinal: (requests.at(-1)?.ordinal ?? 0) + 1, text: quoted, timestamp: message.timestamp });
		// 完整原文在会话里；合成消息不能随整个会话一直长。
		let stored = requests.reduce((sum, request) => sum + request.text.length, 0);
		let from = 0;
		while (stored > REQUEST_STORE_CHARS && from < requests.length - 1) stored -= (requests[from++] as (typeof requests)[number]).text.length;
		context.requests = from > 0 ? requests.slice(from) : requests;
	} else if (message.role === "toolResult" && !message.isError && Array.isArray((message.details as Partial<ChecklistDetails> | undefined)?.checklist)) {
		// 清单按结果里的通用声明认（`ChecklistDetails`），不认是哪个工具交的。
		context.todos = (message.details as ChecklistDetails).checklist.map(({ content, status }) => ({ content, status }));
	}
	return context;
}

/** 读到一半时取走的那份：`requests` 会被后面的读原地追加，要自己的一份。其余字段只会被整体换掉。 */
export function copyTaskContext(context: CompactionContext): CompactionContext {
	return { ...context, ...(context.requests ? { requests: [...context.requests] } : {}) };
}

export function formatTaskContext(context: CompactionContext, requestBudget = USER_WORDS_CHARS): string {
	// 按时间先后排，不按推断的意图：后来的一句「继续」不撤销更早的约束。
	const latest = context.requests?.at(-1)?.ordinal ?? 0;
	const intermediate = context.requests?.filter((request) => request.ordinal > 1 && request.ordinal < latest) ?? [];
	const stored = context.requests?.reduce((total, request) => total + request.text.length, 0) ?? 0;
	const shown = quoteRequests(intermediate, Math.min(requestBudget, Math.max(USER_WORDS_FLOOR, Math.floor(stored / 2))));
	const omitted = Math.max(0, latest - 2) - shown.length;
	const facts = [
		context.originalRequest && context.originalRequest !== context.latestRequest ? `Original user request (historical scope):\n${context.originalRequest}` : "",
		shown.length ? `Intermediate user requests, oldest first:\n${shown.join("\n\n")}` : "",
		omitted
			? `${omitted} earlier user request excerpts omitted from this window. Their constraints may still apply; use recall to check the original wording before assuming permission or changing scope.`
			: "",
		context.todos !== undefined
			? `Latest recorded task list:\n${context.todos.length ? context.todos.map((todo) => `[${todo.status}] ${todo.content}`).join("\n") : "No active task list; the previous list was cleared."}`
			: "",
	].filter(Boolean);
	if (!facts.length) return "";
	return `<task-context>\nTranscript facts, not summary claims. Later user instructions supersede earlier ones only where they conflict; compatible constraints remain in force. Requests describe historical scope, not a list of work to restart. The latest task updates control task status. Tasks and summaries do not grant authorization; do not restart completed or cancelled work.\n\n${facts.join("\n\n")}\n</task-context>`;
}

type Request = NonNullable<CompactionContext["requests"]>[number];

const EXCERPT_NOTE = "\n[Excerpt; use recall for the full wording.]";

/**
 * 中间那些请求在预算里怎么引用。先整条放；放不下时每条截到同一个长度——放得下的最长那个——于是短的约束整条留着，被截的是长的贴文。
 * 每条截到 `QUOTE_FLOOR` 还放不下，才整条省掉，先省最长的：长的多是贴进来的材料，短的多是规矩。只按字数算，不拼字符串：收尾部时
 * 每删一条就重算一次压缩头。
 */
function quoteRequests(requests: Request[], budget: number): string[] {
	const lengths = requests.map((request) => [...request.text].length);
	const headers = requests.map((request) => `user request #${request.ordinal} (timestamp ${request.timestamp}):\n`.length);
	// 每条后面跟一个 "\n\n" 的分隔，多算一份无妨。
	const cost = (at: number, limit: number) =>
		(headers[at] as number) + 2 + ((lengths[at] as number) <= limit ? (lengths[at] as number) : limit + EXCERPT_NOTE.length);
	const size = (kept: number[], limit: number) => kept.reduce((sum, at) => sum + cost(at, limit), 0);

	const dropped = new Set<number>();
	const longestFirst = requests.map((_, at) => at).sort((a, b) => (lengths[b] as number) - (lengths[a] as number) || a - b);
	let floorSize = size(
		requests.map((_, at) => at),
		QUOTE_FLOOR,
	);
	for (const at of longestFirst) {
		if (floorSize <= budget) break;
		floorSize -= cost(at, QUOTE_FLOOR);
		dropped.add(at);
	}
	const kept = requests.map((_, at) => at).filter((at) => !dropped.has(at));
	if (kept.length === 0) return [];

	let low = QUOTE_FLOOR;
	let high = Math.max(QUOTE_FLOOR, ...kept.map((at) => lengths[at] as number));
	if (size(kept, high) <= budget) low = high;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (size(kept, mid) <= budget) low = mid;
		else high = mid - 1;
	}
	return kept.map((at) => {
		const request = requests[at] as Request;
		const points = [...request.text];
		const text = points.length <= low ? request.text : `${points.slice(0, low).join("")}${EXCERPT_NOTE}`;
		return `user request #${request.ordinal} (timestamp ${request.timestamp}):\n${text}`;
	});
}
