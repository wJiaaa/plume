/**
 * OpenAI Chat Completions API adapter (`POST /v1/chat/completions`).
 */

import { toChatCompletionsMessages, toChatCompletionsTools, wantsCacheBreakpoints, withCacheBreakpoints } from "./openai-chat-completions-request.ts";
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
	ToolCallContent,
} from "../types.ts";
import { addUsage, emptyUsage } from "../types.ts";
import { computeCost } from "../utils/pricing.ts";
import { classifyFailure, FailureError, REFUSAL_MESSAGE, spokenSoFar } from "./failure.ts";
import { RetryBudget, fetchWithRetry, retryStream, toolCallId } from "./retry.ts";
import { argumentFragment, parseToolArguments, readSseWithIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from "../utils/sse.ts";
import {
	contentOfDelta,
	mapFinishReason,
	nextArguments,
	reasoningFromDelta,
	streamErrorOf,
	stripDeepseekTokens,
	trailingPartialDeepseekToken,
	usageOf,
} from "./chat-delta.ts";
import { THINK_TAG_FIELD, ThinkTagSplitter } from "./think-tag.ts";
import { USER_AGENT, failedStreamEvent, joinUrl, priceAttempt, settleUsage } from "./endpoint.ts";
import { resolveReasoningEffort } from "./thinking-options.ts";
import { learnReasoningPadding, padsMissingReasoning, withReasoningRetry, type ReasoningReplay } from "./reasoning-compat.ts";
import { droppedParams, learnDroppedParam, type SentParams } from "./request-params-compat.ts";
import { thinkingDialect } from "./vendors/index.ts";
import { chatThinkingFields } from "./vendors/thinking.ts";
import { compatKey, compatScope } from "./compat-key.ts";
import { applyUsage } from "./usage-fields.ts";
import { cacheRouting, sessionHeaders } from "./cache-routing.ts";

export const openaiChatCompletionsProvider: Provider = {
	api: "openai-chat-completions",
	stream: streamChatCompletions,
};

// ---------------------------------------------------------------------------
// 撞一次学一次：这个端点把输出上限写在哪个键上
// ---------------------------------------------------------------------------

/**
 * 输出上限该写在哪个键上——这条只能靠撞出来。
 *
 * 和 `reasoning-compat.ts`、`request-params-compat.ts` 同一个路子，理由也同一个：**我们手上没有普查
 * 表**。按厂商、主机名、模型家族把这件事查出来，要的是几百个端点的实测积累，攒不起来也维护不起。
 *
 * 能靠的是另一样东西：**这种 400 的错误串自带诊断**——它直接点名该用哪个字段。所以默认保持这条链现在
 * 发的那个键（不动任何现在能用的端点），撞上那句话就学到结论、换个键重发一次。
 *
 * 采样参数和 `tool_choice` 那两条轴**不在这里**，在 `request-params-compat.ts`——那是三条链共用的一份，
 * 两条链各写一份同样的正则是纯负债。这里只留「换字段名」这一条，因为它不是「撤掉一个参数」，撤不掉：
 * 输出上限必须发，只是键名有两种。
 *
 * 记在内存里，不落盘，理由见 `reasoning-compat.ts` 顶部：进程重启后重新学一次的代价是一次自愈的重发，
 * 换来的是不必为它做设置迁移，也不必担心一条学错的结论永久粘在用户的配置里。
 */
export type MaxTokensField = "max_tokens" | "max_completion_tokens";

/** 学到的结论：`${providerId} ${modelId}` → 用哪个键。键的拼法跟另外几条轴对齐。 */
const learned = new Map<string, MaxTokensField>();

const key = compatKey;

/** 这个模型该用哪个键。没撞过之前就是这条链一直在发的那个。 */
export function maxTokensField(providerId: string, modelId: string): MaxTokensField {
	return learned.get(key(providerId, modelId)) ?? "max_tokens";
}

/** 测试用：把学到的都忘掉。 */
export function resetChatCompletionsCompat(): void {
	learned.clear();
}

/**
 * 「用另一个字段名」——端点自己点名了。
 *
 * OpenAI 官方对 o 系列和 gpt-5.x 的原话（走 `/v1/chat/completions` 时）：
 *
 *     Unsupported parameter: 'max_tokens' is not supported with this model.
 *     Use 'max_completion_tokens' instead.
 *
 * 抓的是后半句里被点名的那个字段。双向都认：万一学过头了、端点反过来说要 `max_tokens`，同一条规则能把
 * 它送回来，不会卡在错的那一格上。
 */
const USE_FIELD_INSTEAD = /use\s+["'`]?(max_tokens|max_completion_tokens)["'`]?\s+instead/i;

/**
 * 后半句被中转裁掉时的兜底：只剩「`max_tokens` 不支持」。
 *
 * 推断，未验证——没有实测样本。认它的理由是这一句里已经没有别的可做：我们只会发这两个字段名之一，说
 * `max_tokens` 不支持就只剩另一个可试。要求「不支持」紧跟在字段名后面（40 字以内、不跨句号），免得把
 * 一段顺口提到 `max_tokens` 的长错误也算进来。
 */
const MAX_TOKENS_UNSUPPORTED = /["'`]?max_tokens["'`]?[^.]{0,40}?(is not supported|not supported|unsupported|unrecognized|unknown)/i;

/**
 * 从一次失败里学点东西。返回「结论变了，值得换个形状重发一次」。
 *
 * 签名对上 `withReasoningRetry` 的 `alsoLearn`，而且**排在推理那条梯子前面**看——理由见那个参数的注释：
 * 指向明确的轴先看，误判的机会小得多。这里两条的指向再明确不过，错误串里点着字段名。
 *
 * 两个学习器都要问，**不能用 `||` 短路**：一句话可以同时点名两样（`max_tokens` 该换名、`temperature`
 * 不该发），短路会漏掉后一条，然后下一次重发再撞一遍同一句话。
 */
export function learnChatCompletionsCompat(providerId: string, modelId: string, error: string, sent?: SentParams): boolean {
	const learnedField = learnMaxTokensField(providerId, modelId, error);
	/*
	 * 共用的那份参数轴（`request-params-compat.ts`）也来看一眼。
	 *
	 * 这条链只读它管的参数里 `readHere` 那几个。`include-encrypted` 是 Responses 专属的 `include` 数组，这条链
	 * 压根不发，所以学到它**不算**「值得重发」——重发的请求体会和刚被拒的那份一模一样，白烧一次钱。
	 *
	 * `reasoning-off` 起初也在排除之列，因为这条链关思考时什么都不发。后来实测发现「什么都不发」在
	 * DeepSeek 上根本关不掉思考（见上面 `reasoning_effort` 那段的七种写法对照），改成了明说
	 * `reasoning_effort: "none"`——于是这条链开始读它了，白名单必须跟着加。前提变了，判断就得跟着变。
	 *
	 * `droppedParams` 返回的是内部那个 Set 的引用，不是副本，所以要先抄一份快照再去学。
	 */
	const before = new Set(droppedParams(providerId, modelId));
	learnDroppedParam(providerId, modelId, error, sent);
	const after = droppedParams(providerId, modelId);
	const readHere = ["sampling", "tool-choice", "reasoning-off", "cache-key", "cache-control"] as const;
	const droppedHere = readHere.some((param) => after.has(param) && !before.has(param));
	return learnedField || droppedHere;
}

/** 换字段名这一条。双向都认，理由见 `USE_FIELD_INSTEAD`。 */
function learnMaxTokensField(providerId: string, modelId: string, error: string): boolean {
	const id = key(providerId, modelId);
	const now = learned.get(id) ?? "max_tokens";
	const wanted = error.match(USE_FIELD_INSTEAD)?.[1] as MaxTokensField | undefined;
	const next = wanted ?? (now === "max_tokens" && MAX_TOKENS_UNSUPPORTED.test(error) ? "max_completion_tokens" : now);
	if (next === now) return false;
	learned.set(id, next);
	return true;
}

// ---------------------------------------------------------------------------
// 入站：一个 tool_calls 分片属于哪个调用
// ---------------------------------------------------------------------------

/** 流里开过的一个工具调用，和宿主给它的两个标识（都可能缺）。 */
interface StreamedCall {
	block: ToolCallContent;
	index: number | undefined;
	id: string | undefined;
	/** 参数按对象分片发来时，到目前为止合并出的那一份。见 `nextArguments`。 */
	object?: Record<string, unknown>;
}

/**
 * 这个分片接在哪个已开的调用上；返回 undefined 表示它开了一个新调用。
 *
 * 协议里 `index` 是区分并行调用的那个键，后续分片只带 `index` 不带 `id`。从前写的是 `tc.index ?? 0`：
 * 不带 `index` 的宿主会把几个并行调用全拼进第 0 块——参数串成 `{"a":1}{"b":2}`，解析失败，两次
 * 调用变成一次参数为空的调用。另一种坏法是 `index` 都给 0、但 `id` 各不相同（把别家协议转成这个
 * 形状的中转常见）。所以按可靠程度依次看：
 *
 *   1. 带着见过的 `id`：就是那个调用。
 *   2. 带着没见过的 `id`：新调用——哪怕 `index` 和某个已开的撞了，那个调用已经有别的 `id` 了。
 *   3. 只带 `index`：按 `index` 找。
 *   4. 两样都没有：接在最近开的那个调用上——没带标识的分片只能是续写。
 */
function findToolCall(tc: { index?: unknown; id?: unknown }, calls: StreamedCall[]): StreamedCall | undefined {
	const id = typeof tc.id === "string" && tc.id ? tc.id : undefined;
	const index = typeof tc.index === "number" ? tc.index : undefined;
	if (id !== undefined) {
		const byId = calls.find((call) => call.id === id);
		if (byId) return byId;
		const byIndex = index === undefined ? undefined : calls.findLast((call) => call.index === index);
		// 同一个 index 上先来的那个没带 id（首个分片只给了 index），这个带 id 的分片就是它的，补上。
		if (byIndex && byIndex.id === undefined) {
			byIndex.id = id;
			return byIndex;
		}
		return undefined;
	}
	// 取最近的那个：共用一个 index 的宿主，续写分片属于同 index 里最后开的那个调用。
	if (index !== undefined) return calls.findLast((call) => call.index === index);
	return calls.at(-1);
}

/** `finish_reason` 之后再等多久就不等了，按帧续期。见流里 `finished` 那一段。 */
const FINISH_GRACE_MS = 2_500;

async function* streamChatCompletions(
	provider: ProviderConfig,
	model: ModelConfig,
	context: LlmContext,
	options: RequestOptions,
): AsyncGenerator<StreamEvent, AssistantMessage> {
	const startTime = Date.now();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-chat-completions",
		provider: provider.id,
		model: model.modelId,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: startTime,
	};

	const reasoningEffort = resolveReasoningEffort(options.thinking, model);
	const thinkingEnabled = reasoningEffort !== undefined;
	/** 学和查都用这一对 id，见 `compat-key.ts`。 */
	const scope = compatScope(provider, model);
	/** 这个模型族的思考开关怎么写，见 `vendors/`。 */
	const dialect = thinkingDialect(provider.baseUrl, model.modelId || model.id);

	/*
	 * 每次尝试重新编一遍，因为**推理形状可能在两次之间变掉**。
	 *
	 * 端点对「把推理还回去」的态度是撞出来的，不是配出来的（见 `reasoning-compat.ts`）。被顶回来的那
	 * 一次会记下结论、换个形状重发——那就必须能重新编一份请求体，而不是把第一次编好的那份再发一遍。
	 */
	const buildBody = (replay: ReasoningReplay): Record<string, unknown> => {
		const tokensField = maxTokensField(scope.providerId, scope.modelId);
		const dropped = droppedParams(scope.providerId, scope.modelId);
		/*
		 * 采样参数：撞过一次 400 之后就一个都不发，连 `options.temperature` 一起。
		 *
		 * 这里也是**现有那个闸漏水的地方**。`temperature` 上方挂着 `!thinkingEnabled`，意思清楚——推理模式
		 * 下不发采样参数——然后下面两行 `...model.samplingParams, ...options.samplingParams` 无条件展开，把
		 * 刚挡住的又放回来了。用户在设置里填一个 `{"temperature": 0.7}`，配上 OpenAI 的 o 系列或 gpt-5.x，
		 * 每一轮都是 400。
		 *
		 * 没有去把那个闸补严（推理模式下顺手把 samplingParams 里的采样键也剔掉），是因为那会改变一批**现在
		 * 正常工作**的端点上的行为：DeepSeek 系推理模型收 `temperature`（只是忽略它），别的宿主在推理模式下
		 * 确实按它采样。剔掉等于替用户否决一个他明确填过的值，而我手上没有证据说哪些端点该剔。
		 *
		 * 可学的那条路没有这个问题：默认一字不改，撞上那句点名 `temperature` 的 400 才全省，然后重发。
		 * 那条轴和它的证据在 `request-params-compat.ts`，三条链共用一份。
		 */
		const sampling = dropped.has("sampling") ? {} : { ...model.samplingParams, ...options.samplingParams };
		/*
		 * 学到该用 `max_completion_tokens` 之后，`max_tokens` 必须从采样参数里也清掉。
		 *
		 * 不清的话，用户手填的那个键会在下面 `...sampling` 里重新出现，两个字段同时在请求里——而顶回来我们
		 * 的那个端点正是因为不认识 `max_tokens` 才顶的，它会再顶一次，学到的结论白学。
		 */
		if (tokensField !== "max_tokens" && "max_tokens" in sampling) {
			delete (sampling as Record<string, unknown>).max_tokens;
		}
		const messages = toChatCompletionsMessages(
			context.systemPrompt ?? "",
			sanitizeToolPairing(context.messages),
			replay,
			model,
			padsMissingReasoning(scope.providerId, scope.modelId),
		);
		return {
			model: model.modelId,
			// Claude 经中转时放缓存断点，端点点名不认就不放了：见 `withCacheBreakpoints`。
			messages: wantsCacheBreakpoints(model.modelId) && !dropped.has("cache-control") ? withCacheBreakpoints(messages) : messages,
			stream: true,
			stream_options: { include_usage: true },
			/*
			 * 字段名是学出来的，不是写死的。
			 *
			 * 默认 `max_tokens`——这条链一直发的那个，绝大多数 OpenAI 兼容端点只认它。而 OpenAI 官方的 o
			 * 系列、o4-mini、gpt-5.x 走 `/v1/chat/completions` 时只认 `max_completion_tokens`，发前者是
			 * 400，每一轮都挂，裁史重试救不了（请求形状的错跟历史长度无关）。
			 *
			 * 反过来默认 `max_completion_tokens`、只给少数端点用 `max_tokens`，得有一张按端点分流的表。我们
			 * 没有那张表，所以**保持现在这个，撞上才学**。理由见 `MaxTokensField` 上面那段——那个 400 会直接点名正确字段。
			 */
			[tokensField]: options.maxTokens ?? model.maxOutputTokens,
			/*
			 * 没有工具的时候，`tools` 和 `tool_choice` 两个都不发——这一条一直是对的，`tool_choice` 挂在
			 * `tools` 的同一个条件里（一个没有工具可管的 `tool_choice` 会绊倒 LiteLLM → Bedrock 那条路）。
			 *
			 * 有工具时 `tool_choice: "auto"` **默认照发**，撞上才省——那条轴在 `request-params-compat.ts`。
			 *
			 * 为什么不直接省掉它（一度真省了，又退回来了）：本项目 2026-09-11 在用户自己那两个端点上实测发
			 * `tool_choice: "auto"` 得 200（探针 `test/responses-params-probe.ts`；那一轮测的是 Responses 端点，不是这条链）。手上没有不收它的
			 * 端点，而 `auto` 本来就是服务端在有 `tools` 时的默认值（OpenAI API 文档：`auto` is the default if
			 * functions are present）——收益为零。零收益不足以支撑一次默认行为变更。
			 */
			...(context.tools.length > 0
				? {
						tools: toChatCompletionsTools(context.tools),
						...(dropped.has("tool-choice") ? {} : { tool_choice: "auto" }),
					}
				: {}),
			/*
			 * 关思考要**明说**，不能靠不发。
			 *
			 * 这条链原本什么都不发（`resolveReasoningEffort` 在 `off` 上返回 undefined），理由是「不发在所有
			 * 端点上都不会是 400」——安全，但**关不掉**。2026-09-11 在 `api.deepseek.com/v1/chat/completions`
			 * 上量过一张表（探针
			 * `test/cc-open-questions-probe.ts`），同一个问题七种写法：
			 *
			 *     什么都不发（原来这样）      推理 45 字   ← 关不掉
			 *     reasoning_effort: "low"     推理 63 字   ← 关不掉
			 *     reasoning_effort: "minimal" 推理 39 字   ← 关不掉
			 *     enable_thinking: false      推理 57 字   ← 关不掉
			 *     reasoning: {enabled:false}  推理 48 字   ← 关不掉
			 *     thinking: {type:"disabled"} 推理  0 字
			 *     reasoning_effort: "none"    推理  0 字   ← 用这个
			 *
			 * 不发等于用服务端默认，而这个模型的服务端默认就在思考。用户在界面上关掉思考、以为省下了那笔
			 * 钱，实际上模型照想不误、推理 token 照收——不报错，不可见，只是账单不对。
			 *
			 * 这也顺带否掉了「发最低一档 effort 来关」的做法：`low` 和 `minimal` 在这个端点上都关不掉。
			 *
			 * 发 `"none"` 的风险是有端点不认这个值（Gemini/Vertex 的原话是
			 * `none is not a valid ThinkingLevel enum value`，`effort: "none"` 也是 GPT-5.1 之后才加的），
			 * 所以它挂在可学的轴下面：撞上就退回「什么都不发」，也就是这条链原来的行为。两条 OpenAI 链现在
			 * 用的是同一条轴、同一个信号。
			 *
			 * Gemini is not left to learn it: Gemini 2.5 behind a relay rejects `"none"` with a 400 that names
			 * nothing, so there would be nothing to learn from. That prior lives in `vendors/`.
			 */
			...chatThinkingFields(dialect, { effort: thinkingEnabled ? reasoningEffort : undefined, supportsThinking: model.supportsThinking, dropped }),
			...(options.temperature !== undefined && !thinkingEnabled && !dropped.has("sampling")
				? { temperature: options.temperature }
				: {}),
			// 缓存路由键，被拒过就不再带。见 `cache-routing.ts`。
			...cacheRouting(options.cacheKey, dropped).body,
			...sampling,
		};
	};
	/*
	 * Built by each attempt below, not here as well. It used to be built once up front and again by
	 * the first attempt, with `onPayload` (a hash of every message, for the cache-prefix check) run on
	 * both: twice the per-request cost of a history that only grows. Nothing reads it in between, and
	 * a build that throws still surfaces — the retry wrapper rethrows what no learner recognises.
	 */
	let body: Record<string, unknown> = {};

	const doFetch = options.fetch ?? globalThis.fetch;
	// 在这里算一次，重试沿用同一个会话 id。
	const requiredHeaders = sessionHeaders(provider.baseUrl, options.cacheKey);
	let firstTokenTime: number | null = null;
	const inventedIds = new Map<number, string>();
	/** 收到过几个能看懂的事件——用来分辨「模型没话说」和「中转发来一团别的东西」。 */
	let framesSeen = 0;
	/** 前几次失败的尝试各自花掉的 token，攒着，最后加进这条消息的用量里。见 `reset`。 */
	let spentOnRetries = emptyUsage();

	/*
	 * 上一次尝试留下的一切清掉，两层重试共用这一个。
	 *
	 * `stopReason` 这条原来两份都漏了：它是在流里随 `finish_reason` 直接写到 `partial` 上的，上一次
	 * 尝试收到过 `length` 而这一次的宿主不发 `finish_reason`（只靠 `[DONE]` 收尾），重试成功的回答
	 * 就带着上一次的 `length` 交出去——工具调用被当成半截的，一个都不执行。
	 */
	const reset = () => {
		// 已经花掉的 token 不清零，按那一次自己的档位计价后攒着，见 Responses 适配器里同一段和 `priceAttempt`。
		spentOnRetries = addUsage(spentOnRetries, priceAttempt(partial.usage, model));
		partial.content = [];
		partial.usage = emptyUsage();
		partial.stopReason = "pending";
		inventedIds.clear();
		framesSeen = 0;
		firstTokenTime = null;
	};

	const retryBudget = new RetryBudget(options.retryPolicy, options.retryAttempts);
	try {
		/*
		 * 这条链没有工具排列这个轴：Chat Completions 协议本身就规定带 `tool_calls` 的助手消息后面必须
		 * 紧跟回答它的 tool 消息，交错是唯一合法的排法，没什么可学的。可学的是 Responses 那条链。
		 */
		yield* withReasoningRetry(scope.providerId, scope.modelId, reset, (providerId, modelId, said) => {
			// 告诉参数轴这次到底发没发 `reasoning_effort: "none"`，见 `learnDroppedParam` 的 `sent`。
			const compat = learnChatCompletionsCompat(providerId, modelId, said, { reasoningOff: body.reasoning_effort === "none" });
			/*
			 * 「推理必须带回来」时给缺推理的助手轮补空串——只有这条链这么编，所以挂在这里，排在梯子那次原样
			 * 重试之前。和上一个都要问，理由同 `learnChatCompletionsCompat` 里那条「不能用 `||` 短路」。
			 */
			const padding = learnReasoningPadding(providerId, modelId, said);
			return compat || padding;
		}, async function* (replay) {
			body = buildBody(replay);
			options.onPayload?.(body);
			yield* retryStream(
			async function* attempt() {
				const response = await fetchWithRetry(
					doFetch,
					/*
					 * `/v1/`，和另外两条链一样。
					 *
					 * 这一条原本是 `"/chat/completions"`，是三条链里唯一不带版本段的。`joinUrl` 只在 path
					 * 以 `/v1/` 开头时才去重 baseUrl 末尾已有的 `/v1`，所以这一条既不补、也享受不到去重：
					 * 填最自然的 `https://api.openai.com` 拼出来是
					 * `https://api.openai.com/chat/completions`，官方直接 404（`/v1/chat/completions` 才是
					 * 那个地址，不带密钥打它返回 401——路由在，只是没认证）。
					 *
					 * 于是同一份 baseUrl 在三条链里规则不一样，而且只有这一条要求填的人知道内情。宽松的
					 * 宿主两个地址都收，所以这个 bug 只在最正规的那些端点上发作。
					 */
					joinUrl(provider.baseUrl, "/v1/chat/completions"),
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
					// 带着结论抛：`fetchWithRetry` 已经判过了，上面那层不该拿一个字符串重新猜。
					const detail = await response.text().catch(() => "");
					throw new FailureError(classifyFailure({ from: "status", status: response.status, body: detail }));
				}

				yield { type: "start", partial: { ...partial } } as StreamEvent;

				let currentTextIndex = -1;
				let currentThinkingIndex = -1;
				/** 当前那段思考结束：把从 `startedAt` 起的时长写在块上。 */
				const stampThinking = () => {
					const block = partial.content[currentThinkingIndex];
					if (block?.type === "thinking" && block.startedAt !== undefined) block.durationMs = Date.now() - block.startedAt;
				};
				/** 这次尝试里没能解析的帧，留一份原文，空回答时用来说明收到的到底是什么。 */
				let unparsable = "";
				/** 收到过 `[DONE]` 没有——和下面那个一起，用来分辨「说完了」和「线断了」。 */
				let sawDone = false;
				/** 收到过 `finish_reason` 没有。 */
				let sawFinish = false;
				/** 收到过用量没有。和 `sawFinish` 一起决定一条只带 usage 的帧是不是这条流的最后一帧。 */
				let sawUsage = false;
				/** `finish_reason` 说这次不算成功，那句话是什么。流走完才抛，见下面。 */
				let finishError: string | undefined;
				/** 模型拒答时说的话（`delta.refusal`）。它不在 `content` 里，不接住就成了一条空回答。 */
				let refusal = "";
				/** 这条流的推理 delta 是全量快照而不是增量。见 `reasoningFragment`。 */
				let reasoningIsSnapshot = false;
				/** 每个推理字段在整条流里攒下的全部文本。 */
				const reasoningSoFar = new Map<string, string>();
				/** 定性成快照之后，每个推理字段上一份原样的快照。 */
				const lastSnapshot = new Map<string, string>();
				/** 可见文本里扣下来等下一个 chunk 的那截半个特殊 token。见 `trailingPartialDeepseekToken`。 */
				let stripBuffer = "";
				/** 正文开头的 `<think>`。见 `ThinkTagSplitter`。 */
				const thinkTags = new ThinkTagSplitter();
				/** 这条流被空闲闸掉了吗。见 `readSseWithIdleTimeout`。 */
				const idle = { tripped: false };
				/** 这次尝试里开过的工具调用，按出现顺序。见 `findToolCall`。 */
				const calls: StreamedCall[] = [];
				/*
				 * 收到 `finish_reason` 之后不再等宿主关连接。
				 *
				 * 有的宿主发完 `finish_reason` 既不发 `[DONE]` 也不关连接。从前这里一直读到空闲闸（十分钟）跳闸，
				 * 再把跳闸判成连接问题——完整的回答被丢掉、重发。现在给一段宽限（`FINISH_GRACE_MS`）：
				 * `finish_reason` 之后又来了只带 usage 的帧就是结束，立刻停；什么都不再来的，宽限期一过就停。宽限按帧续期：结束之后还在发帧的宿主（usage、`[DONE]`
				 * 前的空帧）不会被拦腰截断。
				 *
				 * 停的办法是给读取那一侧一个自己的信号：`readSse` 收到 abort 会取消 reader 并正常结束，和空闲闸
				 * 走的是同一条路，只是不在 `idle.tripped` 上留记号——这不是故障。
				 */
				const finished = new AbortController();
				let grace: ReturnType<typeof setTimeout> | undefined;
				const extendGrace = () => {
					if (!sawFinish) return;
					if (grace !== undefined) clearTimeout(grace);
					grace = setTimeout(() => finished.abort(), FINISH_GRACE_MS);
					(grace as { unref?: () => void }).unref?.();
				};
				const readSignal = options.signal ? AbortSignal.any([options.signal, finished.signal]) : finished.signal;

				/*
				 * 开合块的几个小步骤。流里任何时刻最多只有一个块开着：开思考前关文本，开文本前关思考。
				 *
				 * 从前推理只在「没有开着的思考块」时开新块，不看文本块是否还开着——MiniMax 在正文开始后还发推理
				 * 快照时，事件序列成了 text_start → thinking_start → text_delta（写回前面没关的文本块），中间没有
				 * text_end。
				 */
				function* closeThinking(): Generator<StreamEvent> {
					if (currentThinkingIndex === -1) return;
					stampThinking();
					yield { type: "thinking_end", index: currentThinkingIndex };
					currentThinkingIndex = -1;
				}
				/*
				 * 关文本块之前，扣着的那半截先吐掉。
				 *
				 * 不吐的话它会一直留到流结束，那时 `currentTextIndex` 已经是 -1，flush 会另开一个文本块排在后面
				 * ——一句话被搬到了它原来位置的后面。
				 */
				function* closeText(): Generator<StreamEvent> {
					if (stripBuffer && currentTextIndex !== -1) {
						const tail = stripDeepseekTokens(stripBuffer);
						const textBlock = partial.content[currentTextIndex];
						if (tail && textBlock && textBlock.type === "text") {
							textBlock.text += tail;
							yield { type: "text_delta", index: currentTextIndex, delta: tail, partial: { ...partial } };
						}
					}
					stripBuffer = "";
					if (currentTextIndex === -1) return;
					yield { type: "text_end", index: currentTextIndex };
					currentTextIndex = -1;
				}
				/** 一段推理接到思考块上；`field` 记在新开的块上，下一轮按它还回去（见 `ThinkingContent.reasoningField`）。 */
				function* appendThinking(text: string, field: string | undefined): Generator<StreamEvent> {
					if (!text) return;
					if (currentThinkingIndex === -1) {
						if (currentTextIndex !== -1) yield* closeText();
						currentThinkingIndex = partial.content.length;
						partial.content.push({ type: "thinking", thinking: "", ...(field ? { reasoningField: field } : {}), startedAt: Date.now() });
						yield { type: "thinking_start", index: currentThinkingIndex };
					}
					const thinkingBlock = partial.content[currentThinkingIndex];
					if (thinkingBlock?.type !== "thinking") return;
					thinkingBlock.thinking += text;
					yield { type: "thinking_delta", index: currentThinkingIndex, delta: text, partial: { ...partial } };
				}
				/*
				 * 一段可见文本接到文本块上，先过一遍特殊 token 的剥离，见 `stripDeepseekTokens`。
				 *
				 * 缓冲只在文本末尾留着半个未闭合 token 时才扣字——正常文本一个字都不延迟。扣下来的那一小截在下一个
				 * chunk 里接上，或者在流结束时 flush（见下面）。
				 */
				function* appendVisible(text: string): Generator<StreamEvent> {
					stripBuffer += text;
					const held = trailingPartialDeepseekToken(stripBuffer);
					const flushable = stripBuffer.slice(0, stripBuffer.length - held.length);
					stripBuffer = held;
					const cleaned = stripDeepseekTokens(flushable);
					/*
					 * 剥过之后只剩空白的，一个字都不发。
					 *
					 * 没剥过的原样放行（正常文本里的空格要留），剥过的要求剩下的不是纯空白——否则一个单独成 chunk
					 * 的泄漏 token 会在回答里留下一行空格，还会把上面的思考块提前关掉。
					 */
					const visible = cleaned && (cleaned === flushable || cleaned.trim().length > 0) ? cleaned : "";
					if (!visible) return;
					yield* closeThinking();
					if (currentTextIndex === -1) {
						currentTextIndex = partial.content.length;
						partial.content.push({ type: "text", text: "" });
						yield { type: "text_start", index: currentTextIndex };
					}
					const textBlock = partial.content[currentTextIndex];
					if (textBlock?.type !== "text") return;
					textBlock.text += visible;
					yield { type: "text_delta", index: currentTextIndex, delta: visible, partial: { ...partial } };
				}
				/*
				 * 推理字段上这一帧真正新增的部分。
				 *
				 * 有的端点每个 chunk 发的是**全量快照**，不是增量。MiniMax 系是这样。
				 * 无条件 `+=` 会把一段推理拼成 O(n²) 的重复文本。
				 *
				 * 这一条**不需要端点知识**，形状自己会说话：一个新 delta 如果以「这个字段已经攒到的全部推理文本」
				 * 开头而且更长，它只可能是快照——增量式端点的一个 chunk 里不会重复整段前文。「恰好重复」的边界
				 * （增量式端点发来的 chunk 正好等于已攒文本）用两条闸挡住：
				 *
				 *   1. **要求严格更长**。长度相等的重复不算快照，照旧追加——那种 chunk 在增量流里是可能的（一个短词
				 *      被重复说）。例外是思考块已经被正文或工具调用关掉之后：那时再来一份和全部推理一字不差的文本，
				 *      增量流里不会有，只能是 MiniMax 在正文开始后照旧附带的那份快照。
				 *   2. **定性之后每一帧仍然验证前缀**。锁成快照不等于往后闭着眼削：前缀对不上（有的端点在 `</think>`
				 *      之后重开一段）就当新的一段追加。所以万一在一个增量流上误判了一次，损失也只是那一帧。
				 *
				 * 前缀按**字段**在整条流里记，不按当前思考块记——这是从前漏掉的那一半。MiniMax 在正文开始后的每个
				 * chunk 里仍然带着同一份全量快照，而正文一开始思考块就关了；按块记的话新块里什么都没有，快照削不掉，
				 * 于是每个 chunk 多出一个重复的思考块。
				 */
				const reasoningFragment = (field: string, text: string): string => {
					const soFar = reasoningSoFar.get(field) ?? "";
					if (!reasoningIsSnapshot && soFar.length > 0 && text.startsWith(soFar) && (text.length > soFar.length || currentThinkingIndex === -1)) {
						reasoningIsSnapshot = true;
						lastSnapshot.set(field, soFar);
					}
					let fragment = text;
					if (reasoningIsSnapshot) {
						const last = lastSnapshot.get(field) ?? "";
						if (text.startsWith(last)) fragment = text.slice(last.length);
						lastSnapshot.set(field, text);
					}
					reasoningSoFar.set(field, soFar + fragment);
					return fragment;
				};

				for await (const frame of readSseWithIdleTimeout(response, readSignal, STREAM_IDLE_TIMEOUT_MS, idle)) {
					extendGrace();
					if (frame.data === "[DONE]") {
						sawDone = true;
						break;
					}
					let event: Record<string, any>;
					try {
						event = JSON.parse(frame.data);
					} catch {
						if (!unparsable) unparsable = frame.data.slice(0, 500);
						continue;
					}
					framesSeen += 1;

					/*
					 * 错误也可能写在帧里，而不是状态码上。
					 *
					 * 这个适配器面对的多半是中转，而中转最爱的一种答法就是 200 加一个 `{"error":{…}}` 帧。认哪些
					 * 形状见 `streamErrorOf`；原话交给 `classifyFailure`，额度、上下文超长都靠它来认。
					 */
					const inBand = streamErrorOf(event, frame.event);
					if (inBand) {
						throw new FailureError(
							classifyFailure({
								from: "stream",
								message: inBand.message,
								raw: JSON.stringify(event).slice(0, 4000),
								spent: partial.usage.output > 0 || partial.content.length > 0,
								streamed: spokenSoFar(partial.content),
							}),
						);
					}

					const choice = event.choices?.[0];
					const usage = usageOf(event, choice);
					if (usage) {
						// 各家缓存字段的别名和「prompt_tokens 含缓存」的扣除，都在 `usage-fields.ts` 那张表里。
						applyUsage("openai-chat-completions", partial.usage, usage);
						partial.usage = computeCost(partial.usage, model);
						sawUsage = true;
					}

					if (!choice) {
						// `finish_reason` 之后那个只带 usage 的帧（`stream_options.include_usage`）就是最后一帧，见 `finished`。
						if (sawFinish && sawUsage) break;
						continue;
					}

					const delta = choice.delta;
					if (typeof delta?.refusal === "string") refusal += delta.refusal;
					if (delta) {
						const content = contentOfDelta(delta.content);
						/*
						 * 推理挂在三个键之一上，不只是 `reasoning_content`。见 `reasoningFromDelta`。
						 *
						 * content 里已经带着成型的推理片段（Magistral）时不再读别名：同一段推理挂两处，读两处就重了。
						 */
						const reasoning = content.thinking ? undefined : reasoningFromDelta(delta);
						if (content.text || content.thinking || reasoning || delta.tool_calls) {
							if (firstTokenTime === null) firstTokenTime = Date.now();
						}
						if (reasoning) yield* appendThinking(reasoningFragment(reasoning.field, reasoning.text), reasoning.field);
						yield* appendThinking(content.thinking, undefined);
						for (const segment of thinkTags.push(content.text)) {
							if (segment.kind === "thinking") yield* appendThinking(segment.text, THINK_TAG_FIELD);
							else yield* appendVisible(segment.text);
						}

						if (delta.tool_calls) {
							yield* closeThinking();
							yield* closeText();

							for (const tc of delta.tool_calls) {
								let call = findToolCall(tc, calls);

								if (!call) {
									const toolCallIndex = partial.content.length;
									// 编号按块在 content 里的位置记，不按 `tc.index`——后者可能缺，也可能被几个调用共用。
									const id = toolCallId(tc.id, toolCallIndex, inventedIds);
									const name = toolNameFromStream(tc.function?.name);
									const newBlock: ToolCallContent = { type: "toolCall", id, name, arguments: {}, argumentsText: "" };
									partial.content.push(newBlock);
									call = { block: newBlock, index: typeof tc.index === "number" ? tc.index : undefined, id: typeof tc.id === "string" && tc.id ? tc.id : undefined };
									calls.push(call);
									yield { type: "toolcall_start", index: toolCallIndex, id, name };
								}
								const block = call.block;

								if (!block.name) block.name = toolNameFromStream(tc.function?.name);

								if (tc.function?.arguments) {
									// 字符串分片、重发的整串、对象分片各怎么接，见 `nextArguments`。
									const next = nextArguments(block.argumentsText || "", call.object, tc.function.arguments);
									block.argumentsText = next.text;
									call.object = next.object;
									yield {
										type: "toolcall_delta",
										index: partial.content.indexOf(block),
										delta: argumentFragment(tc.function.arguments),
										partial: { ...partial },
									};
								}
							}
						}
					}

					if (choice.finish_reason) {
						sawFinish = true;
						extendGrace();
						/*
						 * 认不出来的结束原因怎么算，见 `mapFinishReason`。
						 *
						 * 记下来、流走完再抛，不在这里抛：这里抛会跳过下面那一轮 `thinking_end` / `text_end`，
						 * 而异常那一路会另发一份 `error` 事件带着同一个 partial——界面上就有一个永远没关上的块。
						 */
						const mapped = mapFinishReason(String(choice.finish_reason));
						if (mapped.stopReason) partial.stopReason = mapped.stopReason;
						if (mapped.error) finishError ??= mapped.error;
					}
				}
				if (grace !== undefined) clearTimeout(grace);

				// 切分器扣着的那一截：没闭合的 `<think>` 里的是思考，开头那几个没认出来的字是正文。
				for (const segment of thinkTags.end()) {
					if (segment.kind === "thinking") yield* appendThinking(segment.text, THINK_TAG_FIELD);
					else yield* appendVisible(segment.text);
				}

				/*
				 * 扣着的最后那一截吐出来。
				 *
				 * 走到这里说明流结束了，缓冲里剩的东西不可能再等到下半个 token——它就是普通文本（比如一段话
				 * 正好以 `<` 结尾）。剥一遍再发，剥完是空的就算了。
				 */
				if (stripBuffer) {
					const tail = stripDeepseekTokens(stripBuffer);
					stripBuffer = "";
					if (tail && (tail.trim().length > 0 || currentTextIndex !== -1)) {
						yield* closeThinking();
						if (currentTextIndex === -1) {
							currentTextIndex = partial.content.length;
							partial.content.push({ type: "text", text: "" });
							yield { type: "text_start", index: currentTextIndex };
						}
						const textBlock = partial.content[currentTextIndex];
						if (textBlock && textBlock.type === "text") {
							textBlock.text += tail;
							yield { type: "text_delta", index: currentTextIndex, delta: tail, partial: { ...partial } };
						}
					}
				}

				/*
				 * `finish_reason` 说这次不算成功——抛，让重试那一层按分类决定重不重试。
				 *
				 * `spent` 给真话：已经吐过字的话服务商收过钱了，界面要把这个代价说出来（见 `Failure.costIncurred`）。
				 */
				/*
				 * 拒答是一个明确的结局，和 Anthropic 链的 `stop_reason: refusal` 同一个出口：判成内容策略、不重试。
				 * 从前没接 `delta.refusal`，它落成空回答被重试好几次——同样的输入再问还是同样的拒绝。
				 */
				if (refusal.trim()) {
					throw new FailureError(classifyFailure({ from: "stream", message: `${REFUSAL_MESSAGE}：${refusal.trim()}`, spent: true }));
				}

				if (finishError) {
					throw new FailureError(
						classifyFailure({
							from: "stream",
							message: finishError,
							spent: partial.usage.output > 0 || partial.content.length > 0,
							streamed: spokenSoFar(partial.content),
						}),
					);
				}

				/*
				 * 有内容，却既没有 `finish_reason` 也没有 `[DONE]`——这是线断了，不是说完了。
				 *
				 * 从前这条链没有任何这类判定：传输在中途 EOF，我们把半截答案当成正常结束交出去，`stopReason`
				 * 被下面那段兜成 `stop` 或 `toolUse`。用户看到的是无声截断。
				 *
				 * 只有**两个收尾信号都没有**才算断。原因是有些 OpenAI 兼容宿主压根不发 `finish_reason`、只靠
				 * `[DONE]` 收尾，所以光看 `finish_reason` 会把它们每一轮都误判成截断。反过来，一个两样都不发、只是安静关闭连接的宿主会被我们误判；那种宿主没见过，
				 * 而且它本来就没有任何办法让人分辨「说完了」和「断了」。
				 *
				 * 没有内容的情况不走这里：那是空回答，下面那段管，错误信息说得更准。
				 */
				/*
				 * 被空闲闸掉的，按连接问题抛，排在截断之前。
				 *
				 * 挂死的流从这一侧看恰好就是「没有收尾信号」，所以不先认领的话，下面那条会把它说成截断
				 * ——两者都可重试，但说出来的原因不一样，而用户读到的就是那句话。见 Anthropic 链上同一段。
				 */
				if (idle.tripped) {
					throw new FailureError(
						classifyFailure({ from: "transport", error: new Error(`流空闲超过 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒`) }),
					);
				}

				if (!sawFinish && !sawDone && partial.content.length > 0) {
					throw new FailureError(
						classifyFailure({
							from: "stream",
							message: "回答只传了一半，连接就断了",
							spent: true,
							streamed: spokenSoFar(partial.content),
						}),
					);
				}

				if (currentThinkingIndex !== -1) {
					stampThinking();
					yield { type: "thinking_end", index: currentThinkingIndex };
				}
				if (currentTextIndex !== -1) {
					yield { type: "text_end", index: currentTextIndex };
				}

				// Parse JSON args for all tool calls
				for (let i = 0; i < partial.content.length; i++) {
					const c = partial.content[i];
					if (c.type === "toolCall") {
						c.arguments = parseToolArguments(c.argumentsText || "{}") ?? {};
						yield { type: "toolcall_end", index: i, partial: { ...partial } };
					}
				}

				// 空回答也是失败，不是「模型没话说」——见 Responses 适配器里同一段的说明。
				if (partial.content.length === 0) {
					throw new FailureError(
						classifyFailure({
							from: "empty",
							why: unparsable ? "unparsable" : framesSeen === 0 ? "no-frames" : "no-content",
							body: unparsable || undefined,
							output: { truncated: partial.stopReason === "length" },
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
	const hasToolCalls = partial.content.some((c) => c.type === "toolCall");
	if (partial.stopReason === "pending") partial.stopReason = hasToolCalls ? "toolUse" : "stop";
	// 带着工具调用却报 `stop` 的宿主不少，和 Anthropic 链的 `mapStopReason` 一样按内容判成 `toolUse`：
	// 留着 `stop`，回放到 Anthropic 时这一轮会被当成「弃用工具」、整轮思考签名被剥掉。
	else if (partial.stopReason === "stop" && hasToolCalls) partial.stopReason = "toolUse";
	// 成功了，但失败的那几次也是花过钱的——账上要有。各按各的档位计价再相加，见 `priceAttempt`。
	settleUsage(partial, model, spentOnRetries);

	yield { type: "done", message: partial };
	return partial;
}
