/**
 * OpenAI Responses API adapter (`POST /v1/responses`).
 *
 * The Responses format is item-based rather than message-based: assistant text, reasoning
 * and function calls are sibling items in one flat `input` array. Reasoning items carry an
 * opaque `encrypted_content` that must be replayed verbatim for the model to keep its chain
 * of thought across tool calls, which is why `include: ["reasoning.encrypted_content"]` is
 * always requested.
 */

import { toResponsesInput, toResponsesTools } from "./openai-responses-request.ts";
import { sanitizeToolPairing } from "./sanitize-history.ts";
import { toolNameFromStream } from "./tool-names.ts";
import type {
	AssistantMessage,
	LlmContext,
	ModelConfig,
	Provider,
	ProviderConfig,
	RequestOptions,
	StreamEvent,
	TextContent,
} from "../types.ts";
import { addUsage, emptyUsage } from "../types.ts";
import { classifyFailure, FailureError, REFUSAL_MESSAGE, spokenSoFar } from "./failure.ts";
import { RetryBudget, fetchWithRetry, retryStream, toolCallId } from "./retry.ts";
import { argumentFragment, parseToolArguments, readSseWithIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from "../utils/sse.ts";
import { USER_AGENT, failedStreamEvent, joinUrl, priceAttempt, settleUsage } from "./endpoint.ts";
import { resolveReasoningEffort } from "./thinking-options.ts";
import { withReasoningRetry, type ReasoningReplay } from "./reasoning-compat.ts";
import { learnToolPairing, toolPairing } from "./tool-pairing-compat.ts";
import { learnToolResultImages, toolResultImages } from "./tool-result-images-compat.ts";
import { droppedParams, learnDroppedParam } from "./request-params-compat.ts";
import { thinkingDialect } from "./vendors/index.ts";
import { responsesThinkingFields } from "./vendors/thinking.ts";
import { compatKey, compatScope } from "./compat-key.ts";
import { applyUsage } from "./usage-fields.ts";
import { cacheRouting, sessionHeaders } from "./cache-routing.ts";

export const openaiResponsesProvider: Provider = {
	api: "openai-responses",
	stream: streamResponses,
};

/**
 * 撞出来「助手轮要以推理项开头」的模型，见 `ResponsesHome.leadingReasoning`。
 *
 * 先验只认得 DeepSeek（地址或模型名里带着它）。中转给它起了别名时认不出来，就靠它那句话学：
 * `The \`reasoning_text\` in the thinking mode must be passed back to the API.` 这句话在那个端点上什么都
 * 说（工具排错了、末项是助手的话，见 `reasoning-compat.ts` 的 `REQUIRES`），所以只学一次：补位打开之后
 * 再撞上它，就交回推理梯子按原来的规矩处理。记在内存里，理由同另外几个轴。
 */
const leadsWithReasoning = new Set<string>();
const MUST_PASS_BACK = /reasoning_text.{0,40}must be passed back/i;

/** message 项的 `phase`。只认这两个值：中转塞进来的别的什么，回放时原样送回去只会换来一个 400。 */
function messagePhase(value: unknown): TextContent["phase"] {
	return value === "commentary" || value === "final_answer" ? value : undefined;
}

async function* streamResponses(
	provider: ProviderConfig,
	model: ModelConfig,
	context: LlmContext,
	options: RequestOptions,
): AsyncGenerator<StreamEvent, AssistantMessage> {
	const startTime = Date.now();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: provider.id,
		model: model.modelId,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: startTime,
	};

	const reasoningEffort = resolveReasoningEffort(options.thinking, model);
	const thinkingEnabled = reasoningEffort !== undefined;
	/** 学和查都用这一对 id，见 `compat-key.ts`。排列这一轴曾经查用 `modelId`、学用 `id`，学到的永远查不到。 */
	const scope = compatScope(provider, model);
	/** 这个模型族的思考开关怎么写、要不要补位推理项，见 `vendors/`。 */
	const dialect = thinkingDialect(provider.baseUrl, model.modelId || model.id);
	/** DeepSeek 要求每个助手轮以推理项开头，别的端点撞过那句话才补。见 `ResponsesHome.leadingReasoning`。 */
	const leadingReasoning = (): boolean => dialect.leadingReasoning || leadsWithReasoning.has(compatKey(scope.providerId, scope.modelId));

	/*
	 * 每次尝试重新编一遍，因为**形状可能在两次之间变掉**。
	 *
	 * 端点的脾气是撞出来的，不是配出来的，而且有两个互不相干的轴：推理怎么还（`reasoning-compat.ts`：
	 * 有的要求必须带、有的一带就 400）、工具调用怎么排（`tool-pairing-compat.ts`：有的要成组、有的要
	 * 交错）。被顶回来的那一次会记下结论、换个形状重发，所以这里必须能重新编一份，而不是把第一次编好
	 * 的那份原样再发一遍。
	 */
	const buildBody = (replay: ReasoningReplay): Record<string, unknown> => {
		/** 这个端点撞过之后要求我们别发的参数，见 `request-params-compat.ts`。 */
		const dropped = droppedParams(scope.providerId, scope.modelId);
		return {
			model: model.modelId,
			// Told who it is going to, so a handle written by a different model is left behind rather
			// than replayed to one that will reject it. See `fromHome`.
			input: toResponsesInput(
				sanitizeToolPairing(context.messages),
				{
					provider: provider.id,
					model: model.modelId,
					supportsImages: model.supportsImages,
					toolImages: toolResultImages(scope.providerId, scope.modelId),
					leadingReasoning: leadingReasoning(),
				},
				replay,
				toolPairing(scope.providerId, scope.modelId),
			),
			stream: true,
			// Sessions live in our own store, not on the provider.
			store: false,
			max_output_tokens: options.maxTokens ?? model.maxOutputTokens,
			...(context.systemPrompt ? { instructions: context.systemPrompt } : {}),
			/*
			 * `tool_choice: "auto"` 是服务端默认值，发它零收益——但撞过一次的端点上要连它一起省掉。
			 *
			 * 没有直接改成「一律不发」，是因为「省略等于 auto」这句话本身没有实测支撑：作者手上两个端点带不带
			 * 都是 200，证明不了别家也一样。默认维持原样，撞了再撤。
			 */
			...(context.tools.length > 0
				? {
						tools: toResponsesTools(context.tools),
						...(dropped.has("tool-choice") ? {} : { tool_choice: "auto" }),
					}
				: {}),
			// Omitting `reasoning` does not disable thinking — several providers still reason by
			// default, so "off" has to say so explicitly. `effort: "none"` is the documented way. Families
			// that refuse it (Gemini, OpenAI's o-series and pre-5.1 gpt-5) are in `vendors/`; an unknown
			// endpoint that refuses it is learnt by `request-params-compat.ts`, and either way the whole
			// `reasoning` is left out.
			...responsesThinkingFields(dialect, { effort: thinkingEnabled ? reasoningEffort : undefined, supportsThinking: model.supportsThinking, dropped }),
			...(options.temperature !== undefined && !thinkingEnabled && !dropped.has("sampling")
				? { temperature: options.temperature }
				: {}),
			// 缓存路由键，被拒过就不再带。见 `cache-routing.ts`。
			...cacheRouting(options.cacheKey, dropped).body,
			/*
			 * 采样参数最后展开——它们是用户自己配的，覆盖上面算出来的值是有意为之。
			 *
			 * 但撞过「这个模型不接受采样参数」的端点上要整组撤掉：用户在设置里填了 `temperature`，而 o 系列和
			 * gpt-5.x 对显式采样参数一律 400。用户配出来的东西
			 * 让整个会话发不出请求，拦一下比原样转发更有用。
			 */
			...(dropped.has("sampling") ? {} : { ...model.samplingParams, ...options.samplingParams }),
		};
	};
	/*
	 * Built by each attempt below, not here as well. It used to be built once up front and again by
	 * the first attempt, with `onPayload` (a hash of every message, for the cache-prefix check) run on
	 * both: twice the per-request cost of a history that only grows. Nothing reads it in between, and
	 * a build that throws still surfaces — the retry wrapper rethrows what no learner recognises.
	 */
	let body: Record<string, unknown> = {};
	/** 补位还没开、而端点说了那句话：开，重发一次。已经开着就不认，交给推理梯子。 */
	const learnLeadingReasoning = (providerId: string, modelId: string, said: string): boolean => {
		if (leadingReasoning() || !MUST_PASS_BACK.test(said)) return false;
		leadsWithReasoning.add(compatKey(providerId, modelId));
		return true;
	};

	const doFetch = options.fetch ?? globalThis.fetch;
	// 在这里算一次，重试沿用同一个会话 id。
	const requiredHeaders = sessionHeaders(provider.baseUrl, options.cacheKey);

	let firstTokenTime: number | null = null;
	/** Slot (`output_index`, or see `slotOf`) -> position in partial.content, so deltas can find their block. */
	const items = new Map<
		number,
		{
			kind: "text" | "thinking" | "toolCall";
			contentIndex: number;
			raw: string;
			/** The provider's item id, so `response.completed`'s output can be matched back to it. */
			id?: string;
			/** `output_item.done` arrived: the arguments are the provider's final ones, not a cut-off buffer. */
			done?: boolean;
			/** `function_call_arguments.done` arrived: `raw` is complete even if `output_item.done` never does. */
			argsDone?: boolean;
		}
	>();
	/*
	 * Slots for streams that leave `output_index` out (llama.cpp does). Falling back to 0 put every
	 * item on one slot: with two parallel calls, `done` of the first wrote its arguments into the
	 * second and the first ran with `{}`. Every event names its item (`item_id`, or `item.id` on
	 * added/done), so that id is the key when the index is missing.
	 */
	const slotsById = new Map<string, number>();
	/** Where an id-less event goes on such a stream: the item opened last. */
	let lastSlot: number | undefined;
	/** Next free slot, kept past every index seen so an invented slot never collides with a real one. */
	let nextSlot = 0;
	const slotOf = (type: string, event: Record<string, any>): number => {
		const id: unknown = event.item_id ?? event.item?.id;
		const known = typeof id === "string" ? slotsById.get(id) : undefined;
		let slot: number;
		if (typeof event.output_index === "number") slot = event.output_index;
		else if (known !== undefined) slot = known;
		else if (
			type === "response.output_item.added" ||
			// A `done` for an item never opened (lossy proxy) is a new item, not the last one's end.
			(type === "response.output_item.done" && (typeof id === "string" || lastSlot === undefined || items.get(lastSlot)?.done))
		)
			slot = nextSlot;
		else slot = lastSlot ?? 0;
		if (typeof id === "string" && known === undefined) slotsById.set(id, slot);
		if (type === "response.output_item.added") lastSlot = slot;
		nextSlot = Math.max(nextSlot, slot + 1);
		return slot;
	};
	/** Stand-in ids for calls the provider did not name, keyed by output index. */
	const inventedIds = new Map<number, string>();
	let incompleteReason: string | undefined;
	/** 模型拒答时说的话：`response.refusal.delta`，或完成的 message 里 `type: "refusal"` 的那段。 */
	let refusal = "";
	/** 收到过、但这里不认识的输出项类型（`image_generation_call`、`web_search_call` 这类服务端工具）。 */
	const unsupported = new Set<string>();
	/** 这次尝试收到过几个能看懂的事件——用来分辨「模型没话说」和「中转发来一团别的东西」。 */
	let framesSeen = 0;
	/** 收到过收尾事件（`response.completed` / `.incomplete`）——没有它就说明流是断的，不是说完了。 */
	let settled = false;
	/** 前几次失败的尝试各自花掉的 token，攒着，最后加进这条消息的用量里。见 `reset`。 */
	let spentOnRetries = emptyUsage();

	/*
	 * Everything the last attempt accumulated, cleared.
	 *
	 * The message is rebuilt from scratch by the retry, and the window replaces rather
	 * than appends — each update carries the whole message — so the abandoned half
	 * disappears the moment the new one starts arriving.
	 *
	 * 两层重试共用这一个。各写一份时这一份漏了 `settled`、那一份漏了 `responseId`：上一次收到过
	 * `response.completed` 的话，下一次断在半路也会被当成说完了。
	 */
	const reset = () => {
		/*
		 * 已经花掉的不清零。
		 *
		 * 内容要清——重试会把整条回答重新写一遍，留着上一半就成了两半拼在一起。可 token
		 * 是另一回事：上一次尝试吐到一半才失败，那些 token 服务商已经收过钱了，清零只是
		 * 让账面上看不见。开着无限重试的窗口于是可以安静地烧穿账单，而界面上的用量始终
		 * 只显示最后成功那一次。按那一次自己的档位计价后再攒，见 `priceAttempt`。
		 */
		spentOnRetries = addUsage(spentOnRetries, priceAttempt(partial.usage, model));
		partial.content = [];
		partial.usage = emptyUsage();
		partial.responseId = undefined;
		items.clear();
		slotsById.clear();
		lastSlot = undefined;
		nextSlot = 0;
		inventedIds.clear();
		incompleteReason = undefined;
		refusal = "";
		unsupported.clear();
		framesSeen = 0;
		settled = false;
		firstTokenTime = null;
	};

	/** 一个输出项类型在这里落成哪种块；认不出的是 `undefined`。 */
	const kindOf = (type: unknown): "text" | "thinking" | "toolCall" | undefined =>
		type === "function_call" ? "toolCall" : type === "reasoning" ? "thinking" : type === "message" ? "text" : undefined;

	/**
	 * 把流里没开过的块放到它该在的位置：按槽号排，不按到达先后。
	 *
	 * 只发 `done` 的中转按到达顺序补，那就是槽号顺序，等于追加。`response.completed` 补回中间缺的那一项时
	 * 不是：缺的推理项追加到调用后面，回放时推理就跑到了它引出的那个调用之后。
	 */
	const place = (slot: number, block: AssistantMessage["content"][number]): number => {
		let at = partial.content.length;
		for (const [other, tracked] of items) if (other > slot && tracked.contentIndex < at) at = tracked.contentIndex;
		for (const tracked of items.values()) if (tracked.contentIndex >= at) tracked.contentIndex++;
		partial.content.splice(at, 0, block);
		return at;
	};

	/** 一项写完了：`output_item.done`，或者 `response.completed` 的 output 里补回来的那一项。 */
	function* finish(slot: number, item: Record<string, any>): Generator<StreamEvent> {
		/*
		 * 没见过 `added` 就来了 `done`——现补一个块，不要把这一项扔掉。
		 *
		 * 这里原本是 `if (!tracked) break;`：没有开过的块就整项丢弃，文本、推理、工具调用
		 * 一视同仁。对守规矩的端点那行永远不会触发，所以它一直看起来没问题；对**只发
		 * `done` 不发 `added`** 的中转（把 Responses 翻译成别的协议时很常见），它意味着整个回复静默消失。
		 *
		 * 文本和推理丢了还看得见——界面空白，用户会来报。工具调用丢了最阴险：`agent/loop.ts`
		 * 按 content 里的 toolCall 决定执行什么，item 没了工具就**静默不跑**，而模型下一轮
		 * 以为自己调过了，于是原地打转。
		 *
		 * `done` 事件里带着这一项的全部内容，补一个块出来所需的东西它都有。
		 */
		let tracked = items.get(slot);
		if (!tracked) {
			const kind = kindOf(item.type);
			if (!kind) {
				if (item.type) unsupported.add(String(item.type));
				return;
			}
			const contentIndex = place(
				slot,
				kind === "toolCall"
					? { type: "toolCall", id: toolCallId(item.call_id ?? item.id, slot, inventedIds), name: toolNameFromStream(item.name), arguments: {} }
					: kind === "thinking"
						? { type: "thinking", thinking: "", signature: item.id, encrypted: item.encrypted_content || undefined }
						: { type: "text", text: "" },
			);
			tracked = { kind, contentIndex, raw: "", id: item.id };
			items.set(slot, tracked);
			framesSeen++;
		}
		tracked.done = true;
		const target = partial.content[tracked.contentIndex];

		if (tracked.kind === "toolCall" && target?.type === "toolCall") {
			/*
			 * 收尾的那个 item 里带的参数说了算，字符串还是对象都认。
			 *
			 * 原本只认字符串，非字符串一律退回流里攒的 `tracked.raw`。对于一次性给完整对象、
			 * 一个 delta 都不发的宿主，那个缓冲区是空的——参数就这么没了，还不报错。
			 */
			const complete = argumentFragment(item.arguments);
			const raw = complete || tracked.raw;
			target.argumentsText = raw;
			target.arguments = parseToolArguments(raw) ?? {};
			// 名字同理：有的端点 `added` 里给空名、到 `done` 才给全。空名留在历史里，回放时只能发占位名。
			if (!target.name) target.name = toolNameFromStream(item.name);
			yield {
				type: "toolcall_end",
				index: slot,
				partial: { ...partial },
			};
		} else if (tracked.kind === "thinking" && target?.type === "thinking") {
			if (item.encrypted_content) target.encrypted = item.encrypted_content;
			// Non-streaming summaries only arrive on the completed item.
			if (!target.thinking && Array.isArray(item.summary)) {
				target.thinking = item.summary.map((s: { text?: string }) => s.text ?? "").join("\n");
			}
			if (target.startedAt !== undefined) target.durationMs = Date.now() - target.startedAt;
			yield { type: "thinking_end", index: slot };
		} else if (tracked.kind === "text" && target?.type === "text") {
			// 只发 `done` 的中转，`phase` 只在这里。
			const phase = messagePhase(item.phase);
			if (phase) target.phase = phase;
			if (!target.text && Array.isArray(item.content)) {
				target.text = item.content.map((c: { text?: string }) => c.text ?? "").join("");
			}
			// 没流式发 `refusal.delta` 的端点，拒答只在完成的 message 里。
			if (!refusal && Array.isArray(item.content)) {
				refusal = item.content.map((c: { type?: string; refusal?: string }) => (c.type === "refusal" ? c.refusal ?? "" : "")).join("");
			}
			yield { type: "text_end", index: slot };
		}
	}

	/*
	 * `response.completed` 带着这次回复完整的一份 `response.output`。流里缺了的、没收尾的项从这里补。
	 *
	 * 原来只从这个事件里取用量和 id。守规矩的端点上这没有区别——每一项都有自己的 `added` / `done`；有损的
	 * 中转上这份 output 是唯一完整的东西：只发 `output_text.delta` 的，deltas 找不到块被扔掉，判成空回答；
	 * 只发 `function_call_arguments.done` 的，判「工具调用没有收尾」反复重试；流里一个字没提的调用，静默
	 * 丢掉、以 `stop` 收场，工具不跑。
	 *
	 * 对回已经流出来的块，认身份只认确凿的东西：item id，以及工具调用的 `call_id`。
	 *
	 * 都对不上的项才当新项补：它自己的位置（`output_index` 就是它在 output 里的下标）空着就放那儿，被占了另开
	 * 一个槽。位置比「同类型里的第几个」更可信——流里的 id 和 completed 里对得上时，对不上就是真的另一项，
	 * 按同类型顺序找一个槽，找出来的可能正是别人的槽：流里只有 `output_index` 1 的 B、completed 里是 A 和 B
	 * 时，A 抢走 B 的槽，B 再补一份，于是 A 漏执行、B 跑两遍。
	 *
	 * 「同类型里的第几个」只留给 id 完全对不上的中转（deepseek-flash 走 Responses 中转时流里和 completed 里
	 * 各发一套 id）：那时 id 和位置都指不到东西，剩下的只有顺序。
	 *
	 * 已经收尾的项一个字不动：文本和推理只在块是空的时候才从这里填，不会和流里的内容叠在一起。
	 *
	 * 不能只认 item id：有的中转在流里和 completed 里各发一套 id（deepseek-flash 走 Responses 中转时就是），
	 * 只按 id 对，整份 output 都被当成新项再追加一遍，每个工具调用跑两次——bash 两次、edit 第二次报找不到原文。
	 */
	function* backfill(output: unknown): Generator<StreamEvent> {
		const list: Record<string, any>[] = Array.isArray(output) ? output : [];
		const claimed = new Set<number>();
		/** 先认确凿的那两条：item id、`call_id`。 */
		const known = list.map((item) => {
			const id = typeof item?.id === "string" ? item.id : undefined;
			const slot = (id === undefined ? undefined : slotsById.get(id)) ?? slotOfCallId(item?.call_id);
			if (slot !== undefined) claimed.add(slot);
			return slot;
		});
		const ordered = [...items.keys()].sort((a, b) => a - b);
		for (let at = 0; at < list.length; at++) {
			const item = list[at] ?? {};
			/*
			 * 位置：`output_index` 就是这一项在 `output` 里的下标，同一个下标上只可能是同一项。它比「同类型里的
			 * 第几个」可靠——后者会指到一个已经被别的项占着、而且已经收尾的槽上，那一项的内容就这么没了。
			 */
			const here = items.get(at);
			let slot = known[at];
			if (slot === undefined && !claimed.has(at) && (here === undefined || here.kind === kindOf(item.type))) slot = at;
			// 剩下的只有顺序：id 整套换过、位置又被占着的中转（deepseek-flash 那类）。
			slot ??= ordered.find((other) => !claimed.has(other) && items.get(other)?.kind === kindOf(item.type));
			if (slot === undefined) slot = items.has(at) ? nextSlot : at;
			claimed.add(slot);
			nextSlot = Math.max(nextSlot, slot + 1);
			if (items.get(slot)?.done) continue;
			yield* finish(slot, item);
		}
		// output 里没列出来、但参数已经说过写完了的调用。
		for (const [slot, tracked] of items) if (tracked.kind === "toolCall" && tracked.argsDone && !tracked.done) yield* finish(slot, { type: "function_call" });
	}

	/** 流里已经开过、`id` 就是这个 `call_id` 的工具调用块所在的槽。 */
	function slotOfCallId(callId: unknown): number | undefined {
		if (typeof callId !== "string" || !callId) return undefined;
		for (const [slot, tracked] of items) {
			const block = partial.content[tracked.contentIndex];
			if (tracked.kind === "toolCall" && block?.type === "toolCall" && block.id === callId) return slot;
		}
		return undefined;
	}

	const retryBudget = new RetryBudget(options.retryPolicy, options.retryAttempts);
	try {
		/*
		 * The whole exchange, not just the connection.
		 *
		 * A socket that dies while the reply is streaming used to end the turn outright — and the
		 * longer the reply, the wider that window, so it fell hardest on exactly the long pieces
		 * of work where losing a turn costs the most. Nothing has happened yet when it dies:
		 * tools run after a complete reply arrives, so the reply can simply be asked for again.
		 */
		yield* withReasoningRetry(scope.providerId, scope.modelId, reset, (providerId, modelId, said) =>
			learnToolPairing(providerId, modelId, said) ||
			learnToolResultImages(providerId, modelId, said) ||
			// 告诉参数轴这次到底发没发 `effort: "none"`，见 `learnDroppedParam` 的 `sent`。
			learnDroppedParam(providerId, modelId, said, { reasoningOff: (body.reasoning as { effort?: string } | undefined)?.effort === "none" }) ||
			learnLeadingReasoning(providerId, modelId, said), async function* (replay) {
			body = buildBody(replay);
			options.onPayload?.(body);
			yield* retryStream(
			async function* attempt() {
				const response = await fetchWithRetry(
					doFetch,
					joinUrl(provider.baseUrl, "/v1/responses"),
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"user-agent": USER_AGENT,
							authorization: `Bearer ${provider.apiKey}`,
							...cacheRouting(options.cacheKey, droppedParams(scope.providerId, scope.modelId)).headers,
							...requiredHeaders,
						},
						body: JSON.stringify(body),
						signal: options.signal,
					},
					{
						budget: retryBudget,
						signal: options.signal,
						onRetry: options.onRetry,
						stream: true,
					},
				);

				if (!response.ok) {
					// 走到这里说明 `fetchWithRetry` 已经判过并且决定不再重试；带着结论抛，别让上面
					// 那层拿一个 `HTTP 401: ...` 字符串重新猜。
					const detail = await response.text().catch(() => "");
					throw new FailureError(classifyFailure({ from: "status", status: response.status, body: detail }));
				}

				yield { type: "start", partial: { ...partial } } as StreamEvent;

				/** 这次尝试里没能解析的帧，留一份原文，空回答时用来说明收到的到底是什么。 */
				let unparsable = "";
				/** 这条流被空闲闸掉了吗。见 `readSseWithIdleTimeout`。 */
				const idle = { tripped: false };
				for await (const frame of readSseWithIdleTimeout(response, options.signal, STREAM_IDLE_TIMEOUT_MS, idle)) {
					if (frame.data === "[DONE]") break;
					let event: Record<string, any>;
					try {
						event = JSON.parse(frame.data);
					} catch {
						if (!unparsable) unparsable = frame.data.slice(0, 500);
						continue;
					}
					framesSeen += 1;

					const type: string = event.type ?? frame.event ?? "";
					const outputIndex = slotOf(type, event);

					switch (type) {
						case "response.output_item.added": {
							const item = event.item ?? {};
							if (item.type === "message") {
								const phase = messagePhase(item.phase);
								partial.content.push({
									type: "text",
									text: "",
									signature: item.id,
									...(phase ? { phase } : {}),
								});
								items.set(outputIndex, {
									kind: "text",
									contentIndex: partial.content.length - 1,
									raw: "",
									id: item.id,
								});
								yield { type: "text_start", index: outputIndex };
							} else if (item.type === "reasoning") {
								partial.content.push({
									type: "thinking",
									thinking: "",
									signature: item.id,
									encrypted: item.encrypted_content || undefined,
									startedAt: Date.now(),
								});
								items.set(outputIndex, {
									kind: "thinking",
									contentIndex: partial.content.length - 1,
									raw: "",
									id: item.id,
								});
								yield { type: "thinking_start", index: outputIndex };
							} else if (item.type === "function_call") {
								partial.content.push({
									type: "toolCall",
									// call_id is the handle the API expects back on function_call_output.
									id: toolCallId(item.call_id ?? item.id, outputIndex, inventedIds),
									name: toolNameFromStream(item.name),
									arguments: {},
									argumentsText: "",
									signature: item.id,
								});
								items.set(outputIndex, {
									kind: "toolCall",
									contentIndex: partial.content.length - 1,
									raw: "",
									id: item.id,
								});
								yield {
									type: "toolcall_start",
									index: outputIndex,
									id: toolCallId(item.call_id ?? item.id, outputIndex, inventedIds),
									name: toolNameFromStream(item.name),
								};
							}
							break;
						}

						case "response.refusal.delta": {
							refusal += event.delta ?? "";
							break;
						}

						case "response.output_text.delta": {
							if (firstTokenTime === null) firstTokenTime = Date.now();
							const tracked = items.get(outputIndex);
							const target = tracked ? partial.content[tracked.contentIndex] : undefined;
							if (target?.type === "text") {
								target.text += event.delta ?? "";
								yield {
									type: "text_delta",
									index: outputIndex,
									delta: event.delta ?? "",
									partial: { ...partial },
								};
							}
							break;
						}

						/*
						 * 推理摘要可以分好几段，每段一个 `summary_part`。段与段之间协议不带任何分隔，直接拼起来
						 * 上一段的末句和下一段的标题粘成一行（`…目录结构。**检查测试**`），所以新的一段开头补一个空行。
						 */
						case "response.reasoning_summary_part.added": {
							const tracked = items.get(outputIndex);
							const target = tracked ? partial.content[tracked.contentIndex] : undefined;
							if (target?.type === "thinking" && target.thinking) {
								target.thinking += "\n\n";
								yield { type: "thinking_delta", index: outputIndex, delta: "\n\n", partial: { ...partial } };
							}
							break;
						}

						// Providers differ: some stream a reasoning summary, some stream raw reasoning text.
						case "response.reasoning_summary_text.delta":
						case "response.reasoning_text.delta": {
							if (firstTokenTime === null) firstTokenTime = Date.now();
							const tracked = items.get(outputIndex);
							const target = tracked ? partial.content[tracked.contentIndex] : undefined;
							if (target?.type === "thinking") {
								target.thinking += event.delta ?? "";
								yield {
									type: "thinking_delta",
									index: outputIndex,
									delta: event.delta ?? "",
									partial: { ...partial },
								};
							}
							break;
						}

						case "response.function_call_arguments.delta": {
							if (firstTokenTime === null) firstTokenTime = Date.now();
							const tracked = items.get(outputIndex);
							if (!tracked) break;
							// 协议说 delta 是字符串分片，但转译层不一定守；对象接上去会变成 `"[object Object]"`。
							tracked.raw += argumentFragment(event.delta);
							const target = partial.content[tracked.contentIndex];
							if (target?.type === "toolCall") target.argumentsText = tracked.raw;
							yield {
								type: "toolcall_delta",
								index: outputIndex,
								delta: event.delta ?? "",
								partial: { ...partial },
							};
							break;
						}

						/*
						 * 参数到这里就是完整的了，哪怕后面的 `output_item.done` 没来（有的中转只转这一个）。
						 * 只记下，不在这里收尾：`output_item.done` 照常来的话由它收，没来的由 `response.completed` 收。
						 */
						case "response.function_call_arguments.done": {
							const tracked = items.get(outputIndex);
							if (tracked?.kind !== "toolCall") break;
							const complete = argumentFragment(event.arguments);
							if (complete) tracked.raw = complete;
							tracked.argsDone = true;
							const target = partial.content[tracked.contentIndex];
							if (target?.type === "toolCall") target.argumentsText = tracked.raw;
							break;
						}

						case "response.output_item.done": {
							yield* finish(outputIndex, event.item ?? {});
							break;
						}

						case "response.completed":
						case "response.incomplete": {
							applyUsage("openai-responses", partial.usage, event.response?.usage);
							partial.responseId = event.response?.id;
							incompleteReason = event.response?.incomplete_details?.reason;
							// 只在正常完成时补：被截断的那份 output 里，没写完的项本来就不该被当成写完了。
							if (type === "response.completed") yield* backfill(event.response?.output);
							settled = true;
							break;
						}

						case "response.failed":
						case "error": {
							/*
							 * 从前这里直接放弃，理由写在一行注释里：「服务商自己拒绝了，再问也是同样
							 * 答复」。对官方直连大致成立，对中转完全不成立——中转把上游的过载、限流、
							 * 断流全塞进这个事件里，而且经常连 message 都不给，于是只能显示成
							 * `Unknown provider error`，三层重试全部绕过，设置页上的「无限重试」形同
							 * 虚设。
							 *
							 * 现在它抛出去，由 `retryStream` 按分类决定。真正该拒绝的（内容策略、
							 * 额度）会被判成 `fatal` 原样抛到最外面，和从前的行为一模一样——区别只是
							 * 这个结论现在来自事件的内容，而不是来自「它出现在流里」这个位置。
							 */
							/*
							 * `response.failed` carries the Response object, usage included: the provider
							 * billed this attempt. Recorded before throwing so `reset` folds it into the
							 * bill when a retry follows, and `failedStreamEvent` settles it when none does.
							 * A bare `error` event has no `response`, and `applyUsage` ignores that.
							 */
							applyUsage("openai-responses", partial.usage, event.response?.usage);
							const said = event.response?.error?.message ?? event.message;
							throw new FailureError(
								classifyFailure({
									from: "stream",
									message: typeof said === "string" ? said : undefined,
									raw: JSON.stringify(event).slice(0, 4000),
									// 流已经吐过字，这次的 token 服务商已经收过钱了。
									spent: partial.usage.output > 0 || partial.content.length > 0,
									streamed: spokenSoFar(partial.content),
								}),
							);
						}
					}
				}

				/*
				 * 被空闲闸掉的，按连接问题抛，排在这三条判定之前。
				 *
				 * 挂死时内容常常正好是空的，也正好没有收尾事件——三条判定都会认领它，而它们说出来的原因
				 * 都不对。放在最前面是因为它知道得最确切：计时器响了，不是推断出来的。见 Anthropic 链上
				 * 同一段。
				 */
				if (idle.tripped) {
					throw new FailureError(
						classifyFailure({ from: "transport", error: new Error(`流空闲超过 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒`) }),
					);
				}

				// 拒答：和另外两条链同一个出口，判成内容策略、不重试。从前它落成一条空回答被重试，所以排在空回答之前。
				/*
				 * 回复里只有一个认不出的输出项，是这一轮唯一的「内容」被扔掉了，不是模型没话说。
				 *
				 * 实测（2026-10-08）：CLIProxyAPI 的「图像生成行为」为「已启用」时，会往每个 Codex 请求里自己加
				 * 一个 `image_generation` 内置工具；模型出图时调它而不调 `image_generate`，回来的是一个
				 * `image_generation_call` 加一条空 message。从前那条空 message 被当成空回复，自动「继续」三次、
				 * 每次都再出一张图、每次都扔掉，最后才报「连续返回空回复」。
				 *
				 * 判成不重试：同样的请求再发一遍还是同样的结果。说出是哪一种，人才知道该去改哪儿。
				 */
				const said = partial.content.some((c) => (c.type === "text" && c.text.trim()) || c.type === "toolCall");
				if (unsupported.size > 0 && !said && !refusal.trim()) {
					const kinds = [...unsupported].join("、");
					const failure = classifyFailure({ from: "stream", message: `模型返回了不支持的内容：${kinds}`, spent: true });
					throw new FailureError({
						...failure,
						kind: "fatal",
						detail: `回复里只有 ${kinds}，没有正文或工具调用。多半是中转往请求里加了服务端工具（比如 CLIProxyAPI 的「图像生成行为」为「已启用」），在中转那边改成「仅透传」或关掉即可。`,
					});
				}

				if (refusal.trim()) {
					throw new FailureError(classifyFailure({ from: "stream", message: `${REFUSAL_MESSAGE}：${refusal.trim()}`, spent: true }));
				}

				/*
				 * 空回答也是失败，不是「模型没话说」。
				 *
				 * 从前流正常结束而一个字都没有时，这里什么都不做，最后以 `stopReason: "stop"` 收场
				 * ——屏幕上是一条空白的回答，既不报错也不重试。故障真值表里有三种故障长这样：一个
				 * 把错误写成 JSON 却回 200 的中转、一个空流、一串非法 JSON。它们和真正的空回答在结局
				 * 上完全无法区分，而后者本来就不该发生：模型即使无话可说也会给出 `response.completed`
				 * 和至少一个 item。
				 *
				 * `max_output_tokens` 截断的空也走这里：从前它被放过去当成一条 `length` 的空回答，loop 让它「接着写」，
				 * 而它从头再想一遍、再把上限用完。分类器把它判成「输出上限被推理用完」，不重试，和另两条链一样。
				 */
				if (partial.content.length === 0 && (!incompleteReason || incompleteReason === "max_output_tokens")) {
					throw new FailureError(
						classifyFailure({
							from: "empty",
							why: unparsable ? "unparsable" : framesSeen === 0 ? "no-frames" : "no-content",
							body: unparsable || undefined,
							output: { truncated: incompleteReason === "max_output_tokens" },
						}),
					);
				}

				/*
				 * 吐了一半就断掉，也是失败，不是「说完了」。
				 *
				 * 上面那条只管一个字都没有的情况。真正难发现的是另一种：模型吐了半段回答，连接断了，而
				 * `response.completed` / `response.incomplete` 从来没来过。流循环正常退出，这条半截消息被
				 * 标成 `stop` 交给 `agent/loop.ts` 继续往下跑——用户看到一个无声截断的回答，没有错误、没有
				 * 重试、没有任何迹象说这里少了东西。中间设备在长回答上掐断连接时就是这个形状。
				 *
				 * Chat Completions 那条链做的是同一件事：有内容但既没 `finish_reason` 也没 `[DONE]` 就抛。
				 * Responses 这边的收尾信号是那两个事件。
				 *
				 * 判成可重试：什么都还没发生——工具要等一条完整回复到手才跑，所以重新问一遍就行。`spent`
				 * 如实填，那半段的 token 服务商已经收过钱了，用量要算进去。
				 */
				if (!settled) {
					throw new FailureError(
						classifyFailure({
							from: "stream",
							message: "回复没有收尾就断了（没有收到 response.completed）",
							spent: partial.usage.output > 0 || partial.content.length > 0,
							streamed: spokenSoFar(partial.content),
						}),
					);
				}

				/*
				 * 被内容策略拦下，不是「说完了」。
				 *
				 * `incomplete_details.reason` 除了 `max_output_tokens` 还有别的值，而我们原先只认那一个：
				 * 其余一律落进下面的 `stopReason: "stop"`，于是被策略拦掉的一轮在界面上是一条**正常结束的
				 * 空回答**，既不说明原因也不重试。`content_filter` 是其中最要紧的一个——它该让用户知道，
				 * 而不是装作模型无话可说。
				 *
				 * 判成 `blocked`（不可重试）：同样的输入再发一遍还是同样的结果，重试只是多烧一次钱。
				 */
				if (incompleteReason && incompleteReason !== "max_output_tokens") {
					throw new FailureError(
						classifyFailure({
							from: "stream",
							message:
								incompleteReason === "content_filter"
									? "这次回复被内容策略拦下了（content_filter）"
									: `回复没有正常结束：${incompleteReason}`,
							spent: partial.usage.output > 0 || partial.content.length > 0,
							streamed: spokenSoFar(partial.content),
						}),
					);
				}

				/*
				 * A tool call whose `output_item.done` never came is not finished, even though the response is.
				 *
				 * Its arguments are whatever the deltas left behind: cut off mid-string, or mixed with another
				 * call's. Handed over as `toolUse`, the loop runs it — with `{}`, or with half a
				 * `rm -rf /tmp/build`. Same exit as the cut-off stream above: nothing has run yet, so asking
				 * again is safe. `max_output_tokens` is exempt: that reply is `length`, and the loop already
				 * refuses to run the calls of a truncated reply.
				 */
				const unfinished = [...items.values()].find((item) => item.kind === "toolCall" && !item.done);
				if (unfinished && !incompleteReason) {
					const call = partial.content[unfinished.contentIndex];
					throw new FailureError(
						classifyFailure({
							from: "stream",
							message: `回复里的工具调用没有收尾（没有收到 response.output_item.done）：${call?.type === "toolCall" ? `${call.name} (${call.id})` : "?"}`,
							spent: partial.usage.output > 0 || partial.content.length > 0,
						}),
					);
				}
			},
			{
				budget: retryBudget,
				signal: options.signal,
				onRetry: options.onRetry,
				reset,
			},
			);
		});
	} catch (error) {
		// 失败时这条消息长什么样，三条链一致——见 `failedStreamEvent`。
		yield failedStreamEvent(partial, {
			error,
			signal: options.signal,
			model,
			spentOnRetries,
			startTime,
			firstTokenTime,
		});
		return partial;
	}

	partial.durationMs = Math.max(1, Date.now() - startTime);
	if (firstTokenTime !== null) {
		partial.sseDurationMs = Math.max(1, Date.now() - firstTokenTime);
	}
	partial.stopReason =
		incompleteReason === "max_output_tokens"
			? "length"
			: partial.content.some((c) => c.type === "toolCall")
				? "toolUse"
				: "stop";
	// 成功了，但失败的那几次也是花过钱的——账上要有。各按各的档位计价再相加，见 `priceAttempt`。
	settleUsage(partial, model, spentOnRetries);
	yield { type: "done", message: { ...partial } };
	return partial;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------
