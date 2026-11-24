/** 从会话记录里读这一轮提了几张建议卡。这一轮是谁引起的由本体给（`session.cause`），不在这里猜。 */

import type { Message } from "@plume/contract";
import { isSuggestion, SPAWN_SESSION } from "./suggestion.ts";

/**
 * 这条用户消息是人或者别的会话的信说的：数这一轮的建议卡从它往后数。运行时递来的（后台结果、唤醒、钩子补的上下文、
 * 代管插件转来的话）不算，接着往回找。
 */
function spoken(message: Extract<Message, { role: "user" }>): boolean {
	if (message.peer?.length) return true;
	return !(message.synthetic || message.delivery || message.origin === "plugin" || message.origin === "parent");
}

/** 最近一句人说的话之后提的建议卡，按调用 id。 */
export function suggestionsThisTurn(messages: readonly Message[]): Set<string> {
	const ids = new Set<string>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user" && spoken(message)) break;
		if (message.role === "toolResult" && message.toolName === SPAWN_SESSION && !message.isError && isSuggestion(message.details)) ids.add(message.toolCallId);
	}
	return ids;
}
