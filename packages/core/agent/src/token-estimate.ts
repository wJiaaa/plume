/**
 * 本体估 token 的唯一一份：上下文用量圆环（`context-breakdown.ts`）、使用统计的构成（`usage-record.ts`）、压缩（经
 * `ContextCompact.usage` 和 `ContextCompact.estimate`）都用它，各处说的「多满」「多大」是同一个数。
 *
 * 按字数折算：约 3.5 个字符一个 token，在英文和代码上大致准，在中文和密集的 JSON 上会低估到三分之一；图片不管多大按定数算。
 * 所以能用服务商量的数就用它（`contextUsage`），估算只在还没量过、或量的是改写前那份历史时补位，或者拿来分比例、按比例校准。
 * 估出来的不取整：逐条、逐段估的可以直接相加，要整数的地方自己取整。
 */

import type { AssistantMessage, Message, TokenEstimate, ToolSpec } from "@plume/contract";

const CHARS_PER_TOKEN = 3.5;
/** 一张图大约这么多 token（按 6000 个字符算）：各家算法不同，只取量级。 */
const IMAGE_TOKENS = 6000 / CHARS_PER_TOKEN;

export function charsToTokens(chars: number): number {
	return chars / CHARS_PER_TOKEN;
}

export function textTokens(text: string): number {
	return charsToTokens(text.length);
}

/** 消息里的一块。工具调用按发出去的参数原文算（有 `argumentsText` 时用它）。 */
export function blockTokens(block: Message["content"][number]): number {
	switch (block.type) {
		case "text":
			return textTokens(block.text);
		case "thinking":
			return textTokens(block.thinking);
		case "toolCall":
			return textTokens(block.argumentsText ?? JSON.stringify(block.arguments ?? {})) + textTokens(block.name);
		default:
			return IMAGE_TOKENS;
	}
}

export function messageTokens(messages: readonly Message[]): number {
	let tokens = 0;
	for (const message of messages) for (const block of message.content) tokens += blockTokens(block);
	return tokens;
}

/** 工具表在线上占多少：每次请求都整份发。 */
export function toolTokens(tools: readonly Pick<ToolSpec, "name" | "description" | "parameters">[]): number {
	let tokens = 0;
	for (const tool of tools) tokens += textTokens(`${tool.name}${tool.description}${JSON.stringify(tool.parameters)}`);
	return tokens;
}

/** 交给插件的那一份（`ContextCompact.estimate`）。 */
export const tokenEstimate: TokenEstimate = { messages: messageTokens, text: textTokens, tools: toolTokens };

/** 最后一次尝试自己的用量：重试放弃掉的那几次也记在账上，可它们没和这一次共用一个窗口。 */
function attemptTotal(message: AssistantMessage): number {
	const usage = message.lastAttemptUsage ?? message.usage;
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/**
 * 一份请求有多满：最近一条落定回复服务商量的数（整份请求，含系统提示词和工具表，加上它的输出）加上它之后的消息的估算，取整。
 * 报了 0 的往前找。`staleAt` 之前（含）落定的回复量的是改写前那份历史（压缩、剪枝之前），不算：拿它当现在的大小，压完的历史读出来
 * 还是压之前那么满。没有可用的时 `measured` 为假，`tokens` 是 `overhead`（系统提示词、工具表的估算，调用方给）加上全部消息的估算。
 */
export function contextUsage(messages: readonly Message[], options: { staleAt?: number; overhead?: number } = {}): { tokens: number; measured: boolean } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message;
		if (message.role !== "assistant" || message.stopReason === "pending") continue;
		if (options.staleAt !== undefined && message.timestamp <= options.staleAt) break;
		const total = attemptTotal(message);
		if (total <= 0) continue;
		return { measured: true, tokens: Math.ceil(total + messageTokens(messages.slice(i + 1))) };
	}
	return { measured: false, tokens: Math.ceil((options.overhead ?? 0) + messageTokens(messages)) };
}
