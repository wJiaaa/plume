/**
 * 侧边聊天改了文件，主会话下一轮开头知道一次：它对那几个文件的印象已经过时了，接着往下推之前该重读。
 * 防覆盖靠的不是这句话，是写文件工具的读取校验；这句话管的是主会话别拿着旧印象往下推。
 *
 * 读的是本体记在工具结果上的改动（`ToolResultMessage.changes`）而不是工具参数：命令里观测到的改动也算，而那些在参数里看不出来。
 * 出了错的结果也算：记下了就是真的改了。
 */

import type { Message } from "@plume/contract";

/** 这一段消息里工具结果上记着的改动的快照标识，不认是哪个工具交的。 */
export function changeIds(messages: readonly Message[]): string[] {
	const ids = new Set<string>();
	for (const message of messages) if (message.role === "toolResult") for (const id of message.changes?.ids ?? []) ids.add(id);
	return [...ids];
}

/** 主会话下一轮开头读到的那一句。 */
// i18n-exempt：发给模型的话。
export function sideChangesNote(paths: readonly string[]): string {
	return `<side-chat-changes>\nA side chat changed these files while you were not looking. Re-read any of them before relying on or editing it:\n${paths.map((path) => `- ${path}`).join("\n")}\n</side-chat-changes>`;
}
