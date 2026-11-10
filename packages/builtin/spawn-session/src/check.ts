/** `spawn_session`、`archive_session` 的参数校验：不对就说哪里不对，模型据此改了再发。 */

import { PROMPT_MAX, REASON_MAX, SUMMARY_MAX, TITLE_MAX } from "./prompt.ts";
import type { SessionSuggestion } from "./suggestion.ts";

/** 去掉首尾空白的字，或者为什么用不了。 */
function field(value: unknown, name: string, max: number): string | { error: string } {
	// i18n-exempt：发给模型的话。
	if (typeof value !== "string" || !value.trim()) return { error: `${name} is required and must be non-empty text.` };
	const text = value.trim();
	const length = [...text].length;
	// i18n-exempt：发给模型的话。
	if (length > max) return { error: `${name} is ${length} characters; keep it to ${max}.` };
	return text;
}

export function checkSuggestion(args: Record<string, unknown>): SessionSuggestion | { error: string } {
	const title = field(args.title, "title", TITLE_MAX);
	if (typeof title !== "string") return title;
	const summary = field(args.summary, "summary", SUMMARY_MAX);
	if (typeof summary !== "string") return summary;
	const prompt = field(args.prompt, "prompt", PROMPT_MAX);
	if (typeof prompt !== "string") return prompt;
	// i18n-exempt：发给模型的话。
	if (args.report_back !== undefined && typeof args.report_back !== "boolean") return { error: "report_back must be true or false." };
	// i18n-exempt：发给模型的话。
	if (args.edits_in_parallel !== undefined && typeof args.edits_in_parallel !== "boolean") return { error: "edits_in_parallel must be true or false." };
	return {
		kind: "session_suggestion",
		title,
		summary,
		prompt,
		...(args.report_back === true ? { reportBack: true as const } : {}),
		...(args.edits_in_parallel === true ? { worktree: true as const } : {}),
	};
}

/** `archive_session` 的 `reason`：可以不给，给了就得是不太长的一句话。 */
export function checkArchive(args: Record<string, unknown>): { reason?: string } | { error: string } {
	if (args.reason === undefined) return {};
	const reason = field(args.reason, "reason", REASON_MAX);
	return typeof reason === "string" ? { reason } : reason;
}
