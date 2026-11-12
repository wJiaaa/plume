/**
 * 发给模型之前把过大的工具结果剪短，不问模型。
 *
 * 一次 grep 能回来九万多字符（它的上限数的是匹配条数，压缩过的文件里一条匹配就是一整行），两三个这样的结果就能占满一个窗口；
 * 等压缩发现时，要摘要的东西多半是同一个文件被读了三遍。摘要是一次模型调用：慢、计费、偏偏在窗口紧的时候最容易失败；剪是字符串活，
 * 都不是。所以它先做、不花钱。剪下来留头、留尾，中间一句话说拿走了多少、全文在哪：工具把答案放在开头，把总数、错误、「还有 N 条」
 * 放在结尾，中间是翻过去的那部分。
 *
 * 只剪发给模型的那份：会话里存的是原文，卡片照样打开全部输出。剪过的结果再剪一遍什么也不做（替换后比线短）。
 */

import type { Message, ToolResultMessage } from "@plume/contract";

/**
 * 每份剪短的副本是从哪条消息剪出来的：同一次压缩里，先剪「无结果」、再按条件剪大结果，判断「这一份是不是原样发出去」时要顺着链找回
 * 宿主给的那条。只记身份关系，弱引用，随消息一起回收。
 */
const parents = new WeakMap<Message, Message>();

/** 记下 `view` 是从 `source` 剪出来的，原样返回 `view`。 */
function derive<T extends Message>(source: Message, view: T): T {
	if (view !== source) parents.set(view, source);
	return view;
}

/** 顺着剪枝链回到宿主给的那条；本来就是的返回它自己。 */
function sourceOf(message: Message): Message {
	let at = message;
	for (let parent = parents.get(at); parent; parent = parents.get(at)) at = parent;
	return at;
}

/**
 * 超过这么多字就剪，以下什么都不做。大约 2300 token：普通结果（读一个文件、跑一遍测试、列个目录）原样过，几个病态的大结果也分不走一个窗口。
 */
export const PRUNE_THRESHOLD_CHARS = 8192;
/** 留在前面的，工具把答案放这里。 */
const PRUNE_HEAD_CHARS = 4096;
/** 留在后面的，总数、错误、「还有 N 条」在这里。 */
const PRUNE_TAIL_CHARS = 1024;
/**
 * 低于这条线，剪比不剪贵：占位标记自己就有两百来字，把三百字的结果剪成它什么也省不下，还为此改写了对话中间，服务商的前缀缓存
 * 从那里起作废，下一次请求把上面的每个 token 按原价再算一遍。
 */
export const PRUNE_FLOOR_CHARS = 200;

/** 被剪过的那份认得出来：之后的剪枝、覆盖判断不把它当原样发出去的结果。 */
const CUT_MARK = /characters omitted by Plume to fit the context window|characters of output withheld/;

/**
 * 按模型读的顺序说清发生了什么、少了多少。`address` 是被剪掉那段的地址：有它，这句话从「完整结果留在会话里」（对模型等于没有，
 * 它读不到转录）变成「完整结果在这儿，自己去取」。
 */
function marker(omitted: number, address?: string): string {
	const where = address
		? `the full result is at \`${address}\` — \`read ${address}\` if you need the middle`
		: "the full result is kept in the session and shown in the transcript. Narrow the search or read a specific file if you need the middle";
	return `\n\n… [${omitted.toLocaleString("en-US")} characters omitted by Plume to fit the context window; ${where}.] …\n\n`;
}

/**
 * 剪成头、标记、尾合计至多 `room` 个码点。放得下默认的头尾就给默认的，单独一条结果还是老样子；小一些的（几块分一条线）按同样的
 * 四比一分剩下的。再少也不低于 `PRUNE_FLOOR_CHARS`：留得比标记还少，就全是标记了。
 */
function cutTo(points: string[], room: number, address?: string): string | null {
	const keep = Math.max(PRUNE_FLOOR_CHARS, Math.min(PRUNE_HEAD_CHARS + PRUNE_TAIL_CHARS, room - [...marker(points.length, address)].length));
	const head = Math.min(PRUNE_HEAD_CHARS, Math.ceil(keep * 0.8));
	const tail = Math.min(PRUNE_TAIL_CHARS, keep - head);
	const note = marker(points.length - head - tail, address);
	// 只在 room 比标记还短时走到这里：「剪」完反而变长的不算剪。
	if (head + tail + [...note].length >= points.length) return null;
	return `${points.slice(0, head).join("")}${note}${points.slice(points.length - tail).join("")}`;
}

/**
 * 每块都限在同一个额度下、加起来不超过 `budget` 的最大额度。注水：比额度小的块全留着，剩下的给大的，小块挨着大块时一个字也不动。
 */
export function allowance(sizes: readonly number[], budget: number): number {
	const ordered = [...sizes].sort((a, b) => a - b);
	let left = budget;
	for (let i = 0; i < ordered.length; i++) {
		const share = Math.floor(left / (ordered.length - i));
		if ((ordered[i] as number) > share) return share;
		left -= ordered[i] as number;
	}
	return Number.POSITIVE_INFINITY;
}

/** 把剪掉的原文存起来，换回一个地址（服务 `resources` 的 `keepArtifact`）。不给时剪掉的就只在会话里。 */
export interface ArtifactSink {
	keep(tool: string, content: string): string;
}

/**
 * 一条消息，过大的文字剪短。什么都没变时返回同一个对象：调用方靠身份判断有没有动过。
 */
