/**
 * 一次 `spawn_session` 留给卡片的东西。逻辑入口把它写成工具结果的 `details`，会话记录里存着：明天重开这个对话，卡片还在，
 * 带着它要开始时的那段提示词。界面入口读回来画卡片，「开始」时逻辑入口再从记录里读一遍，不信界面交来的。两边都要这个形状，所以单放。
 */

export const SPAWN_SESSION = "spawn_session";
export const ARCHIVE_SESSION = "archive_session";

export interface SessionSuggestion {
	kind: "session_suggestion";
	title: string;
	summary: string;
	/** 新会话的第一句话。 */
	prompt: string;
	/** 模型要新会话第一轮的回复交回这里；卡片上的开关从它起步。 */
	reportBack?: true;
	/** 模型说它会和这个对话或别的建议会话同时改同一个仓库（`edits_in_parallel`）；卡片上的工作树开关从它起步。 */
	worktree?: true;
}

export function isSuggestion(value: unknown): value is SessionSuggestion {
	if (typeof value !== "object" || value === null) return false;
	const one = value as Record<string, unknown>;
	return one.kind === "session_suggestion" && typeof one.title === "string" && typeof one.summary === "string" && typeof one.prompt === "string";
}
