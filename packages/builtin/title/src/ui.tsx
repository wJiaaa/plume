/**
 * plume.title 的界面入口：设置 › 常规里「智能标题总结」的开关，设置 › 智能体 › 会话里起标题用哪个模型。
 * 两行的名字和说明都由宿主画，这里只画右边的开关和下拉。
 */

import type { UiContext, UiPlugin } from "@plume/contract/ui";
import { Toggle, useI18n } from "@plume/ui";
import type { TitleSettings } from "./api.ts";
import { MESSAGES } from "./messages.ts";

let ui: UiContext;

/** 改设置；没改成（agent 进程不在、插件停用着）时提示一句，界面上的值跟着逻辑入口那份，不用自己回滚。 */
function save(set: (patch: Partial<TitleSettings>) => Promise<TitleSettings>, patch: Partial<TitleSettings>): void {
	void set(patch).catch((error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"));
}

function ModelSetting() {
	const text = MESSAGES[useI18n().resolvedLocale];
	const defaults = ui.useModelDefaults();
	const [settings, set] = ui.useSettings<TitleSettings>();
	const inherited = defaults.sessionModel ?? defaults.defaultModel;
	return (
		<ui.ModelSelect
			ariaLabel={text.modelTitle}
			value={settings?.model ?? ""}
			disabled={settings === undefined}
			inheritLabel={text.followMain}
			{...(inherited ? { inheritedModelId: inherited } : {})}
			inheritedSource={text.followMainShort}
			inheritDetail={text.modelDetail}
			onChange={(next) => save(set, { model: next || undefined })}
		/>
	);
}

function SwitchSetting() {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [settings, set] = ui.useSettings<TitleSettings>();
	return (
		<Toggle
			checked={settings?.enabled ?? true}
			disabled={settings === undefined}
			ariaLabel={text.switchTitle}
			onChange={(next) => save(set, { enabled: next })}
		/>
	);
}

export default {
	name: "plume.title",
	apply(context) {
		ui = context;
		context.settingsSection("switch", SwitchSetting, {
			title: (locale) => MESSAGES[locale].switchTitle,
			detail: (locale) => MESSAGES[locale].switchDetail,
			page: "general",
		});
		context.settingsSection("model", ModelSetting, {
			title: (locale) => MESSAGES[locale].modelTitle,
			detail: (locale) => MESSAGES[locale].modelDetail,
			page: "session-models",
		});
	},
} satisfies UiPlugin;
