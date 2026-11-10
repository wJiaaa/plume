/**
 * 输入框那一行的模型、思考档位按哪个会话算。和 agent 进程挑模型、挑档位是同一套规则（packages/core/agent/src/models.ts
 * 的 resolveModel、thinkingFor），所以按钮上显示的就是这一轮实际发出去的。
 */

import { isImageModel } from "@plume/llm/image-models";
import { resolveModelThinkingOptions, resolveThinkingOption } from "@plume/llm/thinking-options";
import type { ModelConfig, ThinkingLevel } from "@plume/llm/types";
import { findModel, type ModelsState, settingsView } from "./store.ts";

/** 选择器要知道的会话：选过的模型和档位（都可能为空），以及有没有说过话（中途换模型要先确认）。 */
export type ComposerSession = {
	model?: string;
	thinking?: ThinkingLevel;
	said: boolean;
} & ({ id: string } | { id: null; setModel: (model: string) => void; setThinking: (thinking: ThinkingLevel) => void });

/** 这一轮会用的模型：会话选的还在启用的供应商下、也不是生图模型就用它，否则是默认模型。 */
export function effectiveModelId(settings: ModelsState | undefined, chosen: string | undefined): string | null {
	if (!settings) return null;
	if (chosen && settings.providers.some((provider) => provider.enabled && provider.models.some((model) => model.id === chosen && !isImageModel(model))))
		return chosen;
	return settings.defaultModelId;
}

export function effectiveModel(settings: ModelsState | undefined, chosen: string | undefined): ModelConfig | null {
	return findModel(settings, effectiveModelId(settings, chosen));
}

/** 这一轮会用的档位：会话选过就是它（模型没有这一档时就近取），没选是模型的默认档；不支持思考的模型是 off。 */
export function effectiveThinking(model: ModelConfig | null, chosen: ThinkingLevel | undefined): ThinkingLevel {
	const option = chosen ? resolveThinkingOption(chosen, model) : resolveModelThinkingOptions(model).find((candidate) => candidate.isDefault);
	return option?.id ?? "off";
}

/** 会话选的档位。空白会话还没建，发第一句时 agent 进程会记下设置里的默认档位，所以没选时按它画。 */
export function chosenThinking(session: ComposerSession): ThinkingLevel | undefined {
	return session.thinking ?? (session.id === null ? settingsView()?.thinking : undefined);
}
