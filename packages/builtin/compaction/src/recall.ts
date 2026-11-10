/**
 * 把压缩移出窗口的东西读回来。
 *
 * 摘要生来有损，有损才是它的用处——一百轮没法原样带着。让它可以接受的是原文没丢：会话存着每一条消息的全文，这里搜它。这改变了压缩
 * 是什么：没有它，摘要是一次性决定模型以后能记得什么，由一个不知道以后要什么的模型来定，老实的做法只能是尽量多留在窗口里——恰恰是
 * 让长会话贵得付不起的那股压力。有了它，摘要是一次缓存淘汰：细节一次调用就回来，模型也知道什么时候该调。
 *
 * 有意不做通用的文件搜索：对会话库 grep 能用，但答回来的是一行一条记录的 JSON，匹配的那行上是整个工具结果。这里按消息答，剪短，
 * 早的在前。
 */

import type { Message, ToolDefinition, ToolOutput } from "@plume/contract";

/** 没说要几条时答几条。 */
const DEFAULT_LIMIT = 8;
/** 再多就是重读会话，不是回忆了。 */
const MAX_LIMIT = 20;
/**
 * 一条匹配的消息引用多少字。够带一整条请求、一段带堆栈的报错、一个文件的开头；再多，答一次花的窗口就比摘要省下的还多，回忆就成了
 * 要小心的事——模型提防着的工具，它就不用。
 */
const QUOTE_CHARS = 1200;

