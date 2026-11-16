/**
 * Magpie（usemagpie.ai）接管 Plume 的模型时写进设置文件的那一块，以及它变成的供应商。
 *
 * Magpie 的 Agent 插件（仓库里的 `integrations/magpie`）只会按点分路径原地改 JSON 的对象键，定位不到
 * `providers` 数组里的某一项；它还靠「它写的 key 还在原处」判断这一行是否仍然接着。所以它写的是顶层的
 * `magpie` 对象，这里在读入时把它合成一个供应商，写盘时再拿掉：合成的那一项从不落进 `providers`，
 * 一旦落进去就成了用户自己的，Magpie 断开时只恢复 `magpie` 块，这一项会永远留下。在 Plume 里的编辑也写回
 * `magpie` 块，模型沿用 Magpie 的字段名，额外的能力、价格和档位直接留在同一条模型上。
 */

import { thinkingOptionsFor } from "@plume/llm/thinking-options";
import type { ModelEntry, ProviderSettings } from "@plume/contract";
import type { StoredProvider } from "./models.ts";

const MAGPIE_PROVIDER_ID = "magpie";

/** 和新建模型的默认值一样：Magpie 不知道的就不给，不是 0。 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_OUTPUT = 32_000;

/** Magpie 下发的模型，以及人在 Plume 里补充的配置。 */
interface MagpieModel extends Partial<Pick<ModelEntry, "supportsThinking" | "supportsTools" | "pricing" | "thinkingOptions" | "imageOutput">> {
	/** 网关认的 `<供应商>/<模型>`，或路由组的名字。 */
	id: string;
	name?: string;
	context?: number;
	output?: number;
	images?: boolean;
	/** Magpie 不知道档位时是 null。 */
	efforts?: string[] | null;
}

interface MagpieGateway extends Partial<Pick<ProviderSettings, "name" | "api" | "enabled">> {
	/** 不带 `/v1` 的网关地址；适配器拼路径时会处理 `/v1`。 */
	baseUrl: string;
	/** Magpie 给 Plume 的 key，用量按它记在 Plume 名下。 */
	apiKey: string;
	models: MagpieModel[];
}

export function isMagpie(providerId: string): boolean {
	return providerId === MAGPIE_PROVIDER_ID;
}

/**
 * 文件里的 `magpie` 块对应的供应商；不完整就是没接。
 *
 * Magpie 断开时逐键恢复或删除，删空的父对象会留成 `{}`，所以缺字段是常态而不是损坏。
 */
export function magpieProvider(gateway: unknown): StoredProvider | undefined {
	if (!gateway || typeof gateway !== "object") return undefined;
	const { baseUrl, apiKey, models, name, api, enabled } = gateway as Partial<MagpieGateway>;
	if (typeof baseUrl !== "string" || !baseUrl || typeof apiKey !== "string" || !apiKey) return undefined;
	return {
		id: MAGPIE_PROVIDER_ID,
		name: name || "Magpie",
		// 网关对 Chat Completions、Responses、Anthropic Messages 都代为翻译，一个供应商只能选一种，选哪种都通。
		api: api ?? "openai-responses",
		baseUrl,
		apiKey,
		enabled: enabled ?? true,
		models: (Array.isArray(models) ? models : []).filter((model) => typeof model?.id === "string" && model.id).map(toModel),
	};
}

/** 只有编辑这个供应商时才转换，保存其他设置不改 Magpie 原本写下的字段。 */
export function magpieGateway(provider: StoredProvider): MagpieGateway {
	return {
		name: provider.name,
		api: provider.api,
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey!,
		enabled: provider.enabled,
		models: provider.models.map(({ modelId, contextWindow, maxOutputTokens, supportsImages, ...model }) => ({
			...model,
			id: modelId,
			context: contextWindow,
			output: maxOutputTokens,
			images: supportsImages,
		})),
	};
}

function toModel(model: MagpieModel): ModelEntry {
	// Magpie 把「不思考」叫 none，Plume 叫 off；其余档位名两边相同，不认识的由 thinkingOptionsFor 丢掉。
	const levels = (model.efforts ?? []).map((effort) => (effort === "none" ? "off" : effort));
	const thinkingOptions = model.thinkingOptions ?? thinkingOptionsFor(levels);
	return {
		modelId: model.id,
		name: model.name || model.id,
		contextWindow: model.context || DEFAULT_CONTEXT_WINDOW,
		maxOutputTokens: model.output || DEFAULT_MAX_OUTPUT,
		// 没给档位不等于不会思考：留给默认几档。
		supportsThinking: model.supportsThinking ?? true,
		supportsImages: model.images ?? false,
		supportsTools: model.supportsTools ?? true,
		...(thinkingOptions.length > 0 ? { thinkingOptions } : {}),
		...(model.pricing ? { pricing: model.pricing } : {}),
		...(typeof model.imageOutput === "boolean" ? { imageOutput: model.imageOutput } : {}),
	};
}
