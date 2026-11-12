/**
 * plume.environment 的界面入口：标题栏的「环境」开关（`ui.sessionToolbar`）、跟着会话的环境卡片（`ui.conversationCard` 的 `lane`），
 * 和只从卡片打开的两个面板（一个子会话、全部子会话）。卡片里别的插件的节经 `ui.useEnvironmentSections` 拿，不认是谁登记的。
 */

import type { SessionView } from "@plume/contract";
import type { ConversationCardProps, PanelProps, UiPlugin } from "@plume/contract/ui";
import { Text, useI18n } from "@plume/ui";
import { Bot } from "@plume/ui/icons";
import type { EnvironmentApi } from "./api.ts";
import { EnvironmentCard, EnvironmentToggle, type Runtime } from "./Environment.tsx";
import { MESSAGES } from "./messages.ts";
import { createState } from "./state.ts";
import css from "./environment.css";

export default {
	name: "plume.environment",
	apply(ui) {
		const style = document.createElement("style");
		style.dataset.pluginStyle = ui.name;
		style.textContent = css;
		document.head.append(style);
		ui.effect(() => style.remove());
		const state = createState(ui.remote<EnvironmentApi>(), ui);
		const runtime: Runtime = { ui, state };
		function Card(props: ConversationCardProps) {
			return <EnvironmentCard {...props} runtime={runtime} />;
		}
		function Toggle({ session }: { session: SessionView }) {
			return <EnvironmentToggle session={session} runtime={runtime} />;
		}
		function Child({ session }: PanelProps) {
			const child = state.useOpenedChild(session?.summary.id ?? "");
			return child ? <ui.Conversation sessionId={child} /> : null;
		}
		function Children({ session, shown }: PanelProps) {
			const words = MESSAGES[useI18n().resolvedLocale];
			const { children } = state.useChildren(session?.summary.id ?? "", Boolean(session) && shown);
			return (
				<div className="plume-environment-child-list">
					{children.map((child) => (
						<button type="button" key={child.id} className="plume-environment-row" onClick={() => session && state.openChild(session.summary.id, child.id)}>
							<Bot size={14} />
							<Text size="detail" className="plume-environment-grow">
								{child.title}
							</Text>
							<Text size="caption" tone="faint">
								{child.running ? words.active : words.done}
							</Text>
						</button>
					))}
				</div>
			);
		}
		ui.panel("child", Child, { title: (locale) => MESSAGES[locale].children, listed: false });
		ui.panel("children", Children, { title: (locale) => MESSAGES[locale].children, listed: false });
		ui.conversationCard("environment", Card, { order: -20, lane: true });
		ui.sessionToolbar("environment", Toggle);
	},
} satisfies UiPlugin;
