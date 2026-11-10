/**
 * plume.ask-user 的界面入口：`ask_user` 的提问卡（`ui.approvalCard`，`QuestionCard.tsx`），和它在转录里的说法
 * （「征询 要不要先备份？」）。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { MessageCircle } from "@plume/ui/icons";
import type { AskUserApi } from "./api.ts";
import askCss from "./ask-user.css";
import { MESSAGES } from "./messages.ts";
import { ASK_USER } from "./question.ts";
import { questionCard } from "./QuestionCard.tsx";

const NAME = "plume.ask-user";
/** 转录一行里问题只露个开头，整句在提问卡上。 */
const SUBJECT_CHARS = 40;

function mountStyles(): void {
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${NAME}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = NAME;
		document.head.append(style);
	}
	style.textContent = askCss;
}

export default {
	name: NAME,
	apply(ui) {
		mountStyles();
		ui.approvalCard(ASK_USER, questionCard(ui.remote<AskUserApi>()));
		ui.toolLine(ASK_USER, {
			verb: (locale) => MESSAGES[locale].verb,
			subject: (args) => (typeof args.question === "string" && args.question.trim() ? args.question.trim().slice(0, SUBJECT_CHARS) : undefined),
			icon: MessageCircle,
		});
	},
} satisfies UiPlugin;
