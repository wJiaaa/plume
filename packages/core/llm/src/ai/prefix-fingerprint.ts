/**
 * 请求前缀在哪里变了：缓存诊断的归因证据。
 *
 * 诊断只从 usage 看得出「本该读到的没读到」，看不出是本地改了前缀（提示词、工具、剪枝、协议编码），
 * 还是服务商那边清掉了缓存。这里把最终请求体按缓存前缀的顺序切段——工具定义、系统提示词、请求参数、
 * 逐条消息——各算一个哈希，和同一会话的上一次请求比出第一处不同。只留位置和长度，不留正文。
 *
 * 三条协议的请求体都按这个形状切：Anthropic `tools`/`system`/`messages`，Responses
 * `tools`/`instructions`/`input`，Chat Completions `tools`/`messages`（系统提示词是开头那条 `system` 消息，同样记成 `system`）。
 * 协议放的 `cache_control` 断点每次跟着最后一条消息挪，不算内容，哈希前去掉（只去协议放的那几处）。
 */

import { createHash } from "node:crypto";
import type { RequestPrefix } from "../types.ts";

export interface PrefixSegment {
	name: string;
	hash: string;
	chars: number;
}

export function payloadSegments(body: unknown): PrefixSegment[] {
	if (!body || typeof body !== "object") return [];
	const record = body as Record<string, unknown>;
	const segments: PrefixSegment[] = [];
	const add = (name: string, value: unknown) => {
		const text = JSON.stringify(value ?? null);
		segments.push({ name, hash: createHash("sha256").update(text).digest("hex").slice(0, 16), chars: text.length });
	};
	const messages = Array.isArray(record.messages) ? record.messages : Array.isArray(record.input) ? record.input : [];
	// Chat Completions 没有单独的系统提示词字段，它是开头那条 `system` 消息：记成 `system`，
	// 不然诊断会把改了提示词当成改写了历史。
	const declared = record.system ?? record.instructions;
	const leadingSystem = declared === undefined && (messages[0] as { role?: unknown } | undefined)?.role === "system";
	const system = leadingSystem ? withoutBlockBreakpoints(messages[0]) : Array.isArray(declared) ? declared.map(withoutBreakpoint) : declared;
	/*
	 * 其余顶层参数（thinking / reasoning、tool_choice、temperature……）：Anthropic 文档写明 thinking 参数和
	 * tool_choice 一变，消息部分的缓存就失效，所以排在 system 之后、消息之前。每次都会变、又不进缓存的
	 * 字段不算：输出上限按上下文逐次重算，流式开关和路由键不是内容，换模型另有归类。
	 */
	const params = Object.fromEntries(Object.entries(record).filter(([key]) => !SEGMENTED.has(key) && !NOT_CACHED.has(key)).sort(([a], [b]) => (a < b ? -1 : 1)));
	/*
	 * 开头三段每次都占位，缺了记 `null`：关掉 thinking、工具全断开、没有系统提示词时那一段整个消失，
	 * 不占位的话后面各段前移一位，变化就错记到下一段上。
	 */
	add("tools", Array.isArray(record.tools) ? record.tools.map(withoutBreakpoint) : record.tools);
	add("system", system);
	add("params", Object.keys(params).length > 0 ? params : undefined);
	messages.forEach((message, index) => {
		if (!(leadingSystem && index === 0)) add(`messages[${index}]`, withoutBlockBreakpoints(message));
	});
	return segments;
}

const SEGMENTED = new Set(["tools", "system", "instructions", "messages", "input"]);
const NOT_CACHED = new Set(["model", "stream", "stream_options", "max_tokens", "max_completion_tokens", "max_output_tokens", "metadata", "prompt_cache_key"]);

/**
 * 只去掉协议放断点的那几处：工具定义本身、system 块、消息的内容块。工具 schema 或调用参数里
 * 碰巧叫 `cache_control` 的字段是真数据，变了就是前缀变了。
 */
function withoutBreakpoint(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value) || !("cache_control" in value)) return value;
	const { cache_control: _breakpoint, ...rest } = value as Record<string, unknown>;
	return rest;
}

function withoutBlockBreakpoints(message: unknown): unknown {
	if (!message || typeof message !== "object" || !Array.isArray((message as { content?: unknown }).content)) return message;
	const content = (message as { content: unknown[] }).content.map(withoutBreakpoint);
	/*
	 * 只有一个 text 块的内容按那个字符串算。Chat Completions 给 Claude 放断点时要把字符串内容改写成
	 * 一个 text 块（`withCacheBreakpoints`），下一轮断点挪走，它又变回字符串——同一句话，不算前缀变了。
	 * 两种写法在 Anthropic 那边本来就是同一个块。
	 */
	const only = content.length === 1 ? (content[0] as Record<string, unknown>) : undefined;
	const text = only?.type === "text" && typeof only.text === "string" && Object.keys(only).length === 2 ? only.text : undefined;
	return { ...message, content: text ?? content };
}

/** `after` 和 `before` 比：`before` 原样是 `after` 的前缀时没有 `change`。 */
export function comparePrefix(before: readonly PrefixSegment[], after: readonly PrefixSegment[]): RequestPrefix {
	for (let index = 0; index < before.length; index++) {
		const was = before[index];
		const now = after[index];
		if (now && now.name === was.name && now.hash === was.hash) continue;
		return { segments: after.length, change: { segment: now?.name ?? was.name, before: was.chars, after: now?.chars ?? 0 } };
	}
	return { segments: after.length };
}
