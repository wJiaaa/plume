/**
 * 「撞出来之后记住」的那几张表（`reasoning-compat.ts`、`tool-pairing-compat.ts`、
 * `request-params-compat.ts`、Anthropic 链的思考回放/思考形状、Chat 链的输出上限字段名）共用的键。
 *
 * 学和查必须用同一个键，否则学到的结论永远查不到：Responses 链曾经查排列时用 `model.modelId`、
 * 学的时候用 `model.id`，于是撞一次学一次、下一次请求照旧按默认形状发，同一个 400 每轮都来一遍。
 * 两边各自拼字符串迟早会再漂一次，所以键只在这里拼，模型那一半也只从这里取。
 *
 * 取 `model.id`（配置里的唯一 id）而不是 `model.modelId`（线上模型名）：同一个服务商下可以配两条
 * 指向同一个线上模型、参数不同的配置，它们该各学各的。
 */

import type { ModelConfig, ProviderConfig } from "../types.ts";

/** 学习表的键。所有 learnXxx / 查表函数内部都只用它。 */
export const compatKey = (providerId: string, modelId: string): string => `${providerId} ${modelId}`;

/** 适配器调 learnXxx / 查表函数时传的那一对 id。三条链都从这里取，不自己挑字段。 */
export function compatScope(provider: Pick<ProviderConfig, "id">, model: Pick<ModelConfig, "id">): { providerId: string; modelId: string } {
	return { providerId: provider.id, modelId: model.id };
}
