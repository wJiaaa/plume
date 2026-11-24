/**
 * plume.scripts 界面入口：
 * - `ui.environmentSection("scripts", ...)`: 环境卡片顶部的工作区脚本入口，一键运行与管理/导入；
 * - `ui.settingsSection("scripts", ...)`: 设置 › 项目脚本页，管理全局默认与各项目覆盖；
 * - `ui.composerAbove("setup-status", ...)`: 同步等待工作树初始化脚本时的状态条与「查看终端」入口。
 */

import type { ComposerAboveProps, EnvironmentSectionProps, UiPlugin } from "@plume/contract/ui";
import { Play } from "@plume/ui/icons";
import type { ScriptsApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import scriptsCss from "./scripts.css";
import { ScriptsSettings } from "./ScriptsSettings.tsx";
import { ScriptsToolbar } from "./ScriptsToolbar.tsx";
import { SetupStatusBar } from "./SetupStatusBar.tsx";

function mountStyles(): void {
	const id = "plume.scripts";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = scriptsCss;
}

export default {
	name: "plume.scripts",
	apply(ui) {
		mountStyles();
		const api = ui.remote<ScriptsApi>();

		function Section({ session }: EnvironmentSectionProps) {
			return <ScriptsToolbar session={session} api={api} ui={ui} />;
		}

		function SetupBar(props: ComposerAboveProps) {
			return <SetupStatusBar {...props} api={api} ui={ui} />;
		}

		function Settings() {
			return <ScriptsSettings api={api} ui={ui} />;
		}

		ui.environmentSection("scripts", Section, {
			label: (locale) => MESSAGES[locale].projectScripts,
			place: "head",
			order: 10,
		});
		ui.composerAbove("setup-status", SetupBar, { order: -10 });
		ui.settingsSection("scripts", Settings, {
			title: (locale) => MESSAGES[locale].settingsTitle,
			detail: (locale) => MESSAGES[locale].settingsDetail,
			icon: Play,
			group: "vcs",
			order: 10,
			page: "nav",
		});
	},
} satisfies UiPlugin;
