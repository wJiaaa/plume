/**
 * plume.environment 的界面入口：标题栏的「环境」开关（`ui.sessionToolbar`）与跟着会话的环境卡片（`ui.conversationCard` 的 `lane`）。
 * 卡片里别的插件的节经 `ui.useEnvironmentSections` 拿，不认是谁登记的。
 */

import type { SessionView } from "@plume/contract";
import type { ConversationCardProps, UiPlugin } from "@plume/contract/ui";
import { EnvironmentCard, EnvironmentToggle } from "./Environment.tsx";
import css from "./environment.css";

export default {
	name: "plume.environment",
	apply(ui) {
		const style = document.createElement("style");
		style.dataset.pluginStyle = ui.name;
		style.textContent = css;
		document.head.append(style);
		ui.effect(() => style.remove());
		function Card(props: ConversationCardProps) {
			return <EnvironmentCard {...props} ui={ui} />;
		}
		function Toggle({ session }: { session: SessionView }) {
			return <EnvironmentToggle session={session} ui={ui} />;
		}
		ui.conversationCard("environment", Card, { order: -20, lane: true });
		ui.sessionToolbar("environment", Toggle);
	},
} satisfies UiPlugin;
