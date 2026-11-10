/**
 * 写给模型的话：`spawn_session`、`archive_session` 的说明和结果、新会话交回来时的那段。说明用英文（和别的工具一样），交回那段用中文（和本体的送达抬头一样）。
 *
 * `edits_in_parallel` 只是卡片上工作树开关的起始值：开不开由人在卡片上定，工作树由服务 `session.worktree` 开。
 */

// i18n-exempt：发给模型的话。
export const SPAWN_SESSION_DESCRIPTION =
	"Suggest a new, separate conversation for follow-up work that deserves its own session: something you noticed that is worth doing but would bloat the current change — dead code, stale docs, missing tests, a TODO you confirmed, a security problem spotted in passing. " +
	"How it differs from a sub-agent (`task`): the person sees it as a card and decides whether it starts; once started it is a conversation in their sidebar they can open, talk to and stop, with its own clean context, and it stays afterwards to be continued. " +
	"A sub-agent is yours: it runs at once, the person cannot see or steer it, and it only hands its conclusion back to you. Work you need done now to finish the current task, that nobody has to watch, is a sub-agent's. " +
	"Not for vague code smells, low-confidence guesses, small fixes you can make inline, or the current task itself — unless the person asks you to split their task across separate sessions; then each part is a spawn_session with report_back true, and edits_in_parallel true when the parts change the same repository. " +
	"Returns immediately and starts nothing. Keep working on the current task afterwards. " +
	"The prompt is the new conversation's first message and is all it will know: name the files and give enough context to act without this conversation.";

/** 按码位数，人数卡片标题里的字就是这么数的。 */
export const TITLE_MAX = 60;
export const SUMMARY_MAX = 400;
/** 一份完整的交代装得下；再长就是把一段记录贴进了提示词。 */
export const PROMPT_MAX = 20_000;

// i18n-exempt：发给模型的话。
export const SPAWN_SESSION_PARAMETERS = {
	type: "object",
	properties: {
		title: { type: "string", maxLength: TITLE_MAX, description: "The card's title: an imperative phrase starting with a verb, at most 60 characters." },
		summary: { type: "string", description: "One or two sentences for the card: first why you are suggesting it now, then what the new conversation will do." },
		prompt: {
			type: "string",
			description: "The new conversation's first message. Self-contained: file paths and context, no references to this conversation.",
		},
		report_back: {
			type: "boolean",
			description:
				"Default false. True when what it finds should change what you do here, and always when it carries out part of a task the person gave you (they asked you to split the work across sessions): you are the one they will ask how it went. When its first turn ends, its reply is delivered to this conversation and starts a turn here. Leave it off for independent follow-ups. The person can still change it on the card.",
		},
		edits_in_parallel: {
			type: "boolean",
			description:
				"Default false. True when it will change files in this repository while this conversation or other suggested sessions are also changing them — the parts of a split task. The card then starts it in a worktree of its own, so no two sessions edit one checkout and none has to negotiate who owns which file; it merges back when done. The person can still change it on the card.",
		},
	},
	required: ["title", "summary", "prompt"],
	additionalProperties: false,
} as const;

// i18n-exempt：发给模型的话。
export const ARCHIVE_SESSION_DESCRIPTION =
	'Archive this conversation once the current turn ends. Use it only when the person asked for this conversation to be archived, for example "archive it when you\'re done" — never on your own initiative. ' +
	"Your turn ends as soon as this returns and nothing you write after it is read, so put your final reply in the same message, before the call. " +
	"The person can restore the conversation from Settings › Archived chats.";

export const REASON_MAX = 200;

// i18n-exempt：发给模型的话。
export const ARCHIVE_SESSION_PARAMETERS = {
	type: "object",
	properties: {
		reason: { type: "string", description: "Optional: what was finished, in a few words." },
	},
	additionalProperties: false,
} as const;

// i18n-exempt：发给模型的话。
export const ARCHIVED = "This conversation is archived as soon as this turn ends, which is now. The person can restore it from Settings › Archived chats.";

/** 模型得听到什么都还没开始：一张等人点的卡片，从它这边看和正在进行的活一模一样。 */
export function suggested(title: string, reportBack: boolean): string {
	return (
		`Suggested "${title}". Nothing has started: a card is waiting in the conversation, and the new session begins only if the person clicks Start. ` +
		(reportBack ? "If it starts and its first turn finishes, its reply is delivered here; do not wait for it. " : "") +
		"Carry on with the current task."
	);
}

function attribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// i18n-exempt：发给模型的话。
/** 交回来的那段：本体在前面加「不是用户说的话」的抬头，这里说是谁、怎么收场的、拿它怎么办。 */
export function reportText(report: { sessionId: string; title: string; status: "done" | "failed"; reply: string }): string {
	return [
		"你之前建议另开、用户点了开始的会话跑完了第一轮。下面是它最后的回复；那个会话还在，用户可以接着在那里跟它说话：",
		`<session_result id="${report.sessionId}" title="${attribute(report.title)}" status="${report.status}">\n${report.reply || "（它没有留下回复。）"}\n</session_result>`,
		"就着这份结果接着做你手上的事：说清它带来了什么、要不要因此改你正在做的。它做过的事不要再做一遍。",
	].join("\n\n");
}