function pruneMessage(message: Message, threshold: number, artifacts?: ArtifactSink): Message {
	// 要照着做的说明（技能正文，`ToolOutput.instructions`）剪了就是在改规矩。
	if (message.role !== "toolResult" || message.instructions) return message;
	/*
	 * 几块文字合在一起量、合在一起剪回这条线以内。一块一块单独量，十块八千字的就全放过去了；每块剪成一样多，挨着大块的小块又被剪坏。
	 * 所以线按 `allowance` 分：小块全留，大块分剩下的。
	 */
	const texts = message.content.flatMap((block, index) => (block.type === "text" ? [{ index, points: [...block.text] }] : []));
	const total = texts.reduce((sum, block) => sum + block.points.length, 0);
	if (total <= threshold) return message;
	const tool = message.toolName || "tool";
	const level = allowance(
		texts.map((block) => block.points.length),
		threshold,
	);
	const content = [...message.content];

	// 大块太多，每块各带一个标记就留不下能读的头：合成一块剪。按不带地址的标记量（比带地址的长），判断时不必先存什么。
	if (level - [...marker(total)].length < PRUNE_FLOOR_CHARS) {
		const joined = texts.map((block) => block.points.join("")).join("\n\n");
		const address = artifacts ? artifacts.keep(tool, joined) : undefined;
		const cut = cutTo([...joined], threshold, address);
		const first = texts[0];
		if (cut === null || !first) return message;
		content[first.index] = { type: "text", text: cut };
		const dropped = new Set(texts.slice(1).map((block) => block.index));
		return derive(message, { ...message, content: content.filter((_, index) => !dropped.has(index)) });
	}

	let cut = false;
	for (const block of texts) {
		if (block.points.length <= level) continue;
		// 先存原文再剪：反过来存进去的就是剪过的那份，取回来跟手上的一样。只存真要剪的块：没剪的块模型手上就是全文。
		const original = message.content[block.index];
		if (original?.type !== "text") continue;
		const address = artifacts ? artifacts.keep(tool, original.text) : undefined;
		const pruned = cutTo(block.points, level, address);
		if (pruned === null) continue;
		cut = true;
		content[block.index] = { ...original, text: pruned };
	}
	if (!cut) return message;
	return derive(message, { ...message, content });
}

/**
 * 要发出去的样子：过大的工具结果都剪短，别的照旧。什么都不用剪时返回同一个数组。
 */
export function pruneToolResults(messages: Message[], threshold = PRUNE_THRESHOLD_CHARS, artifacts?: ArtifactSink): Message[] {
	let changed = false;
	const next = messages.map((message) => {
		const pruned = pruneMessage(message, threshold, artifacts);
		if (pruned !== message) changed = true;
		return pruned;
	});
	return changed ? next : messages;
}

/** 占位标记大约多长，算上限时留出来。 */
const MARKER_CHARS = 280;

/**
 * 一条新结果发给模型的上限：超过的在第一次发出前剪成头尾，之后每次请求都是同一份（`freshView`）。线放得高：只接「炸开的输出」，
 * 普通结果的长短由各个工具自己按内容控制——把 read 的结果剪成前 4k、后 1k，工具已把整段记成读过、模型却没看见，edit 会放行它没见过的行。
 */
export const FRESH_RESULT_MAX_CHARS = 32_000 + PRUNE_HEAD_CHARS + PRUNE_TAIL_CHARS + MARKER_CHARS;

/**
 * 不会再有人读的结果清空（没搜到、空目录，工具标了 `uneventful`）。清空不删：没有结果的调用会让之后带着这段历史的每一个请求都被拒。
 * 只看这条结果本身，对同一条每次得出同一份。
 */
export function dropUneventful(messages: Message[]): Message[] {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "toolResult" || !message.uneventful) return message;
		const size = message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
		if (size <= PRUNE_FLOOR_CHARS) return message;
		changed = true;
		// i18n-exempt：发给模型的占位，不随界面语言变。
		return derive(message, { ...message, content: [{ type: "text" as const, text: "[无结果]" }] } as ToolResultMessage);
	});
	return changed ? next : messages;
}

/**
 * 每条工具结果第一次发出去时的样子：清空无结果的，超过 `FRESH_RESULT_MAX_CHARS` 的剪成头尾。只看这条结果本身、`artifact://` 地址按内容取，
 * 所以每一轮（重开应用以后也一样）从会话重建出的都是同一份，已经发出去的前缀不会变——会话中途改写发出去的内容，缓存从改的那条起
 * 整段作废。压缩时剪得更狠的那些由宿主记下（`ToolResultView`），宿主给的历史里已经是剪过的，这里再过一遍不会再变。
 */
export function freshView(messages: Message[], artifacts?: ArtifactSink): Message[] {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "toolResult" || message.instructions) return message;
		const [view] = pruneToolResults(dropUneventful([message]), FRESH_RESULT_MAX_CHARS, artifacts);
		if (view === undefined || view === message) return message;
		changed = true;
		return view;
	});
	return changed ? next : messages;
}

/** 这一份已经剪过（这次压缩里剪的，或宿主记着的剪枝视图、拒收后剪成一行的）。 */
export function isCut(message: Message): boolean {
	if (sourceOf(message) !== message) return true;
	return message.role === "toolResult" && message.content.some((block) => block.type === "text" && CUT_MARK.test(block.text));
}