export function recallTool(transcript: (sessionId: string) => Promise<Message[]>): ToolDefinition {
	return {
		name: "recall",
		description:
			"Search this session's full transcript, including what compaction removed: an earlier request's exact wording, a file's earlier contents, a command's exact output. " +
			"Case-insensitive; every space-separated term must appear in the message. A long message is quoted as its opening, the passages around your terms and its ending — " +
			"search again with a term from another part to see that part. Images cannot be replayed; ask the user to resend one.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Terms that must all appear. Start with one distinctive word; add terms only if there are too many results.",
				},
				limit: {
					type: "number",
					description: `Maximum messages to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
				},
				offset: {
					type: "number",
					description: "Newest matches to skip, to page backwards. Each answer's footer gives the offset of the next page.",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
		async execute(args, run): Promise<ToolOutput> {
			const query = typeof args.query === "string" ? args.query : "";
			const terms = query
				.toLowerCase()
				.split(/\s+/)
				.filter((term) => term.length > 0);
			if (terms.length === 0) return { output: "recall needs something to search for.", isError: true };

			const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(numberOr(args.limit, DEFAULT_LIMIT))));
			const offset = Math.max(0, Math.floor(numberOr(args.offset, 0)));
			// 整段读，不流式：这个工具护的是模型的上下文窗口，不是进程内存。
			const messages = await transcript(run.sessionId).catch(() => null);
			if (!messages?.length) return { output: "This session has no saved transcript yet, so there is nothing to recall.", isError: true };
			const hits = search(messages, terms, run.signal);

			if (hits.length === 0) {
				return {
					output: `No message in this session contains all of: ${terms.join(", ")}.\n\nTry one distinctive term rather than a phrase — matching is literal, not semantic.`,
					details: { query, matches: 0, shown: 0, offset },
				};
			}

			/*
			 * 最新的匹配先答，每一页里按先后排：上限总要丢些什么，长会话较早的那一半最可能已经摘要过两遍；可按发生的顺序读回来，
			 * 一串匹配才读得出是一串。`offset` 从最新的往回数，会话在底下长了，翻页的边界也不挪。它存在是因为页脚只说「还有 N 条更早的
			 * 没显示」、又给不出够到它们的办法时，模型会自己编一个参数，每一次都被悄悄忽略、拿回同一页。
			 */
			const end = Math.max(0, hits.length - offset);
			const shown = hits.slice(Math.max(0, end - limit), end);
			const count = `${hits.length} match${hits.length === 1 ? "" : "es"}`;

			if (shown.length === 0) {
				return {
					output:
						`${count} for ${terms.join(", ")}, but offset ${offset} is past the oldest of them.\n\n` +
						`This is the start of the transcript — there is nothing older to page to. Use offset 0 for the newest matches, or search for something else.`,
					details: { query, matches: hits.length, shown: 0, offset },
				};
			}

			const body = shown.map((hit) => quote(hit.index, hit.message, terms)).join("\n\n");
			// 页脚给出能照做的下一步：要往回翻的模型拿到的是确切的 offset，没有下一页时也说清楚。
			const older = hits.length - offset - shown.length;
			const footer =
				older > 0
					? `\n\n[${older} older match${older === 1 ? "" : "es"} before this page. To read the next page back, call recall again with the same query and offset=${offset + shown.length}.]`
					: "\n\n[This is the oldest match for that query — there is nothing older to page to.]";

			return {
				output: `${count} in this session.\n\n${body}${footer}`,
				details: { query, matches: hits.length, shown: shown.length, offset },
			};
		},
	};
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 每一条文字里含全部关键词的消息，和它在会话里的位置。 */
function search(messages: Message[], terms: string[], signal?: AbortSignal): { index: number; message: Message }[] {
	const hits: { index: number; message: Message }[] = [];
	for (const [position, message] of messages.entries()) {
		if (signal?.aborted) break;
		// 位置在排除回声之前数：答案里每条匹配都标着它，标号每次印出来都得指同一条。
		if (isOwnEcho(message)) continue;
		const text = textOf(message, { skipRecallCalls: true }).toLowerCase();
		if (terms.every((term) => text.includes(term))) hits.push({ index: position, message });
	}
	return hits;
}

/**
 * 这个工具自己产生的消息，绝不能被它自己搜到。recall 往它读的会话里写：每调一次多两条——带着关键词的调用、带着整段引用的结果——
 * 两条都含刚搜的词。于是每调一次匹配数涨二，从最新的那头切出来的先是自己的回声，模型往回翻页永远追不上。两半都排除，目标才站得住；
 * 什么也没丢：回忆的结果是原处本来就搜得到的历史的副本。
 *
 * 一条回复只调了 recall、别的什么都没做，才算回声：引出这次搜索的推理是模型自己的，以后值得找到；调 recall 的同时还做了别的事的回复，
 * 文字和思考都留着，只跳过那个调用。
 */
function isOwnEcho(message: Message): boolean {
	if (message.role === "toolResult") return message.toolName === "recall";
	if (message.role !== "assistant") return false;
	const blocks = message.content.filter((block) => block.type !== "thinking");
	return blocks.length > 0 && blocks.every((block) => block.type === "toolCall" && block.name === "recall");
}

/** 一条消息里人会读到的一切，压平了拿去匹配和引用。 */
function textOf(message: Message, options?: { skipRecallCalls?: boolean }): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "thinking") parts.push(block.thinking);
		else if (block.type === "toolCall") {
			if (options?.skipRecallCalls && block.name === "recall") continue;
			parts.push(`${block.name} ${block.argumentsText ?? JSON.stringify(block.arguments ?? {})}`);
		}
	}
	return parts.join("\n");
}

/**
 * 图片找得到、放不回来，答案两样都得说。一张截图常常就是一条请求的全部意思，压缩把它丢了；模型看到的是一份提到截图的摘要、一个
 * 搜不出截图的工具，没人说清两者的差别，它就读成「再搜仔细点」。在带图的那条消息上直说：图不会经这里回来，只有发它的人能再发一次。
 */
function imageNote(message: Message): string {
	if (message.role === "assistant") return "";
	const images = message.content.filter((block) => block.type === "image").length;
	if (images === 0) return "";
	return `\n[This message carried ${images} image${images === 1 ? "" : "s"}. Images cannot be replayed through recall — if you need to see ${images === 1 ? "it" : "them"} again, ask the user to resend ${images === 1 ? "it" : "them"}.]`;
}

/** 一条匹配，标好、剪短。 */
function quote(index: number, message: Message, terms: string[]): string {
	const when = new Date(message.timestamp).toISOString().replace("T", " ").slice(0, 16);
	const who = message.role === "toolResult" ? `tool:${message.toolName}` : message.role;
	const text = textOf(message).trim();
	return `--- message ${index} · ${who} · ${when} ---\n${excerpt([...text], terms)}${imageNote(message)}`;
}

/** 别处的匹配要地方时，开头和结尾各剩多少。 */
const HEAD_CHARS = 240;
const TAIL_CHARS = 120;
/** 比这短的空当照引不省：省略标记差不多也这么长。 */
const MIN_GAP = 40;

/**
 * 一条长消息剪成值得读的那几段，按码点切，不切坏字。默认留头留尾：工具结果把答案放在顶上，总数、报错、「还有 N 条」放在底下。可这条
 * 消息是因为关键词才被答回来的，中段的匹配跟着中段一起剪掉，计数说细节在、引文里却没有，读起来像「摘要丢了它是对的」。所以关键词落在
 * 头尾之外时，头尾缩短，腾出的地方给每个这样的词开一扇窗。总长仍是 `QUOTE_CHARS`。
 */
function excerpt(points: string[], terms: string[]): string {
	const length = points.length;
	if (length <= QUOTE_CHARS) return points.join("");

	const head = Math.floor(QUOTE_CHARS * 0.75);
	const tail = Math.floor(QUOTE_CHARS * 0.25);
	const hits = locate(points, terms);
	if (!hits.some((hit) => hit.end > head && hit.start < length - tail)) {
		return stitch(points, [
			[0, head],
			[length - tail, length],
		]);
	}

	// 按缩短后的头尾再判一次：完整的头里看得见的匹配，在短的头里可能就看不见了。
	const outside = hits.filter((hit) => hit.end > HEAD_CHARS && hit.start < length - TAIL_CHARS);
	const share = Math.floor((QUOTE_CHARS - HEAD_CHARS - TAIL_CHARS) / outside.length);
	const spans: [number, number][] = [
		[0, HEAD_CHARS],
		[length - TAIL_CHARS, length],
	];
	for (const hit of outside) {
		const start = Math.max(0, hit.start - Math.floor(Math.max(0, share - (hit.end - hit.start)) / 2));
		spans.push([start, Math.min(length, Math.max(hit.end, start + share))]);
	}
	return stitch(points, spans);
}

/**
 * 每个关键词第一次出现在哪，按原文的码点位置。一个码点一个码点地转小写：转小写会改长度（「İ」变成两个码元），按转完的整串取位置会和
 * 原文错开。这样漏掉的词（整串规则不同的末尾 sigma）只是没有自己的窗。
 */
function locate(points: string[], terms: string[]): { start: number; end: number }[] {
	const lowered: string[] = [];
	const origin: number[] = [];
	points.forEach((point, i) => {
		const lower = point.toLowerCase();
		lowered.push(lower);
		for (let unit = 0; unit < lower.length; unit++) origin.push(i);
	});
	const haystack = lowered.join("");
	const hits: { start: number; end: number }[] = [];
	for (const term of terms) {
		const at = haystack.indexOf(term);
		if (at >= 0) hits.push({ start: origin[at] as number, end: (origin[at + term.length - 1] as number) + 1 });
	}
	return hits;
}

/** 按阅读顺序拼起来，重叠的合并，每个空当标上省了多少。 */
function stitch(points: string[], spans: [number, number][]): string {
	const merged: [number, number][] = [];
	for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
		const last = merged.at(-1);
		if (last && start - last[1] < MIN_GAP) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	let out = "";
	let at = 0;
	for (const [start, end] of merged) {
		if (start > at) out += `\n… [${start - at} characters omitted] …\n`;
		out += points.slice(start, end).join("");
		at = end;
	}
	return out;
}
