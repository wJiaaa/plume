/**
 * 设置 › 个性化：全局指令、语气，中间是插件画进来的分区（记忆插件的记忆管理）。
 *
 * 全局指令和语气存在 agent 进程的设置里，每个会话的系统提示词各占一段；这一页只读写它们。
 */

import { useState, useSyncExternalStore } from "react";
import type { Tone } from "@plume/contract";
import { DialogAction, ErrorBoundary, TextArea, useI18n } from "@plume/ui";
import { Check, Info, Save } from "@plume/ui/icons";
import { listPageSettingsSections, usePluginUis } from "../plugins.tsx";
import { modelsAgent, refreshModels, settingsView, subscribeModels } from "../models/store.ts";
import { Card, InlineSelect, PageHeader, Row, SectionTitle } from "./controls.tsx";

export function PersonalizationSettings() {
	const { t } = useI18n();
	usePluginUis();
	const personalization = useSyncExternalStore(subscribeModels, settingsView)?.personalization ?? { customInstructions: "", tone: "friendly" as Tone };
	// 没动过时跟着存下的走：设置晚一步读到，框里也是存下的那份，不是空的。
	const [draft, setDraft] = useState<string | null>(null);
	const customInstructions = draft ?? personalization.customInstructions;
	const [savedNotice, setSavedNotice] = useState(false);

	const save = async (change: Partial<typeof personalization>) => {
		await modelsAgent().setPersonalization(change);
		await refreshModels();
	};

	const handleSaveInstructions = async () => {
		await save({ customInstructions });
		setDraft(null);
		setSavedNotice(true);
		setTimeout(() => setSavedNotice(false), 2000);
	};

	return (
		<>
			<PageHeader title={t("settings.personalization")} />
			<div className="flex flex-col gap-9">
				<div>
					<div className="mb-3 flex items-center justify-between">
						<div>
							<SectionTitle>{t("tone.customInstructions")}</SectionTitle>
							<p className="mt-0.5 text-caption text-ink-muted">{t("personalization.globalRules")}</p>
						</div>
						{/* 存完那一下变成勾加「已保存」，过两秒变回去。 */}
						<DialogAction
							onClick={() => void handleSaveInstructions()}
							disabled={customInstructions === personalization.customInstructions}
							label={savedNotice ? t("common.saved") : t("common.save")}
						>
							{savedNotice ? <Check size={13} className="text-ok" strokeWidth={2.2} aria-hidden /> : <Save size={13} strokeWidth={1.9} aria-hidden />}
							{savedNotice ? t("common.saved") : t("common.save")}
						</DialogAction>
					</div>
					<Card className="flex flex-col gap-2 p-3.5">
						<TextArea value={customInstructions} onChange={setDraft} placeholder={t("tone.sampleRules")} rows={7} className="plume-textarea-mono" />
						<div className="flex items-center gap-1.5 px-1 text-caption text-ink-faint">
							<Info size={12} strokeWidth={1.8} />
							<span>{t("tone.customDetail")}</span>
						</div>
					</Card>
				</div>

				{/* 插件画进这一页的分区（记忆），各自画标题；一个出错不拖垮整页。 */}
				{listPageSettingsSections("personalization").map((entry) => (
					<ErrorBoundary key={entry.key}>
						<div>
							<entry.component />
						</div>
					</ErrorBoundary>
				))}

				<div>
					<div className="mb-3">
						<SectionTitle>{t("tone.section")}</SectionTitle>
						<p className="mt-0.5 text-caption text-ink-muted">{t("personalization.toneIntro")}</p>
					</div>
					<Card>
						<Row
							title={t("tone.title")}
							detail={t("tone.detail")}
							control={
								<InlineSelect
									value={personalization.tone}
									onChange={(tone: Tone) => void save({ tone })}
									ariaLabel={t("tone.title")}
									options={[
										{ value: "friendly", label: t("tone.warm") },
										{ value: "professional", label: t("tone.professional") },
										{ value: "concise", label: t("tone.terse") },
										{ value: "candid", label: t("tone.blunt") },
										{ value: "humorous", label: t("tone.playful") },
									]}
								/>
							}
						/>
					</Card>
				</div>
			</div>
		</>
	);
}
