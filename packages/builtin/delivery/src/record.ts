import type { FileChangesSummary, Locale, Message, PluginChanges } from "@plume/contract";
import { MESSAGES } from "./logic-messages.ts";

/** 只认该轮最后一条回答；系统补充和继续消息不切断真实用户发起的一轮。 */
export function deliveryMessages(messages: readonly Message[], timestamp: number, locale: Locale): Message[] {
	const end = messages.findLastIndex((message) => message.role === "assistant" && message.timestamp === timestamp);
	const answer = messages[end];
	if (!answer || answer.role !== "assistant" || answer.stopReason === "toolUse" || answer.stopReason === "pending")
		throw new Error(MESSAGES[locale].missingTurn);
	// 回答后补勾清单不属于交付正文，也不改变这条回答的标识。
	let start = end - 1;
	while (start >= 0) {
		const message = messages[start];
		if (message?.role === "user" && !message.synthetic) return messages.slice(start, end + 1);
		start--;
	}
	throw new Error(MESSAGES[locale].missingTurn);
}

/** 一段消息里本体记在工具结果上的改动（`ToolResultMessage.changes`）：快照标识，和有改动没记全时的说明。不认是哪个工具交的。 */
export function recordedChanges(messages: readonly Message[]): { ids: string[]; warnings: string[] } {
	const ids = new Set<string>();
	const warnings: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.changes) continue;
		for (const id of message.changes.ids) ids.add(id);
		if (message.changes.warning) warnings.push(message.changes.warning);
	}
	return { ids: [...ids], warnings };
}

export async function collectDelivery(changes: PluginChanges, sessionId: string, messages: readonly Message[], locale: Locale): Promise<FileChangesSummary> {
	const { ids, warnings } = recordedChanges(messages);
	const value: FileChangesSummary = { files: [], warnings };
	try {
		const summary = await changes.collect(sessionId, ids);
		value.files = summary.files;
		value.warnings.push(...summary.warnings);
	} catch (error) {
		value.warnings.push(MESSAGES[locale].collectFailed(String(error)));
	}
	return value;
}
