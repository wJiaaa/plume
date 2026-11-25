/**
 * plume.ask-user 的界面入口：`ask_user` 的提问卡（`ui.requestCard`，`QuestionCard.tsx`）和它在转录里的说法
 * （「征询 要不要先备份？」），回复末尾的选择卡（`ui.codeBlock`，`ChoiceCard.tsx`）。
 */

import type { CodeBlockProps, UiPlugin } from "@plume/contract/ui";
import { MessageCircle } from "@plume/ui/icons";
import type { AskUserApi } from "./api.ts";
import askCss from "./ask-user.css";
import { ChoiceBlock } from "./ChoiceCard.tsx";
import choiceCss from "./choice-card.css";
import { CHOICES, choicesText, readChoices } from "./choices.ts";
import { MESSAGES } from "./messages.ts";
import { ASK_USER } from "./question.ts";
import { QuestionCard } from "./QuestionCard.tsx";

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
	style.textContent = askCss + choiceCss;
}

export default {
	name: NAME,
	apply(ui) {
		mountStyles();
		ui.requestCard(ASK_USER, QuestionCard);
		ui.toolLine(ASK_USER, {
			verb: (locale) => MESSAGES[locale].verb,
			subject: (args) => (typeof args.question === "string" && args.question.trim() ? args.question.trim().slice(0, SUBJECT_CHARS) : undefined),
			icon: MessageCircle,
		});
		const api = ui.remote<AskUserApi>();
		ui.codeBlock(CHOICES, (props: CodeBlockProps) => <ChoiceBlock {...props} host={ui} api={api} />, {
			copyText: ({ code }) => {
				const choices = readChoices(code);
				return choices && choicesText(choices);
			},
		});
	},
} satisfies UiPlugin;
