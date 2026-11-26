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

/** 已经告诉过主会话的一处改动：侧边聊天第 `at` 条（`timestamp` 那一刻写的工具结果）改了这几个文件。 */
export interface Told {
	at: number;
	timestamp: number;
	paths: readonly string[];
}

/** `fresh`（`messages` 里刚说过的那段）里记着改动的工具结果，按条记下位置、时刻和改了哪些文件，之后被截掉时认得出来。 */
export function toldIn(messages: readonly Message[], fresh: readonly Message[]): Told[] {
	const told: Told[] = [];
	for (const message of fresh) {
		if (message.role !== "toolResult" || !message.changes?.paths.length) continue;
		told.push({ at: messages.indexOf(message), timestamp: message.timestamp, paths: message.changes.paths });
	}
	return told;
}

/**
 * 说过的改动里被截掉的（编辑重问、撤回截掉了记着它的那条）：连文件一起撤回时那几个文件退回去了，主会话手里还是侧边聊天改过的样子，
 * 得再说一次。只撤了对话、文件没动的也算进来：从对话上认不出退没退，多说一次只是让主会话多读一遍。
 */
export function cutTold(told: readonly Told[], messages: readonly Message[]): { kept: Told[]; paths: string[] } {
	const kept = told.filter((entry) => messages[entry.at]?.timestamp === entry.timestamp);
	const paths = told.filter((entry) => !kept.includes(entry)).flatMap((entry) => entry.paths);
	return { kept, paths };
}

/** 主会话下一轮开头读到的那一句。 */
// i18n-exempt：发给模型的话。
export function sideChangesNote(paths: readonly string[]): string {
	return `<side-chat-changes>\nA side chat changed these files while you were not looking. Re-read any of them before relying on or editing it:\n${paths.map((path) => `- ${path}`).join("\n")}\n</side-chat-changes>`;
}
