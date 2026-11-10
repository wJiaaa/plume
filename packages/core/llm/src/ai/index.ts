import type {
	ApiFormat,
	AssistantMessage,
	LlmContext,
	ModelConfig,
	Provider,
	ProviderConfig,
	RequestOptions,
	StreamEvent,
} from "../types.ts";
import { anthropicMessagesProvider } from "./anthropic-messages.ts";
import { openaiResponsesProvider } from "./openai-responses.ts";
import { openaiChatCompletionsProvider } from "./openai-chat-completions.ts";

/** The adapters the app speaks. A bound registry is asked first; see `useLlmRegistry`. */
const BUILT_IN: Record<ApiFormat, Provider> = {
	"anthropic-messages": anthropicMessagesProvider,
	"openai-responses": openaiResponsesProvider,
	"openai-chat-completions": openaiChatCompletionsProvider,
};

/** What provider lookup asks before falling back to the built-in adapters. */
export interface LlmRegistry {
	get(api: string): Provider | undefined;
}

let registry: LlmRegistry | null = null;

/**
 * Put a registry in front of the built-in adapters.
 *
 * Deliberately a binding rather than a parameter threaded through every call site: the adapter
 * in use is a property of the running process, and passing it down through the agent loop,
 * compaction and every tool that streams would say otherwise. Neither host binds one; the seam is
 * for tests and scripts, and for whatever per-session injection replaces it.
 */
export function useLlmRegistry(next: LlmRegistry | null): void {
	registry = next;
}

function getProvider(api: ApiFormat): Provider {
	const provider = registry?.get(api) ?? BUILT_IN[api];
	if (!provider) throw new Error(`Unsupported API format: ${api}`);
	return provider;
}

/** Stream one assistant turn. Yields incremental events and returns the final message. */
export async function* streamAssistant(
	providerConfig: ProviderConfig,
	model: ModelConfig,
	context: LlmContext,
	options: RequestOptions = {},
): AsyncGenerator<StreamEvent, AssistantMessage> {
	const stream = getProvider(providerConfig.api).stream(providerConfig, model, context, options);
	try {
		while (true) {
			const next = await stream.next();
			if (next.done) return withoutRepeatedCalls(next.value);
			const event = next.value;
			yield event.type === "done" || event.type === "error" ? { ...event, message: withoutRepeatedCalls(event.message) } : event;
		}
	} finally {
		await stream.return?.(undefined as never);
	}
}

/**
 * 同一条回复里 id 相同的工具调用只留第一个。
 *
 * 循环按 content 里的 toolCall 逐个执行，一个 id 出现两次就真的跑两次：bash 跑两遍，edit 第二遍报
 * 找不到原文。适配器把同一项拼进来两次时就是这样（见 `openai-responses.ts` 的 `backfill`），在所有
 * 适配器汇合的这里兜一次底。同一个 id 只能有一个结果，重复的那份没有可执行的意义。
 */
function withoutRepeatedCalls(message: AssistantMessage): AssistantMessage {
	const seen = new Set<string>();
	const content = message.content.filter((block) => {
		if (block.type !== "toolCall") return true;
		if (seen.has(block.id)) return false;
		seen.add(block.id);
		return true;
	});
	return content.length === message.content.length ? message : { ...message, content };
}
