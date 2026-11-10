/**
 * Our messages, in the shape the OpenAI Chat Completions API wants (`POST /v1/chat/completions`).
 */

import type { Message, ToolCallContent, ToolResultMessage, ToolSpec } from "../types.ts";
import type { ReasoningReplay } from "./reasoning-compat.ts";
import { THINK_TAG_FIELD } from "./think-tag.ts";
import { toolNameForReplay } from "./tool-names.ts";
import { hoistLocalRefs } from "./tool-schema.ts";

/**
 * 模型看不了图时，图片位置上留下的那句话。
 *
 * `supportsImages` 为假时把图片整组丢掉，再把这句话接在文本后面。用英文是因为它进的是提示词，读它的
 * 是模型。
 */
const NO_VISION_PLACEHOLDER = "[image omitted: model does not support vision]";

/** 编码时需要知道的模型能力。只取用得到的那一项，免得一个纯翻译函数被整个 `ModelConfig` 绑住。 */
export interface ChatCompletionsModelCapabilities {
	supportsImages: boolean;
}

export function toChatCompletionsTools(tools: ToolSpec[]): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: hoistLocalRefs(tool.parameters),
		},
	}));
}

/**
 * One tool result as a `tool` message, which can only carry text.
 *
 * Images are not dropped: `liftedImages` carries them in a user message right after the run of tool
 * messages, the only place Chat Completions accepts one. The marker left here is what ties the
 * picture back to the call that produced it.
 */
function toolResultMessage(result: ToolResultMessage, supportsImages: boolean): unknown {
	const content = result.content
		.map((c) => (c.type === "text" ? c.text : supportsImages ? `[image ${c.mimeType}: attached in the next message]` : NO_VISION_PLACEHOLDER))
		.join("\n");
	return {
		role: "tool",
		tool_call_id: result.toolCallId,
		content,
	};
}

/**
 * The images a run of tool results returned, as one user message — or nothing.
 *
 * Without this a vision model never saw a screenshot, a `read` of a png or an MCP image on this
 * protocol: the result reached it as a line describing the base64.
 */
function liftedImages(results: ToolResultMessage[], supportsImages: boolean): unknown[] {
	if (!supportsImages) return [];
	const images = results.flatMap((result) =>
		result.content.flatMap((c) => (c.type === "image" ? [{ type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } }] : [])),
	);
	if (images.length === 0) return [];
	return [{ role: "user", content: [{ type: "text", text: "Image(s) returned by the tool results above:" }, ...images] }];
}

/**
 * Cleans conversation history for the OpenAI Chat Completions wire protocol.
 *
 * Chat Completions enforces strict invariants:
 * 1. An assistant message must have either non-empty content or tool_calls. Empty content ("")
 *    without tool_calls causes HTTP 400 (e.g. Gemini/relays returning INVALID_ARGUMENT).
 *    When a model spends its turn thinking and emits no text/tools, that turn is a no-op;
 *    we prune it along with any synthetic nudge following it.
 * 2. Tool results must correspond to an assistant tool call. Orphan tool results that have no
 *    prior assistant call are dropped or sanitized to avoid 400 errors.
 */
export function sanitizeChatCompletionsHistory(messages: Message[]): Message[] {
	const out: Message[] = [];
	const droppedEmptyAssistantIndices = new Set<number>();

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];

		if (message.role === "assistant") {
			const hasText = message.content.some((c) => c.type === "text" && c.text.trim().length > 0);
			const hasToolCalls = message.content.some((c) => c.type === "toolCall");

			if (!hasText && !hasToolCalls) {
				droppedEmptyAssistantIndices.add(i);
				continue;
			}
		} else if (message.role === "user") {
			if (droppedEmptyAssistantIndices.has(i - 1) && message.synthetic) {
				continue;
			}
		}

		out.push(message);
	}

	return out;
}

