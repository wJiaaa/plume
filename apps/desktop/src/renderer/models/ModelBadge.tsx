/**
 * 只读的模型和思考档位，在输入框那一行、主输入框放模型和档位的同一个位置（子 Agent 的面板）。
 *
 * 换不了，所以不画成按钮、不带下拉箭头；怎么定下的、去哪里改，由插件写在悬停说明的最后一句。
 */

import type { ThinkingLevel } from "@plume/llm/types";
import { useI18n } from "@plume/ui";
import { Brain } from "@plume/ui/icons";
import { effortLabel } from "./EffortMenu.tsx";
import { ModelIcon } from "./ModelIcon.tsx";
import { formatWindow } from "./ModelMenu.tsx";
import { modelIdentity, modelTooltip } from "./model-grouping.ts";
import { effectiveModelId, effectiveThinking } from "./session.ts";
import { useModels } from "./store.ts";

export function ModelBadge({ model, thinking, tip }: { model?: string; thinking?: ThinkingLevel; tip?: string }) {
	const { t } = useI18n();
	const settings = useModels();
	const modelId = effectiveModelId(settings, model);
	const identity = modelIdentity(settings, modelId);
	if (!identity) return null;
	const level = effortLabel(effectiveThinking(identity.model, thinking), identity.model, t);
	const name = identity.ambiguous ? `${identity.provider.name} · ${identity.model.name}` : identity.model.name;
	const tooltip = [modelTooltip(identity, formatWindow), t("composer.thinking", { level }), tip].filter(Boolean).join("\n");
	return (
		<span data-model-badge="" data-plume-tip={tooltip} className="plume-composer-control flex min-w-0 items-center gap-1 px-1.5 text-label text-ink-muted">
			<ModelIcon model={identity.model.modelId} name={identity.model.name} />
			<span className="min-w-0 truncate">{name}</span>
			<Brain size={16} className="ml-1.5 shrink-0" aria-hidden />
			<span className="shrink-0 whitespace-nowrap">{level}</span>
		</span>
	);
}
