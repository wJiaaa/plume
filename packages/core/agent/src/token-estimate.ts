/**
 * 本体估 token 的唯一一份：上下文用量圆环（`context-breakdown.ts`）、使用统计的构成（`usage-record.ts`）、压缩（经
 * `ContextCompact.usage` 和 `ContextCompact.estimate`）都用它，各处说的「多满」「多大」是同一个数。
 *
 * 按字数折算，按文字分两种：ASCII（英文、代码、JSON、命令输出）约 3.5 个字符一个 token，其余字符（中日韩文字和全角标点为主）一个字符
 * 一个 token；图片不管多大按定数算。系数是经验值，拿公开的分词器量过几类文本定的（o200k、cl100k、DeepSeek-V3、Qwen2.5、GLM-4.5）：
 * - ASCII 拟合出来约 3.6～3.8 个字符一个 token，取 3.5（Anthropic 文档给 Claude 的经验值也是约 3.5 个英文字符一个），略往多估。
 *   单看一类会偏：缩进多的 JSON 约 4.5 个字符一个（高估约三成），`ls -la` 这种满是数字、日期的输出约 2 个字符一个（低估约四成）。
 * - 非 ASCII 拟合出来每字 0.65（DeepSeek）～1.1（cl100k）个 token，o200k 约 0.8，取 1：Claude 的分词器没公开、量不到；低估的代价是
 *   压缩压晚、请求超长，比高估（压早一点）贵。俄文、希腊文这类字母文字一字远不到一个 token，也按 1 算，会高估，同样是往压早的方向偏。
 * 所以能用服务商量的数就用它（`contextUsage`），估算只在还没量过、或量的是改写前那份历史时补位，或者拿来分比例、按比例校准。
 * 估出来的不取整：逐条、逐段估的可以直接相加，要整数的地方自己取整。
 *
 * 每轮对整段历史估好几遍，要便宜：只逐个看字符码是不是 ASCII，不用正则、不分词，1MB 的文本约 1.5 毫秒。
 */

import type { AssistantMessage, Message, TokenEstimate, ToolSpec } from "@plume/contract";

/** ASCII 约这么多个字符一个 token。 */
const ASCII_CHARS_PER_TOKEN = 3.5;
/** 非 ASCII 的字符（UTF-16 码元：扩展平面的字和表情占两个，算两个 token）一个约这么多 token。 */
const TOKENS_PER_WIDE_CHAR = 1;
/** 一张图大约这么多 token（按 6000 个 ASCII 字符算）：各家算法不同，只取量级。 */
const IMAGE_TOKENS = 6000 / ASCII_CHARS_PER_TOKEN;

export function textTokens(text: string): number {
	let wide = 0;
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0x7f) wide++;
	return (text.length - wide) / ASCII_CHARS_PER_TOKEN + wide * TOKENS_PER_WIDE_CHAR;
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