export function toChatCompletionsMessages(
	systemPrompt: string,
	messages: Message[],
	reasoning: ReasoningReplay = "replay",
	model?: ChatCompletionsModelCapabilities,
	/** 缺推理的助手轮补一个空的 `reasoning_content`。撞上过才开，见 `padsMissingReasoning`。 */
	padMissingReasoning = false,
): unknown[] {
	const sanitized = sanitizeChatCompletionsHistory(messages);
	const out: unknown[] = [];
	/*
	 * 没告诉我们能力的，按「能看图」编——那是这个函数一直以来的行为，缺省不该悄悄变严。
	 *
	 * 真正的调用方（`openai-chat-completions.ts`）总是把模型传进来，所以这个缺省只兜住直接调它的
	 * 测试和别处的旧调用。
	 */
	const supportsImages = model?.supportsImages !== false;
	if (systemPrompt) {
		out.push({ role: "system", content: systemPrompt });
	}

	for (let index = 0; index < sanitized.length; index++) {
		const message = sanitized[index];
		if (message.role === "user") {
			const hasImages = message.content.some((c) => c.type === "image");
			/*
			 * 纯文本模型上，图片必须在这里换成一句话，不能原样发出去。
			 *
			 * 从前这里只看「这条消息里有没有图」，不看「这个模型看不看得了图」。一个 `supportsImages:
			 * false` 的模型收到 `image_url` 会 400，而图片一旦进了历史，**之后每一轮都带着它**——会话
			 * 从此永久报废，裁史也救不回来（裁到图片那一条之前才行）。
			 *
			 * 所以先问模型看不看得了图，不支持就把图片整组丢掉、接一句 `NO_VISION_PLACEHOLDER`。
			 *
			 * 工具结果里的图不走这里：`toolResultMessage` 与 `liftedImages` 按同一个 `supportsImages`
			 * 处理它们。会走到这里的是人手动贴进对话的图。
			 */
			if (!hasImages || !supportsImages) {
				let text = message.content
					.filter((c) => c.type === "text")
					.map((c) => (c.type === "text" ? c.text : ""))
					.join("\n");
				if (hasImages) {
					text = text ? `${text}\n${NO_VISION_PLACEHOLDER}` : NO_VISION_PLACEHOLDER;
				}
				const prevMsg = index > 0 ? sanitized[index - 1] : undefined;
				// 打断这一轮的那句话自己带着说明（`prompt/steering.ts`），这里再加一句就说了两遍。
				if (prevMsg?.role === "assistant" && prevMsg.stopReason === "aborted" && !message.synthetic && !message.interrupting) {
					text = `[System note: Your previous response was interrupted by the user to provide new instructions. Abandon the interrupted thought and focus entirely on the latest user request below.]\n\n${text}`;
				}
				out.push({ role: "user", content: text });
			} else {
				out.push({
					role: "user",
					content: message.content.map((c) =>
						c.type === "text"
							? { type: "text", text: c.text }
							: {
									type: "image_url",
									image_url: { url: `data:${c.mimeType};base64,${c.data}` },
								},
					),
				});
			}
			continue;
		}

		if (message.role === "assistant") {
			const answers = new Map<string, ToolResultMessage>();
			let after = index + 1;
			for (; after < sanitized.length; after++) {
				const next = sanitized[after];
				if (next.role !== "toolResult") break;
				if (!answers.has(next.toolCallId)) answers.set(next.toolCallId, next);
			}

			const toolCalls: unknown[] = [];
			let text = "";
			let thought = "";
			/** 这段思考进来时挂在哪个键上。见下面 `msg[thoughtField]` 那一段。 */
			let thoughtField: string | undefined;

			for (const c of message.content) {
				if (c.type === "text") {
					text += c.text;
				} else if (c.type === "thinking") {
					/*
					 * 只收带得动句柄的那一档：没有句柄的这一块跳过。
					 *
					 * 「句柄」在这条链上就是 `signature`——那是别的协议留下的。撞上这一档说明对面（多半是
					 * 一个把请求再翻译成 Anthropic 的中转）要求推理带着签名回来，而剥过句柄的思考块拿不出来。
					 */
					if (reasoning === "handled" && !c.signature) continue;
					thought += c.thinking;
					thoughtField ??= c.reasoningField;
				} else if (c.type === "toolCall") {
					toolCalls.push({
						id: c.id,
						type: "function",
						function: {
							name: toolNameForReplay(c.name),
							arguments: replayArguments(c),
						},
					});
				}
			}

			const msg: Record<string, unknown> = { role: "assistant" };
			if (text) {
				msg.content = text;
			} else if (toolCalls.length > 0) {
				/*
				 * 空字符串，不是 `null`。
				 *
				 * 协议上两者等价——带 `tool_calls` 的助手消息不需要文本。但 `null` 会绊倒一部分严格的
				 * 实现和中转（还没读到工具结果就报错），而 `""` 不会。
				 *
				 * 这一步是普适安全的，所以直接改默认：能收 `null` 的端点一样收 `""`（`""` 是 OpenAI 官方
				 * 文档里 `content` 的合法值），而挑剔的那些只收后者。
				 */
				msg.content = "";
			} else if (message.stopReason === "aborted") {
				msg.content = "[Turn interrupted by user]";
			} else {
				const hasThinking = message.content.some((c) => c.type === "thinking");
				msg.content = hasThinking ? "[Thought without final response]" : "[Empty response]";
			}
			if (toolCalls.length > 0) msg.tool_calls = toolCalls;
			/*
			 * 模型想过的话，原样还回去。
			 *
			 * 这条链一直是只读不还：解码那边把 `delta.reasoning_content` 接进思考块
			 * （`openai-chat-completions.ts`），界面上也画出来，然后编码这边把它整段丢掉——上面那个循环
			 * 原本只有 `text` 和 `toolCall` 两个分支。对多数宿主这只是浪费；对 DeepSeek 系的推理模型这是
			 * 致命的，它要求自己产出的思考跟着下一轮回来：
			 *
			 *     The `reasoning_content` in the thinking mode must be passed back to the API.
			 *
			 * 于是模型只要调过一次工具，第二轮必 400，而且没有任何一条代码路径能满足它——不是配错了，是
			 * 这段逻辑不存在。唯一的出路是把思考关掉。
			 *
			 * 只在真有思考文本时发。历史里没有的时候不去编一段：那是「端点要求而我们手上没有」的另一个
			 * 问题，属于失败重试那一层，不该在一个纯翻译函数里替它做主。
			 *
			 * **用它进来时那个键还回去**，而不是永远写 `reasoning_content`。同一件事在这条链上有三个字段
			 * 名（见 `chat-delta.ts` 的 `REASONING_FIELDS`），OpenRouter 用的是 `reasoning`。
			 * 一个只认自己那个键的端点，收到另一个键等于没收到——而我们刚刚还因为只读一个键而在界面上丢
			 * 掉了整段思考。缺省仍是 `reasoning_content`：旧会话和别的协议产生的思考块没有这个标记，它们
			 * 的行为一字不变。
			 */
			if (thought && reasoning !== "omit") {
				/*
				 * 从正文开头的 `<think>` 里切出来的思考，按原样包回正文前面，不改成字段。
				 *
				 * MiniMax M2 要求多轮里带回含 `<think>` 的整段回答；Ollama / vLLM 上的 Qwen3、R1 的聊天模板本来就是
				 * 从正文里认这个标签的。拆成 `reasoning_content` 发回去，前者不认，后者的模板拿不到它原来的样子。
				 * `</think>` 后面那个空行是切的时候吃掉的分隔，这里补回来。
				 */
				if (thoughtField === THINK_TAG_FIELD) msg.content = `<think>${thought}</think>\n\n${text}`;
				else msg[thoughtField ?? "reasoning_content"] = thought;
			} else if (padMissingReasoning && reasoning === "replay") {
				// 端点说过「推理必须带回来」而这一轮手上没有：补空串，不编一段。见 `padsMissingReasoning`。
				msg.reasoning_content = "";
			}

			out.push(msg);

			// Interleave / follow directly with tool messages responding to tool calls
			const answered: ToolResultMessage[] = [];
			for (const tc of toolCalls as { id: string }[]) {
				const answer = answers.get(tc.id);
				if (answer) {
					out.push(toolResultMessage(answer, supportsImages));
					answered.push(answer);
				}
			}
			out.push(...liftedImages(answered, supportsImages));
			index = after - 1;
			continue;
		}

		if (message.role === "toolResult") {
			// A standalone tool result with no prior assistant message (e.g. truncated history head)
			out.push(toolResultMessage(message, supportsImages), ...liftedImages([message], supportsImages));
		}
	}

	return out;
}

