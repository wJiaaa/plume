/**
 * 估一段历史多大，和服务商自己量的数怎么用。
 *
 * 字符估算（3.5 个字符一个 token）在英文和代码上大致准，在中文和密集的 JSON 上会低估到三分之一，而且只数消息、不数系统提示词
 * 和工具表。所以能用服务商记的用量就用它（`measureTotal`），估算只在还没有量过、或量的是改写前那份历史时补位。
 */

import type { AssistantMessage, Message, ToolSpec } from "@plume/contract";

export function estimateTokens(messages: readonly Message[]): number {
	let chars = 0;
	for (const message of messages) chars += estimateChars(message);
	return charsToTokens(chars);
}

/**
 * `estimateTokens` 一条一条的那半：字符数能逐条加减，取整只在最后做一次。压缩时尾部一条条地删，照这两半算出来的和每次对整段
 * 调 `estimateTokens` 是同一个数，而不必每删一条重扫一遍。
 */
export function estimateChars(message: Message): number {
	let chars = 0;
	if (message.role === "assistant") {
		for (const part of message.content) {
			if (part.type === "text") chars += part.text.length;
			else if (part.type === "thinking") chars += part.thinking.length;
			else chars += (part.argumentsText ?? JSON.stringify(part.arguments)).length + part.name.length;
		}
	} else {
		// 一张图不管多大大约 1500 token。
		for (const part of message.content) chars += part.type === "text" ? part.text.length : 6000;
	}
	return chars;
}

export function charsToTokens(chars: number): number {
	return Math.ceil(chars / 3.5);
}

/** 工具表在线上占多少：每次请求都整份发。 */
export function toolTokens(tools: readonly ToolSpec[]): number {
	if (tools.length === 0) return 0;
	const text = tools.map((tool) => `${tool.name}${tool.description}${JSON.stringify(tool.parameters)}`).join("");
	return Math.ceil(text.length / 3.5);
}

export function textTokens(text: string): number {
	return text ? Math.ceil(text.length / 3.5) : 0;
}

/** 最后一次尝试自己的用量：重试放弃掉的那几次也记在账上，可它们没和这一次共用一个窗口。 */
function requestUsage(message: AssistantMessage): AssistantMessage["usage"] {
	return message.lastAttemptUsage ?? message.usage;
}

/**
 * 这段历史实际多大，优先用服务商量的数：最近一条落定回复的用量是整份请求（含系统提示词和工具表），它之后的消息按估算加上。
 *
 * `staleAt` 之前（含）落定的回复量的是改写前那份历史（压缩、剪枝之前），不算：拿它当现在的大小，压完的历史读出来还是压之前那么满，
 * 于是每一轮都再压一次。没有可用的就退回估算。
 */
export function measureTotal(messages: readonly Message[], staleAt?: number): { measured: boolean; tokens: number } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message;
		if (message.role !== "assistant" || message.stopReason === "pending") continue;
		if (staleAt !== undefined && message.timestamp <= staleAt) break;
		const usage = requestUsage(message);
		const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
		if (total <= 0) break;
		return { measured: true, tokens: total + estimateTokens(messages.slice(i + 1)) };
	}
	return { measured: false, tokens: estimateTokens(messages) };
}
