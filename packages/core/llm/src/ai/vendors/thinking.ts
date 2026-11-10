/**
 * 把 `thinkingDialect` 查到的写法翻成三种格式各自的请求体字段。
 *
 * 适配器只做一件事：把这里返回的对象展开进请求体。写法的选择在 `index.ts`，学到的结论（adaptive、被撤掉的
 * 参数）由适配器查好传进来——这里不碰任何一张学习表，所以是纯函数，能直接测。
 */

import type { AnthropicThinkingOn, ResolvedThinking } from "./types.ts";

type Fields = Record<string, unknown>;

/**
 * 我们的档位 → 协议的 `effort`（Anthropic 的 `output_config.effort`）。协议只认 `low/medium/high/xhigh/max`。
 *
 * `minimal` 和 `ultra` 是别家的档位，就近落到两端；表里没有的（模型自定义的档位名）不发，由端点用它自己的
 * 默认——发一个协议外的值只会换来一个 400。
 */
const EFFORT: Record<string, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
	ultra: "max",
};

export interface AnthropicThinkingInput {
	/** 开着时的档位；`undefined` 表示关着。 */
	effort: string | undefined;
	/**
	 * 没填（`undefined`）时开着照发——从前就是这样；关着时什么都不发：不知道这个模型有没有思考，就别给
	 * 它发一个它可能不认的 `thinking` 字段，被拒了也没有哪条学习轴能撤掉它。
	 */
	supportsThinking: boolean | undefined;
	budget: number | undefined;
	maxTokens: number;
	/** 这个模型撞出过「不认 budget_tokens」。只在写法本来是 `budget` 时起作用。 */
	learnedAdaptive: boolean;
}

/** 这一次实际用哪种写法开思考。budget 写法要校验 budget、要带交错思考的头，适配器靠它判断。 */
export function anthropicThinkingOn(dialect: ResolvedThinking, learnedAdaptive: boolean): AnthropicThinkingOn {
	return dialect.anthropic === "budget" && learnedAdaptive ? "adaptive" : dialect.anthropic;
}

export function anthropicThinkingFields(dialect: ResolvedThinking, input: AnthropicThinkingInput): Fields {
	if (input.supportsThinking === false) return {};
	if (input.effort === undefined) return input.supportsThinking && !dialect.alwaysOn ? { thinking: { type: "disabled" } } : {};
	const on = anthropicThinkingOn(dialect, input.learnedAdaptive);
	if (on === "budget") {
		return { thinking: { type: "enabled", budget_tokens: input.budget === undefined ? undefined : Math.min(input.budget, input.maxTokens - 1) } };
	}
	const mapped = EFFORT[input.effort];
	const effort = mapped ? { output_config: { effort: mapped } } : {};
	if (on === "effort-only") return effort;
	return { thinking: { type: on === "adaptive" ? "adaptive" : "enabled" }, ...effort };
}

export interface OpenAiThinkingInput {
	/** 开着时的档位；`undefined` 表示关着。 */
	effort: string | undefined;
	supportsThinking: boolean | undefined;
	/** 这个端点撞过之后要求别发的参数，见 `request-params-compat.ts`。 */
	dropped: ReadonlySet<string>;
}

/** Chat Completions。关着时 `reasoning_effort: "none"` 撞过就撤（`reasoning-off`）。 */
export function chatThinkingFields(dialect: ResolvedThinking, input: OpenAiThinkingInput): Fields {
	if (!input.supportsThinking) return {};
	if (input.effort !== undefined) return { reasoning_effort: input.effort };
	return dialect.alwaysOn || dialect.chatRefusesNone || input.dropped.has("reasoning-off") ? {} : { reasoning_effort: "none" };
}

/**
 * Responses。摘要要组织验证过才给，没验证的账号整个请求 400——撞过就只撤它（`reasoning-summary`），effort
 * 照发；密文同理（`include-encrypted`）。关着时 `effort: "none"` 撞过就撤（`reasoning-off`）。
 */
export function responsesThinkingFields(dialect: ResolvedThinking, input: OpenAiThinkingInput): Fields {
	if (!input.supportsThinking) return {};
	if (input.effort !== undefined) {
		return {
			reasoning: input.dropped.has("reasoning-summary") ? { effort: input.effort } : { effort: input.effort, summary: "auto" },
			...(input.dropped.has("include-encrypted") ? {} : { include: ["reasoning.encrypted_content"] }),
		};
	}
	return dialect.alwaysOn || dialect.responsesRefusesNone || input.dropped.has("reasoning-off") ? {} : { reasoning: { effort: "none" } };
}
