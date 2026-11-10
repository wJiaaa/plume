import type { AssistantMessage, CompactionProgress, ContextCompact, Message, ToolResultMessage } from "@plume/contract";
import type { CompactionRequest } from "../src/compaction.ts";
import type { Models, SummaryRequest } from "../src/models.ts";

type ForkRequest = Parameters<Models["fork"]>[0];

export const words = { tooBig: "TOO_BIG", cancelled: "CANCELLED", empty: "EMPTY" };

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
		force: false,
		floor: 0,
		...rest,
	};
}

/** 钩子 context.compact 的一份输入，宿主给的那样。 */
export function compactInput(history: Message[], extra: Partial<ContextCompact> = {}): ContextCompact & { events: CompactionProgress[] } {
	const events: CompactionProgress[] = [];
	return {
		sessionId: "s",
		cwd: "/repo",
		model: { id: "fake/model", name: "Fake", contextWindow: 10_000, maxOutputTokens: 1000 },
		history,
		request: { systemPrompt: "", messages: history, tools: [] },
		force: false,
		signal: new AbortController().signal,
		progress: (event) => events.push(event),
		events,
		...extra,
	};
}
