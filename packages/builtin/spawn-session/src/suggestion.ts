/**
 * 几件工具留给卡片的东西。逻辑入口把它们写成工具结果的 `details`，会话记录里存着：明天重开这个对话，卡片还在，
 * 带着它要开始时的那段话。界面入口读回来画卡片，「开始」时逻辑入口再从记录里读一遍，不信界面交来的。两边都要这些形状，所以单放。
 */

export const SPAWN_SESSION = "spawn_session";
export const HAND_OFF = "hand_off_to_session";
export const DISMISS_TASK = "dismiss_task";
export const ARCHIVE_SESSION = "archive_session";
/** `initiation: "offer"` 弹给人的那张卡（`run.request` 的 `kind`）。 */
export const SESSION_OFFER = "plume.spawn-session.offer";

/** 建议卡（`own_initiative`）摆多久：过了就不能再开始，模型要重提。 */
export const SUGGESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 新会话怎么起头：只带简报（`fresh`），或者带着来处的整段对话（`fork`）。 */
export interface Briefing {
	title: string;
	/** 来处叫它的短名（`SessionLaunch.spawnedFrom.name`）。 */
	name?: string;
	/** 新会话的第一句话：`fresh` 时已经拼好背景和任务。 */
	message: string;
	fork?: true;
	/** 模型说它会和别的会话同时改同一个仓库（`use_worktree`）；卡片上的工作树开关从它起步，直接开的照它开。 */
	worktree?: true;
}

/** 一张建议卡：模型自己发现的事，人点了「开始」才开。 */
export interface SessionSuggestion extends Briefing {
	kind: "session_suggestion";
	/** 卡片上一两句理由。 */
	summary: string;
	/** 过了这一刻（毫秒时间戳）就不能再开始。 */
	expiresAt: number;
}

/** 一次 offer：问了人要不要另开，人选了什么。选「开新会话」时模型带着 `proposal_id` 再调一次补上简报。 */
export interface SessionOffer {
	kind: "session_offer";
	title: string;
	choice: "new" | "here";
}

/** 当场开出来的会话：`user_asked`、带 `proposal_id` 的那次、移交。 */
export interface SessionStarted {
	kind: "session_started";
	title: string;
	name?: string;
	sessionId: string;
	/** 开的是哪一条建议或 offer（它们的调用 id）；当场开的不带。 */
	proposalId?: string;
	handOff?: true;
}

/** 模型撤回了一条建议。 */
export interface TaskDismissed {
	kind: "session_dismissed";
	proposalId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function isSuggestion(value: unknown): value is SessionSuggestion {
	const one = record(value);
	return (
		one?.kind === "session_suggestion" &&
		typeof one.title === "string" &&
		typeof one.summary === "string" &&
		typeof one.message === "string" &&
		typeof one.expiresAt === "number"
	);
}

export function isOffer(value: unknown): value is SessionOffer {
	const one = record(value);
	return one?.kind === "session_offer" && typeof one.title === "string" && (one.choice === "new" || one.choice === "here");
}

export function isStarted(value: unknown): value is SessionStarted {
	const one = record(value);
	return one?.kind === "session_started" && typeof one.title === "string" && typeof one.sessionId === "string";
}

export function isDismissed(value: unknown): value is TaskDismissed {
	const one = record(value);
	return one?.kind === "session_dismissed" && typeof one.proposalId === "string";
}

/**
 * fork、移交开出的会话开头复制了来处的那段记录，复制来的消息带着原来的时间，早于这个会话建成：那里面的建议、offer 是在原对话里提的，
 * 在这里开不了，也不再催人——不然两边各点一次，同一条建议开出两个会话。
 */
export function inherited(message: { timestamp: number }, createdAt: number): boolean {
	return message.timestamp < createdAt;
}
