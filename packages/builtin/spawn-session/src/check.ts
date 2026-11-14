/** 几件工具的参数校验：不对就说哪里不对，模型据此改了再发。 */

import { BACKGROUND_MIN, freshMessage, PROMPT_MAX, REASON_MAX, SUMMARY_MAX, TITLE_MAX } from "./prompt.ts";
import type { Briefing } from "./suggestion.ts";

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

function flag(value: unknown, name: string): boolean | { error: string } {
	if (value === undefined) return false;
	// i18n-exempt：发给模型的话。
	return typeof value === "boolean" ? value : { error: `${name} must be true or false.` };
}

const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** 短名：给了就照宿主的规矩核，没给从标题里取（只取得出拉丁字母、数字时；取不出就不起名）。 */
function nameOf(value: unknown, title: string): string | undefined | { error: string } {
	if (value === undefined) {
		const derived = title
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+/, "")
			.slice(0, 24)
			.replace(/-+$/, "");
		return derived || undefined;
	}
	// i18n-exempt：发给模型的话。
	if (typeof value !== "string" || !NAME.test(value)) return { error: "name must be lowercase letters, digits and hyphens, at most 24 characters." };
	return value;
}

/**
 * `spawn_session` 读出来的样子：`offer` 第一次只有标题；`proposal` 开一条建议卡或补上 offer 的简报；`now` 当场开（`user_asked`）；
 * `suggest` 出一张建议卡（`own_initiative`）。
 */
export type SpawnRequest =
	| { kind: "offer"; title: string }
	| { kind: "proposal"; proposalId: string; briefing?: Omit<Briefing, "title" | "name"> }
	| { kind: "now"; briefing: Briefing }
	| { kind: "suggest"; briefing: Briefing; summary: string };

/** 背景和任务拼成第一句话，或者 fork 时只要任务。 */
function brief(args: Record<string, unknown>): Omit<Briefing, "title" | "name"> | { error: string } {
	const prompt = field(args.prompt, "prompt", PROMPT_MAX);
	if (typeof prompt !== "string") return prompt;
	const context = args.context ?? "fresh";
	// i18n-exempt：发给模型的话。
	if (context !== "fresh" && context !== "fork") return { error: 'context must be "fresh" or "fork".' };
	const worktree = flag(args.use_worktree, "use_worktree");
	if (typeof worktree !== "boolean") return worktree;
	const extra = worktree ? { worktree: true as const } : {};
	if (context === "fork") return { message: prompt, fork: true, ...extra };
	const background = field(args.background, "background", PROMPT_MAX);
	if (typeof background !== "string")
		// i18n-exempt：发给模型的话。
		return { error: 'background is required with context "fresh": the goal, decisions and constraints so far, and where this piece fits.' };
	// i18n-exempt：发给模型的话。
	if ([...background].length < BACKGROUND_MIN) return { error: `background is too short to act on; give at least ${BACKGROUND_MIN} characters of context.` };
	return { message: freshMessage(background, prompt), ...extra };
}

export function checkSpawn(args: Record<string, unknown>): SpawnRequest | { error: string } {
	const initiation = args.initiation;
	if (initiation !== "offer" && initiation !== "user_asked" && initiation !== "own_initiative")
		// i18n-exempt：发给模型的话。
		return { error: 'initiation must be "offer", "user_asked" or "own_initiative".' };
	if (args.proposal_id !== undefined) {
		// i18n-exempt：发给模型的话。
		if (typeof args.proposal_id !== "string" || !args.proposal_id) return { error: "proposal_id must be the id of an earlier spawn_session call." };
		// 只带 proposal_id：开一张建议卡；带了任务：补上 offer 的简报。
		if (args.prompt === undefined) return { kind: "proposal", proposalId: args.proposal_id };
		const briefing = brief(args);
		return "error" in briefing ? briefing : { kind: "proposal", proposalId: args.proposal_id, briefing };
	}
	const title = field(args.title, "title", TITLE_MAX);
	if (typeof title !== "string") return title;
	if (initiation === "offer") return { kind: "offer", title };
	const name = nameOf(args.name, title);
	if (typeof name === "object") return name;
	const briefing = brief(args);
	if ("error" in briefing) return briefing;
	const full = { title, ...(name ? { name } : {}), ...briefing };
	if (initiation === "user_asked") return { kind: "now", briefing: full };
	const summary = field(args.summary, "summary", SUMMARY_MAX);
	return typeof summary === "string" ? { kind: "suggest", briefing: full, summary } : summary;
}

export function checkHandOff(args: Record<string, unknown>): Briefing | { error: string } {
	const title = field(args.title, "title", TITLE_MAX);
	if (typeof title !== "string") return title;
	const name = nameOf(args.name, title);
	if (typeof name === "object") return name;
	const plan = field(args.plan, "plan", PROMPT_MAX);
	if (typeof plan !== "string") return plan;
	const worktree = flag(args.use_worktree, "use_worktree");
	if (typeof worktree !== "boolean") return worktree;
	return { title, ...(name ? { name } : {}), message: plan, fork: true, ...(worktree ? { worktree: true as const } : {}) };
}

/** `archive_session` 的 `reason`：可以不给，给了就得是不太长的一句话。 */
export function checkArchive(args: Record<string, unknown>): { reason?: string } | { error: string } {
	if (args.reason === undefined) return {};
	const reason = field(args.reason, "reason", REASON_MAX);
	return typeof reason === "string" ? { reason } : reason;
}
