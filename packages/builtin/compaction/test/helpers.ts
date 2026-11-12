import type { AssistantMessage, CompactionProgress, ContextCompact, Message, TokenEstimate, ToolKind, ToolResultMessage } from "@plume/contract";
import type { CompactionRequest } from "../src/compaction.ts";
import type { Models, SummaryRequest } from "../src/models.ts";

type ForkRequest = Parameters<Models["fork"]>[0];

export const words = { tooBig: "TOO_BIG", cancelled: "CANCELLED", empty: "EMPTY" };

/** 假的工具表：测试里用的这几个工具各自声明的活（插件在 `ToolDefinition.kind` 上标的）。 */
const KINDS: Record<string, ToolKind> = { read: "view", write: "create", edit: "modify", bash: "command" };
export const kindOf = (tool: string): ToolKind | undefined => KINDS[tool];

/**
 * 宿主估 token 的那一份（`ContextCompact.estimate`）的替身，和本体同一个算法：ASCII 约 3.5 个字符一个 token，其余字符一个一个，
 * 一张图按 6000 个 ASCII 字符。
 */
const textTokens = (text: string) => {
	let wide = 0;
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0x7f) wide++;
	return (text.length - wide) / 3.5 + wide;
};
export const estimate: TokenEstimate = {
	text: textTokens,
	tools: (tools) => tools.reduce((sum, tool) => sum + textTokens(`${tool.name}${tool.description}${JSON.stringify(tool.parameters)}`), 0),
	messages: (messages) => {
		let tokens = 0;
		for (const message of messages)
			for (const block of message.content) {
				if (block.type === "text") tokens += textTokens(block.text);
				else if (block.type === "thinking") tokens += textTokens(block.thinking);
				else if (block.type === "toolCall") tokens += textTokens(block.argumentsText ?? JSON.stringify(block.arguments ?? {})) + textTokens(block.name);
				else tokens += 6000 / 3.5;
			}
		return tokens;
	},
};

/**
 * 宿主算的 `ContextCompact.usage` 的替身：最近一条落定、报了用量的回复量的数加上它之后的估算；`staleAt` 之前（含）的不算；
 * 都没有时是 `overhead` 加全部消息的估算。
 */
export function usageOf(messages: readonly Message[], staleAt?: number, overhead = 0): ContextCompact["usage"] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message;
		if (message.role !== "assistant" || message.stopReason === "pending") continue;
		if (staleAt !== undefined && message.timestamp <= staleAt) break;
		const used = message.lastAttemptUsage ?? message.usage;
		const total = used.input + used.cacheRead + used.cacheWrite + used.output;
		if (total > 0) return { measured: true, tokens: Math.ceil(total + estimate.messages(messages.slice(i + 1))) };
	}
	return { measured: false, tokens: Math.ceil(overhead + estimate.messages(messages)) };
}

export function usage(input = 0): AssistantMessage["usage"] {
	return { input, output: 0, cacheRead: 0, cacheWrite: 0, total: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export const user = (...texts: string[]): Message => ({ role: "user", content: texts.map((text) => ({ type: "text" as const, text })), timestamp: 1 });

export const reply = (content: AssistantMessage["content"], input = 0, timestamp = 1): AssistantMessage => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "fake",
	model: "model",
	usage: usage(input),
	stopReason: "stop",
	timestamp,
});

export const say = (text: string, input = 0) => reply([{ type: "text", text }], input);

export const toolResult = (id: string, text: string, toolName = "bash"): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

export const textOf = (message: Message): string => message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

/** 记下每一次摘要请求和分叉请求；`summary` 是假模型的回答，`fork` 不给时分叉请求抛错（前缀对不上）。 */
export function recorder(
	summary: string | ((request: SummaryRequest) => string | Promise<string>) = "摘要",
	fork?: string | ((request: ForkRequest) => string | Promise<string>),
) {
	const requests: SummaryRequest[] = [];
	const forks: ForkRequest[] = [];
	const models: Models = {
		async complete(request) {
			requests.push(request);
			return typeof summary === "function" ? summary(request) : summary;
		},
		async fork(request) {
			forks.push(request);
			if (fork === undefined) throw new Error("fork mismatch");
			return typeof fork === "function" ? fork(request) : fork;
		},
	};
	return { requests, forks, models };
}

export const model = (contextWindow: number, maxOutputTokens = 1000) => ({ contextWindow, maxOutputTokens });

/** 直接驱动 `compactIfNeeded`：量的就是交给它的这份历史，和循环交给它的「上一次发出去的那份」一样。 */
export function request(
	messages: Message[],
	models: Models,
	extra: Partial<CompactionRequest> & { contextWindow?: number; maxOutputTokens?: number } = {},
): CompactionRequest {
	const { contextWindow = 10_000, maxOutputTokens = 1000, ...rest } = extra;
	return {
		messages,
		model: { contextWindow, maxOutputTokens },
		modelId: "fake/model",
		origin: { api: "anthropic-messages", provider: "fake", model: "model" },
		models,
		overhead: 0,
		request: { systemPrompt: "", messages, tools: [] },
		usage: usageOf(messages, undefined, rest.overhead ?? 0),
		estimate,
		force: false,
		floor: 0,
		cwd: "/repo",
		kindOf,
		...rest,
	};
}

/** 钩子 context.compact 的一份输入，宿主给的那样。 */
export function compactInput(history: Message[], extra: Partial<ContextCompact> = {}): ContextCompact & { events: CompactionProgress[] } {
	const events: CompactionProgress[] = [];
	const request = extra.request ?? { systemPrompt: "", messages: history, tools: [] };
	return {
		sessionId: "s",
		session: { id: "s", kind: "top" },
		cwd: "/repo",
		model: { id: "fake/model", name: "Fake", contextWindow: 10_000, maxOutputTokens: 1000 },
		history,
		request,
		usage: usageOf(request.messages, extra.rewrittenAt, estimate.text(request.systemPrompt) + estimate.tools(request.tools)),
		estimate,
		force: false,
		signal: new AbortController().signal,
		progress: (event) => events.push(event),
		events,
		...extra,
	};
}
