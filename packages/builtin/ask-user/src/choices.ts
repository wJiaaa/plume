/**
 * 选择卡：一轮收尾时留给人的一个决定。模型在回复末尾写一个 `choices` 围栏，界面入口画成卡片，人点一项就把那一项的 `send`
 * 当自己的消息发出去。提示词、解析、这张卡答没答都在这一个文件里：教给模型的写法就是认得出来的写法。两个入口都用它，不碰 Node。
 *
 * 和 `ask_user` 的分工：那个停在一轮中间等答案，答案是工具结果；这个不占着一轮，人不理它、直接打字也行，选了就是人的一条消息。
 *
 * 答没答不另存，从会话里推：这条回复之后人说的第一句是某一项的 `send` 就是选了它，是别的话就是没采用这张卡。
 * 重开应用、撤回、编辑重发、分叉以后都对得上。
 */

import type { Message, QueuedMessage, UserMessage } from "@plume/contract";
import { ASK_USER } from "./question.ts";

/** 围栏的语言。 */
export const CHOICES = "choices";

/** 提示词里这一段的名字。 */
export const CHOICE_SECTION = "choiceCard";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

export interface Choice {
	label: string;
	/** 点了以后当人的消息发出去的话。 */
	send: string;
	recommended: boolean;
}

export interface Choices {
	summary?: string;
	question: string;
	options: Choice[];
}

/** 写进系统提示词的那一段。只教 2 到 4 项：再多就该在正文里先收窄；解析放宽到 6 项，多写了也不至于退回源码。 */
// i18n-exempt：提示词是发给模型的，不随界面语言变。
export const CHOICES_PROMPT = `Choice card:
When your final reply of a turn leaves the user one decision between 2 to 4 concrete options (plans you laid out, directions to take), end that reply with one fenced block:
\`\`\`${CHOICES}
{"summary": "Where things stand", "question": "The decision?", "options": [{"label": "Option B", "send": "Go with option B: ...", "recommended": true}, {"label": "Option A", "send": "Go with option A: ..."}]}
\`\`\`
The app draws it as a card, and clicking an option sends its "send" text as the user's next message. Most replies need no card.
- Explain and compare the options in the reply itself; the card only collects the answer. Write plain text in the user's language, no Markdown.
- summary: one or two sentences on what is settled and what has not been done yet. question: the one decision, ending in a question mark. label: a few words, naming the option as the reply does. send: a full sentence in the user's voice that makes sense without the card.
- Put the option you recommend first and mark it recommended; mark at most one.
- Valid JSON, one card per reply, nothing after it, and never in a reply that calls tools.
- No card for a choice you can make yourself, for "shall I continue?", for an open question, or when the user has already decided. If you cannot go on mid-task without the answer, call \`${ASK_USER}\` instead; never use both for the same question.`;

const filled = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());

/** 围栏里的原文读成一张卡；写了一半的、不成立的是 undefined，界面照源码画。 */
export function readChoices(code: string): Choices | undefined {
	let value: unknown;
	try {
		value = JSON.parse(code);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { summary, question, options } = value as Record<string, unknown>;
	if (!filled(question) || (summary !== undefined && typeof summary !== "string")) return undefined;
	if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return undefined;
	const choices: Choice[] = [];
	for (const option of options as unknown[]) {
		if (typeof option !== "object" || option === null) return undefined;
		const { label, send, recommended } = option as Record<string, unknown>;
		if (!filled(label) || !filled(send) || (recommended !== undefined && typeof recommended !== "boolean")) return undefined;
		// 只认第一个推荐：主按钮一处只有一个。
		choices.push({ label: label.trim(), send: send.trim(), recommended: recommended === true && !choices.some((choice) => choice.recommended) });
	}
	// 按发出去的话认选了哪一项，两项发同一句就分不开。
	if (new Set(choices.map((choice) => choice.send)).size !== choices.length) return undefined;
	return { ...(filled(summary) ? { summary: summary.trim() } : {}), question: question.trim(), options: choices };
}

/** 复制回复时这张卡的文字。 */
export function choicesText(choices: Choices): string {
	return [...(choices.summary ? [choices.summary, ""] : []), choices.question, ...choices.options.map((choice) => `- ${choice.label}`)].join("\n");
}

const FENCE = new RegExp(`^[ \\t]*(\`{3,}|~{3,})[ \\t]*${CHOICES}(?:[ \\t][^\\n]*)?\\n([\\s\\S]*?)^[ \\t]*\\1`, "gim");

/** 一段回复里写了这张卡。 */
function holds(text: string, wanted: string): boolean {
	for (const match of text.replace(/\r\n/g, "\n").matchAll(FENCE)) {
		const found = readChoices(match[2]!);
		if (found && JSON.stringify(found) === wanted) return true;
	}
	return false;
}

/** 人说的话：界面替人说的、后台送达、别的会话的信（`synthetic`）和子会话交过来的事不算。 */
const spokenByHuman = (message: Message): message is UserMessage => message.role === "user" && !message.synthetic && message.origin !== "child";

function words(message: Pick<UserMessage, "displayText" | "content">): string {
	return (message.displayText ?? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")).trim();
}

/** `open` 还等着人选；`passed` 人说了别的话，没采用；否则是选了的那一项。 */
export type Outcome = "open" | "passed" | Choice;

/** 这张卡答没答。排着还没发出去的也算人说了。两条回复里写了一字不差的同一张卡，都按后面那条的算。 */
export function outcomeOf(choices: Choices, messages: readonly Message[], queue: readonly QueuedMessage[]): Outcome {
	const wanted = JSON.stringify(choices);
	const at = messages.findLastIndex(
		(message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && holds(block.text, wanted)),
	);
	// 还在写的那条回复不在会话里。
	if (at < 0) return "open";
	const reply = messages.slice(at + 1).find(spokenByHuman) ?? queue.find((entry) => !entry.message.synthetic && entry.origin !== "child")?.message;
	if (!reply) return "open";
	const said = words(reply);
	return choices.options.find((choice) => choice.send === said) ?? "passed";
}
