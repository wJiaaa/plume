/**
 * 厂商特例的唯一去处。
 *
 * 这里只放**事先就知道、又学不会**的事：端点不报错只是静默忽略（发 `budget_tokens` 给只认 effort 的模型），
 * 或者报了错但报得认不出（Gemini 2.5 的 `invalid argument`），以及省掉一次必然的 400（新 Claude 的 adaptive）。
 * 端点会报错并点名原因的，走「撞出来再学」的那几张表（`request-params-compat.ts`、`reasoning-compat.ts`、
 * `tool-pairing-compat.ts`、Anthropic 链的 `learnAdaptiveThinking`），不写这里。
 *
 * 从前这些先验散在三个适配器里，同一件事在一条链上有、另一条链上没有，Gemini 关思考在 Chat 链上全挂就是
 * 这么来的。现在适配器只问这里。
 *
 * 加一条的门槛：撞到过、或者官方文档写明了，而且学习表认领不了。只照着别家产品的内置表抄来的不加——
 * 模型名正则随版本过期，每一条都是要人看着的维护负担，而判错的代价多半只是档位没送到。
 */

import type { ResolvedThinking, VendorRule } from "./types.ts";

const DEEPSEEK = /deepseek/i;
const DEEPSEEK_THINKING = { anthropic: "enabled-effort", leadingReasoning: true } as const;
const DEEPSEEK_SOURCE =
	"Anthropic 格式：api-docs.deepseek.com anthropic_api（budget_tokens 被忽略，只认 output_config.effort）；Responses 格式：缺推理项时的 400（实测）；" +
	"缓存：api-docs.deepseek.com guides/kv_cache（不再使用后 usually within a few hours to a few days 才清，best-effort），本机日志隔 4.5 分钟到 1 小时 30/32 命中、超过 1 小时 1/3";
/** 文档说几小时起，实测只到 1 小时以内可靠。 */
const DEEPSEEK_CACHE_HOT_MS = 3_600_000;

/** 顺序就是优先级：后面的规则覆盖前面的同一项。 */
const RULES: readonly VendorRule[] = [
	{
		// 不写这条也能学会（`learnAdaptiveThinking` 认得那句 400），代价是每个进程、每个模型第一次请求白吃一个。
		model: /claude-(?:opus-(?:4-[7-9]|5)|sonnet-5|fable)|(?:^|\/)fable-5/i,
		thinking: { anthropic: "adaptive" },
		source: "Anthropic 官方 400：`thinking.type.enabled` is not supported for this model. Use `thinking.type.adaptive`",
	},
	{
		// o1 / o3 / o4-mini 只有 low/medium/high，GPT-5.1 之前的 gpt-5 最低是 `minimal`。锚在开头或 `/` 之后，
		// 免得 `gpt-4o1-relay` 顺带命中。只管 Responses：Chat 链对它们没有实测，不跟着改。
		model: /(?:^|\/)(?:o[134]|gpt-5)(?:-|$)/i,
		thinking: { responsesRefusesNone: true },
		source: "OpenAI 官方 400：Unsupported value: 'none' is not supported with the 'o3' model.",
	},
	{
		// Gemini 2.5 经 Chat Completions 中转时只说 `Request contains an invalid argument.`，学不到。
		model: /gemini|gemma/i,
		thinking: { chatRefusesNone: true, responsesRefusesNone: true },
		source: "实测：Gemini/Vertex 400 `none is not a valid ThinkingLevel enum value`",
	},
	{
		// 认档位的两代都没有 budget 参数，发 `budget_tokens` 不报错、直接忽略，档位停在默认的 max。
		model: /glm-5\.[2-9]/i,
		thinking: { anthropic: "enabled-effort" },
		source: "sub2api #7181 直连 open.bigmodel.cn：glm-5.3 budget 8000 / 32000 思考长度几乎相同，output_config.effort 生效",
	},
	{
		// 含 glm-5.3-flash。
		model: /glm-5\.3/i,
		thinking: { alwaysOn: true },
		source: "docs.z.ai glm-5.3、capabilities/thinking：thinking.type 传 disabled 报错",
	},
	{
		// Messages 接口的请求结构里没有 `thinking` 字段，只有 `output_config.effort`。
		model: /(?:^|\/)(?:kimi-)?k3(?:[-.[]|$)/i,
		thinking: { anthropic: "effort-only", alwaysOn: true },
		source: "platform.kimi.ai api/messages（output_config.effort: low/high/max）、api/models-overview（K3 不支持 thinking）、kimi-k3-quickstart（You can't — K3 always thinks）",
	},
	// 按模型名也认，覆盖转发它的中转；地址只要带 deepseek 就认，自建的转发常用别名起模型名。
	{ model: DEEPSEEK, thinking: DEEPSEEK_THINKING, cacheHotMs: DEEPSEEK_CACHE_HOT_MS, source: DEEPSEEK_SOURCE },
	{ endpoint: DEEPSEEK, thinking: DEEPSEEK_THINKING, cacheHotMs: DEEPSEEK_CACHE_HOT_MS, source: DEEPSEEK_SOURCE },
];

/** 没有任何规则命中时的写法，也就是各条链原来的行为。 */
const DEFAULT: ResolvedThinking = {
	anthropic: "budget",
	chatRefusesNone: false,
	responsesRefusesNone: false,
	leadingReasoning: false,
	alwaysOn: false,
};

function applies(rule: VendorRule, endpoint: string, modelId: string): boolean {
	return (!rule.model || rule.model.test(modelId)) && (!rule.endpoint || rule.endpoint.test(endpoint));
}

/** 这个端点上的这个模型，思考开关该怎么写。 */
export function thinkingDialect(endpoint: string, modelId: string): ResolvedThinking {
	let resolved = DEFAULT;
	for (const rule of RULES) if (applies(rule, endpoint, modelId)) resolved = { ...resolved, ...rule.thinking };
	return resolved;
}

/** 缓存在这一家能留多久；没有规则时是 undefined，由调用方用自己的默认值。 */
export function cacheHotMs(endpoint: string, modelId: string): number | undefined {
	let hot: number | undefined;
	for (const rule of RULES) if (rule.cacheHotMs !== undefined && applies(rule, endpoint, modelId)) hot = rule.cacheHotMs;
	return hot;
}

export type { ResolvedThinking } from "./types.ts";
