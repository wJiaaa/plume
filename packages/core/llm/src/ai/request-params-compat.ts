/**
 * 请求体里那些「这个端点不吃这个字段」的参数，撞出来之后记住。
 *
 * 和另外两个轴（`reasoning-compat.ts` 管推理怎么还、`tool-pairing-compat.ts` 管工具怎么排）是并列的
 * 第三件事，各学各的。压进同一条梯子的代价上一轮付过了：端点说 A、梯子退 B，对不上号时只能靠碰巧。
 *
 * 这里管的七个参数有一个共同点——**它们都不是必需品**。少发一个最多损失一点控制力（思考没关干净、
 * 采样参数没生效），而多发一个是整个请求被拒。所以默认全发、撞了就撤，方向永远是安全的那边。
 *
 * 为什么是「学」而不是「配」：这四条在作者能测到的两个端点上**全部 200**（2026-09-11，
 * `test/responses-params-probe.ts`）。也就是说我们手上
 * 没有能复现它们的端点，没有资格替所有人改默认值。我们也没有一张人工普查出来的表能直接查——但错误串
 * 自带诊断，撞一次就够了。
 *
 * 已知的先验不靠学，写在 `vendors/`：Gemini 系、OpenAI 的 o 系列和旧 gpt-5 拒 `effort: "none"`。这里的
 * 机制是给**没见过的端点**兜底的。
 *
 * 记在内存里，不落盘，理由同另外两个轴。
 */

import { compatKey } from "./compat-key.ts";

/** 一个可以在撞墙后撤掉的请求参数。 */
export type DroppedParam = "reasoning-off" | "reasoning-summary" | "tool-choice" | "sampling" | "include-encrypted" | "cache-key" | "cache-control";

/**
 * 端点拒绝某个参数时的说法，以及该撤哪个。
 *
 * 每条都要能指出出处。指不出的不要往这里加——多认一条的代价是把别的原因造成的 400 误判成参数问题，
 * 然后拿一个被削过的请求去重发，那比不认还糟。
 */
