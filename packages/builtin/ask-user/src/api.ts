/** `ctx.sessionStore` 的键：这个会话最近关掉的那张选择卡，没关过是空串。 */
export const DISMISSED = "dismissed";

export interface AskUserApi {
	/** 人关掉了一张选择卡。`card` 是卡片的标识（`cardKey`）。 */
	dismiss(sessionId: string, card: string): void;
}

/** 一张选择卡在会话里的标识：哪条消息的哪一块。 */
export const cardKey = (messageId: string, blockId: string): string => `${messageId}/${blockId}`;
