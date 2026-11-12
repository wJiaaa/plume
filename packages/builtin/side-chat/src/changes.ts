/**
 * 侧边聊天改了文件，主会话下一轮开头知道一次：它对那几个文件的印象已经过时了，接着往下推之前该重读。
 * 防覆盖靠的不是这句话，是写文件工具的读取校验；这句话管的是主会话别拿着旧印象往下推。
 *
 * 读的是工具结果上挂着的改动记录而不是工具参数：命令里观测到的改动也算，而那些在参数里看不出来。
 */

import type { FileChangeDetails, Message } from "@plume/contract";

/** 这一段消息里出过错之外的工具结果挂着的改动记录。 */
export function changeIds(messages: readonly Message[]): string[] {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult" || message.isError || !message.details || typeof message.details !== "object") continue;
		// 改动记录按结果里的通用声明认（`FileChangeDetails`），不认是哪个工具交的。
		const detail = message.details as { [K in keyof FileChangeDetails]?: unknown };
		if (typeof detail.changeId === "string") ids.add(detail.changeId);
		if (Array.isArray(detail.changeIds)) for (const id of detail.changeIds) if (typeof id === "string") ids.add(id);
	}
	return [...ids];
}

/** 主会话下一轮开头读到的那一句。 */
// i18n-exempt：发给模型的话。
export function sideChangesNote(paths: readonly string[]): string {
	return `<side-chat-changes>\nA side chat changed these files while you were not looking. Re-read any of them before relying on or editing it:\n${paths.map((path) => `- ${path}`).join("\n")}\n</side-chat-changes>`;
}
