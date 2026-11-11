/**
 * 设置 › 智能体：页头和介绍是产品的，下面是插件画进来的两样——
 * `agents` 是整节（子智能体插件的名单和编辑器），`session-models` 是「会话」那张卡里的一行（侧边聊天、标题、记忆各自用哪个模型）。
 * 「会话」卡的最后一行是产品自己的默认生图模型：生图模型是模型设置的一部分，装没装生图插件都在这里选。
 *
 * 一行的名字和说明由这里按插件给的 `title`、`detail` 画，插件只画右边的控件：几个插件的行放在同一张卡里，
 * 要是各画各的，字号和留白很快就是三种。
 */

import { ErrorBoundary, useI18n } from "@plume/ui";
import { type ReactNode, useMemo } from "react";
import { flattenGroups, groupModels } from "../models/model-grouping.ts";
import { ModelSelect } from "../models/ModelSelect.tsx";
import { setImageModel, useModels } from "../models/store.ts";
import { listPageSettingsSections, localized, usePluginUis } from "../plugins.tsx";
import { Card, PageHeader, saveFailed } from "./controls.tsx";

export function AgentsSettings({ onOpenModelSettings }: { onOpenModelSettings: () => void }) {
	const { t, resolvedLocale } = useI18n();
	usePluginUis();
	const sections = listPageSettingsSections("agents");
	const rows = listPageSettingsSections("session-models");
	const models = useModels();
	const imageModels = useMemo(() => flattenGroups(groupModels(models?.providers, "image")), [models?.providers]);
	return (
		<div data-agent-settings="">
			<PageHeader title={t("agents.title")} intro={t("agents.intro")} />
			<div className="@container">
				{sections.map((entry) => (
					<ErrorBoundary key={entry.key}>
						<entry.component />
					</ErrorBoundary>
				))}
				<section className={sections.length > 0 ? "mt-9" : ""}>
					<div className="mb-3 flex items-center justify-between gap-3">
						<h2 className="flex h-7 items-center gap-1.5 text-label font-medium text-ink">{t("common.session")}</h2>
					</div>
					<Card className="@container divide-y divide-line-soft">
						{rows.map((entry) => {
							const detail = entry.detail ? localized(entry.detail, resolvedLocale) : undefined;
							return (
								<SessionModelRow key={entry.key} id={entry.key} name={localized(entry.title, resolvedLocale)} {...(detail ? { detail } : {})}>
									<ErrorBoundary>
										<entry.component />
									</ErrorBoundary>
								</SessionModelRow>
							);
						})}
						{/*
						 * 出图不跟随对话模型——对话模型画不了图。不选就是第一个生图模型，加一个就能画；
						 * 一个都没有时这一行说去哪里加，而不是给一个空菜单。
						 */}
						<SessionModelRow id="image" name={t("agents.imageModel")} detail={imageModels[0] ? t("agents.imageModelDetail") : t("agents.imageModelNone")}>
							<ModelSelect
								kind="image"
								ariaLabel={t("agents.imageModel")}
								value={models?.imageModelId ?? ""}
								inheritLabel={t("agents.imageModelAuto")}
								{...(imageModels[0] ? { inheritedModelId: imageModels[0].model.id } : {})}
								inheritedSource={t("agents.imageModelAutoShort")}
								inheritDetail={t("agents.imageModelDetail")}
								disabled={!imageModels[0]}
								onChange={(modelId) => void setImageModel(modelId || null).catch(saveFailed)}
								onOpenSettings={onOpenModelSettings}
							/>
						</SessionModelRow>
					</Card>
				</section>
			</div>
		</div>
	);
}

/** 「会话」卡里的一行：名字和说明在左，控件在右；窄时控件换到下一行。 */
function SessionModelRow({ id, name, detail, children }: { id: string; name: string; detail?: string; children: ReactNode }) {
	return (
		<div data-session-model={id} className="grid grid-cols-1 items-center gap-3 px-4 py-3 @2xl:grid-cols-[minmax(0,1fr)_auto]">
			<div className="min-w-0">
				<div className="truncate text-label font-medium text-ink">{name}</div>
				{detail && <p className="mt-1 text-detail text-ink-faint">{detail}</p>}
			</div>
			<div className="flex min-w-0 justify-end">{children}</div>
		</div>
	);
}