const EPHEMERAL = { type: "ephemeral" } as const;

/** 这个模型值得放缓存断点：Anthropic 的模型，经一个把请求翻译成 Anthropic 的中转（OpenRouter、LiteLLM 一类）。 */
export function wantsCacheBreakpoints(modelId: string): boolean {
	return /claude/i.test(modelId);
}

/**
 * 在 system 和最后两条消息上放 `cache_control` 断点。
 *
 * Anthropic 的缓存只认显式断点，而这条链原来一个都不放：Claude 经 Chat Completions 中转时每一轮都把
 * 整段历史按全价重读。原生那条链早就在尾部滚动断点（`anthropic-messages-request.ts` 的
 * `applyPromptCaching`）。这里放 system 和最后两条；断点挂在**内容块**上而不是消息上，所以
 * 字符串内容要改写成一个 text 块——`prefix-fingerprint.ts` 把这样的单块认作原来那个字符串。
 * Anthropic 一次最多四个断点，这里用三个。
 *
 * 只挂在有字的 text 块上：空 text 块不能带断点，只有 `tool_calls` 的助手消息（`content: ""`）跳过、往前找。
 * 端点不认这个字段时会点名它，学到 `cache-control` 就不再放（`request-params-compat.ts`）。
 */
export function withCacheBreakpoints(messages: unknown[]): unknown[] {
	const out = messages.slice();
	const system = (out[0] as { role?: unknown } | undefined)?.role === "system";
	if (system) out[0] = withBreakpoint(out[0]) ?? out[0];
	let placed = 0;
	for (let i = out.length - 1; i >= (system ? 1 : 0) && placed < 2; i--) {
		const marked = withBreakpoint(out[i]);
		if (!marked) continue;
		out[i] = marked;
		placed++;
	}
	return out;
}

