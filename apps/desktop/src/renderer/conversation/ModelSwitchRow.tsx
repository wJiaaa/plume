import type { SettingsView } from "@plume/contract";
import { useI18n } from "@plume/ui";
import { ArrowRightLeft } from "@plume/ui/icons";
import { useSyncExternalStore } from "react";
import { settingsView, subscribeModels } from "../models/store.ts";
import { DividerRow } from "./DividerRow.tsx";
import type { ModelUsed } from "./grouping.ts";

/**
 * 「服务商/模型」，用设置里起的名字。回复上记的是 id：服务商删了、模型改了名，历史里的切换照样要读得出来，所以找不到就原样写 id。
 */
function modelLabel(settings: SettingsView | undefined, used: ModelUsed): string {
	const provider = settings?.providers.find((each) => each.id === used.provider);
	const model = provider?.models.find((each) => each.modelId === used.model);
	return `${provider?.name ?? used.provider}/${model?.name ?? used.model}`;
}

/** 转录里换了模型的地方：分隔线当中写从哪个换到哪个。 */
export function ModelSwitchRow({ from, to }: { from: ModelUsed; to: ModelUsed }) {
	const { t } = useI18n();
	const settings = useSyncExternalStore(subscribeModels, settingsView);
	const text = t("conversation.modelSwitched", { from: modelLabel(settings, from), to: modelLabel(settings, to) });
	return <DividerRow data-model-switch="" icon={<ArrowRightLeft size={12} strokeWidth={1.8} aria-hidden className="shrink-0" />} text={text} />;
}