const SIGNALS: { pattern: RegExp; drop: DroppedParam; source: string }[] = [
	{
		/*
		 * 实测原话记在 `openai-responses.ts` 关思考那段注释里：Google Gemini/Vertex 拒 `effort: "none"`。
		 * 第二种写法是 OpenAI 系对枚举外取值的通用说法，`'none'` 是 GPT-5.1 之后才加进去的值。
		 *
		 * 每一种都要求**被拒的那个值就是 `none`**。原先第三条是 `reasoning\.effort.{0,40}(not|invalid)`，
		 * 开着思考、只是某一档（比如 `xhigh`）不被接受时也会命中——学到 `reasoning-off` 之后重发的是一模
		 * 一样的请求（开着思考时根本不读这一条），同一个 400 再来一遍，而这个模型往后关思考也被误撤了。
		 * 调用方还会告诉我们这次到底有没有发 `none`（`learnDroppedParam` 的 `sent`），没发就不认这条。
		 *
		 * o 系列的两种说法（OpenAI 官方，o3 / o4-mini 关思考时）一个先点名字段、后说 `none`，一个只说
		 * `none`、开头是 `Unsupported` 不是 `Invalid`：
		 *
		 *     Unsupported value: 'reasoning.effort' does not support 'none' with this model.
		 *     Unsupported value: 'none' is not supported with the 'o3' model.
		 *
		 * 原先两句都认不出，判 fatal，这个模型关着思考就一轮都发不出去。字段在前的那一种要求拒绝的词夹在
		 * 字段和 `none` 之间、而且不跨句号——「不支持 'xhigh'。可选值：'none'…」说的是另一档，不能认。
		 *
		 * The last is Vertex behind a Chat Completions relay (measured 2026-09-28): `Invalid value at
		 * 'request.generation_config.thinking_config.thinking_level' (…ThinkingLevel), "none"`. It names
		 * both the field and the value, so it is safe to claim. The quotes arrive escaped when the
		 * failure detail is the raw body.
		 */
		pattern:
			/none is not a valid ThinkingLevel|(?:Invalid|Unsupported) value: ['"]none['"]|reasoning[._]effort[^.\n]{0,40}?['"`]none['"`][^.\n]{0,40}?(?:not supported|unsupported|invalid|not a valid|not allowed)|reasoning[._]effort['"`]?[^.\n]{0,40}?(?:does not support|not supported|unsupported|invalid|not allowed)[^.\n]{0,20}?['"`]none['"`]|thinking_level'[^'\n]{0,200}?\\?"none\\?"/i,
		drop: "reasoning-off",
		source: "Gemini/Vertex 实测（Google 原生与 Chat Completions 中转两种原话）+ OpenAI 枚举外取值的通用说法 + o 系列的两种原话",
	},
	{
		/*
		 * 推理摘要（`reasoning.summary`）。OpenAI 要求组织先做身份验证才给摘要，没验证的账号开思考就是：
		 *
		 *     Your organization must be verified to generate reasoning summaries.
		 *
		 * 错误体里的 `param` 是 `reasoning.summary`。撤掉的只是摘要：effort 照发，思考照开，只是界面上
		 * 看不到它想了什么——比每一轮都 400 好。
		 */
		pattern: /must be verified to generate reasoning summar|reasoning\.summary/i,
		drop: "reasoning-summary",
		source: "OpenAI 官方对未验证组织的原话；param 字段点名 reasoning.summary",
	},
	{
		pattern: /tool_choice/i,
		drop: "tool-choice",
		source: "错误串点名这个参数即可判定——它是唯一叫这个名字的东西",
	},
	{
		/*
		 * OpenAI 官方对 o 系列和 gpt-5.x 的两种原话：
		 *
		 *     Unsupported value: 'temperature' does not support 0.7 with this model.
		 *     Only the default (1) is supported.
		 *     Unsupported parameter: 'top_p' is not supported with this model.
		 *
		 * `[^.]{0,60}?` 不跨句号，是为了不把一段顺口提到 temperature 的长错误也算进来——那种误判会削掉
		 * 用户自己配的采样参数，而真正的失败原因还在，于是重发还是失败，只是安静地改坏了一件事。
		 */
		pattern:
			/(?:unsupported\s+(?:value|parameter)\s*:\s*)?["'`]?(?:temperature|top_p|top_k|min_p|frequency_penalty|presence_penalty|repetition_penalty)["'`]?[^.]{0,60}?(?:does not support|is not supported|not supported with this model|only the default)/i,
		drop: "sampling",
		source: "OpenAI 官方 o 系列/gpt-5.x 的两种原话",
	},
	{
		pattern: /include.{0,30}encrypted_content|encrypted_content.{0,30}(not supported|unsupported|invalid)/i,
		drop: "include-encrypted",
		source: "我们无条件请求上游回密文；不认识这个 include 值的端点会拒",
	},
	{
		/*
		 * 缓存路由键（`cache-routing.ts`）。每个请求都发，而严格端点对未知字段 400 时会点名它：
		 * Google 系是 `Unknown name "prompt_cache_key"`，pydantic 系（Mistral、vLLM 严格模式）是
		 * `extra_forbidden` 加一个带字段名的 loc。这个名字只属于它一个，点名即可判定。
		 */
		pattern: /prompt_cache_key/i,
		drop: "cache-key",
		source: "严格端点拒未知字段时的错误串会点名字段；这个名字是唯一的",
	},
	{
		/*
		 * Chat Completions 上给 Claude 放的缓存断点（`withCacheBreakpoints`）。它是 Anthropic 的字段，
		 * 不在 OpenAI 的协议里，不认它的严格端点拒未知字段时会点名——和上一条 `prompt_cache_key` 同一类
		 * 错误。**没有这个字段被拒的真实样本**（手上没有走这条链的 Claude 端点），认的只是字段名本身，
		 * 它只属于缓存断点。
		 */
		pattern: /cache_control/i,
		drop: "cache-control",
		source: "同 prompt_cache_key：严格端点拒未知字段时点名字段；未取得真实样本",
	},
];

/** 学到的结论：`${providerId} ${modelId}` → 这些参数别再发了。 */
const learned = new Map<string, Set<DroppedParam>>();

const key = compatKey;

const EMPTY: ReadonlySet<DroppedParam> = new Set();

/** 这个模型上该省掉哪些参数。没撞过就是一个都不省。 */
export function droppedParams(providerId: string, modelId: string): ReadonlySet<DroppedParam> {
	return learned.get(key(providerId, modelId)) ?? EMPTY;
}

/** 这次被拒的请求里实际发了什么。给了就用来排除「撤掉它也不会改变请求」的信号。 */
export interface SentParams {
	/** 发了「关推理」那个值（`effort: "none"` / `reasoning_effort: "none"`）没有。 */
	reasoningOff?: boolean;
}

/**
 * 从一次失败里学点东西。返回「结论变了，值得削掉这个参数重发一次」。
 *
 * 已经撤过同一个参数还被同一句话顶回来，返回 false——再发一次还是同样的结果，只是多烧一次钱。
 *
 * `sent` 不给时按从前的行为只看错误串；适配器应当给——请求里根本没有 `none` 时，一句提到 effort 的
 * 400 说的一定是别的档位，撤「关推理」既改不了这次的请求，还会让这个模型以后关不掉思考。
 */
export function learnDroppedParam(providerId: string, modelId: string, error: string, sent?: SentParams): boolean {
	const hit = SIGNALS.find((signal) => signal.pattern.test(error) && !(signal.drop === "reasoning-off" && sent && !sent.reasoningOff));
	if (!hit) return false;
	const id = key(providerId, modelId);
	const set = learned.get(id) ?? new Set<DroppedParam>();
	if (set.has(hit.drop)) return false;
	set.add(hit.drop);
	learned.set(id, set);
	return true;
}

/** 测试用：把学到的都忘掉。 */
export function resetRequestParamsCompat(): void {
	learned.clear();
}