/** 最后一个有字的 text 块带上断点后的这条消息；没有能放的块时是 null。 */
function withBreakpoint(message: unknown): unknown {
	const record = message as Record<string, unknown>;
	const content = record.content;
	if (typeof content === "string") return content ? { ...record, content: [{ type: "text", text: content, cache_control: EPHEMERAL }] } : null;
	if (!Array.isArray(content)) return null;
	const at = content.findLastIndex((part) => (part as { type?: unknown })?.type === "text" && Boolean((part as { text?: unknown }).text));
	if (at === -1) return null;
	return { ...record, content: content.map((part, index) => (index === at ? { ...(part as object), cache_control: EPHEMERAL } : part)) };
}

/**
 * 回放一次工具调用时发的参数串。
 *
 * 优先发流里收到的原文：那是上一次请求里服务商亲眼见过的字节，换成重新序列化的版本（键序、空格、
 * 转义都可能不同）会让这一段缓存前缀失效。原文不是合法 JSON 时（截断、模型吐坏了）才改发解析后的
 * 参数：原样透传在官方端点上没事，但把请求再翻译成 Anthropic / Gemini 的中转要先解析它，解析不了
 * 就是 400，而这条调用进了历史，之后每一轮都是这个 400。
 */
export function replayArguments(call: ToolCallContent): string {
	if (call.argumentsText !== undefined) {
		try {
			JSON.parse(call.argumentsText);
			return call.argumentsText;
		} catch {
			// 落到下面
		}
	}
	return JSON.stringify(call.arguments);
}
