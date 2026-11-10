/**
 * 新导入的模型一开始是什么样。
 *
 * 上限、能力和价格从模型目录（`@plume/llm/model-catalog`）一次性填进去，目录既认模型名也认端点。之后这一行归用户，
 * 目录更新不会改它。目录里没有的模型用通用的默认值。拉取弹窗里显示的数字和导入时写进去的出自同一个函数。
 */

import { isImageModelId } from "@plume/llm/image-models";
import { catalogFill, catalogModelFor, type CatalogFill, DEFAULT_MODEL_LIMITS } from "@plume/llm/model-catalog";
import type { ModelConfig, ProviderEntry } from "../../models/store.ts";

type Endpoint = Pick<ProviderEntry, "id" | "baseUrl">;

function initialValues(provider: Pick<ProviderEntry, "baseUrl">, modelId: string): CatalogFill {
	/*
	 * 生图模型三样都不是：它只按提示词和给它的图画图。目录只收文字模型，不认它，不在这里拦的话它一进来就号称会思考、
	 * 会调工具——行上两个说不通的标记。
	 */
	if (isImageModelId(modelId)) return { ...DEFAULT_MODEL_LIMITS, supportsThinking: false, supportsImages: true, supportsTools: false };
	const found = catalogModelFor(provider, modelId);
	return found ? catalogFill(found.model, provider) : DEFAULT_MODEL_LIMITS;
}

/** 拉到的一个模型 id，变成供应商列表里的一行。 */
export function importedModel(provider: Endpoint, modelId: string): ModelConfig {
	const { pricing, ...values } = initialValues(provider, modelId);
	return {
		id: `${provider.id}/${modelId}`,
		providerId: provider.id,
		modelId,
		name: modelId,
		...values,
		...(pricing ? { pricing } : {}),
	};
}

/** 导入时会给这个模型写的上下文窗口，格式和模型列表里的一样。 */
export function windowLabel(provider: Pick<ProviderEntry, "baseUrl">, modelId: string): string {
	return `${Math.round(initialValues(provider, modelId).contextWindow / 1000)}K`;
}
