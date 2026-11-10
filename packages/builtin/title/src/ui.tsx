/**
 * plume.title 的界面入口：设置 › 常规里「智能标题总结」的开关，设置 › 智能体 › 会话里起标题用哪个模型。
 * 两行的名字和说明都由宿主画，这里只画右边的开关和下拉。
 */

import type { Remote, UiContext, UiPlugin } from "@plume/contract/ui";
import { Toggle, useI18n } from "@plume/ui";
import { useEffect, useState } from "react";
import type { TitleApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";

let ui: UiContext;
let api: Remote<TitleApi>;

function ModelSetting() {
	const text = MESSAGES[useI18n().resolvedLocale];
	const defaults = ui.useModelDefaults();
	const [model, setModel] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(true);
	useEffect(() => {
		let alive = true;
		void api
			.model()
			.then(
				(value: string | undefined) => {
					if (alive) setModel(value);
				},
				(error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"),
			)
			.finally(() => {
				if (alive) setBusy(false);
			});
		return () => {
			alive = false;
		};
	}, []);
	const inherited = defaults.sessionModel ?? defaults.defaultModel;
	return (
		<ui.ModelSelect
			ariaLabel={text.modelTitle}
			value={model ?? ""}
			disabled={busy}
			inheritLabel={text.followMain}
			{...(inherited ? { inheritedModelId: inherited } : {})}
			inheritedSource={text.followMainShort}
			inheritDetail={text.modelDetail}
			onChange={(next) => {
				const previous = model;
				setModel(next || undefined);
				void api.setModel(next || undefined).catch((error: unknown) => {
					setModel(previous);
					ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
			}}
		/>
	);
}

function SwitchSetting() {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
	useEffect(() => {
		let alive = true;
		void api.enabled().then(
			(value: boolean) => {
				if (alive) setEnabled(value);
			},
			(error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"),
		);
		return () => {
			alive = false;
		};
	}, []);
	return (
		<Toggle
			checked={enabled ?? true}
			disabled={enabled === undefined}
			ariaLabel={text.switchTitle}
			onChange={(next) => {
				setEnabled(next);
				void api.setEnabled(next).catch((error: unknown) => {
					setEnabled(!next);
					ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
			}}
		/>
	);
}

export default {
	name: "plume.title",
	apply(context) {
		ui = context;
		api = context.remote<TitleApi>();
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
