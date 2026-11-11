import type { FileChangesService, FileChangesSummary, Locale, Message, RevertPlan } from "@plume/contract";
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

export function recordedChanges(messages: readonly Message[]): { ids: string[]; warnings: string[] } {
	const ids = new Set<string>();
	const warnings: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.details || typeof message.details !== "object") continue;
		const detail = message.details as Record<string, unknown>;
		if (Array.isArray(detail.changeIds)) for (const id of detail.changeIds) if (typeof id === "string") ids.add(id);
		if (!message.isError && typeof detail.changeId === "string") ids.add(detail.changeId);
		if (typeof detail.changeWarning === "string") warnings.push(detail.changeWarning);
	}
	return { ids: [...ids], warnings };
}

/**
 * 撤回、编辑重发截掉的那段改过的文件（钩子 session.rewind）：只演算，或者真的退回到截断点之前。
 *
 * 全有或全无：有改动没记下来（命令影响的文件太多没记全、快照读不出来），或者一个文件不能安全退回（来自命令、中途被别处改过、
 * 不在项目内、之后被人或别的会话改过），就一个文件都不写。只退回一部分，代码停在一个从没存在过的中间状态，比不退更糟；
 * 被别人改过的文件不覆盖、不合并，留给人。截掉的那段里新建的文件退回时删掉。
 */
export async function rewindFiles(
	service: FileChangesService,
	sessionId: string,
	cwd: string,
	messages: readonly Message[],
	restore: boolean,
	locale: Locale,
): Promise<RevertPlan> {
	const { ids, warnings } = recordedChanges(messages);
	const summary = ids.length ? await service.collect(sessionId, cwd, ids) : { files: [], warnings: [] };
	// 不能退回又说不出是哪一类的（快照读不出来），也算没记全。
	const unrecorded = warnings.length > 0 || summary.warnings.length > 0 || summary.files.some((file) => !file.canUndo && !file.undoProblem);
	const files = summary.files.map((file) => ({
		path: file.path,
		added: file.added,
		removed: file.removed,
		problem: file.canUndo ? null : (file.undoProblem ?? null),
	}));
	if (!restore) return { files, unrecorded };
	if (unrecorded) throw new Error(MESSAGES[locale].unrecorded);
	// 不拿刚才演算的结论直接写：服务写之前按快照把每个文件再查一遍，有一个不对就都不写，写到一半失败把写了的退回去。
	if (files.length) await service.undo(sessionId, cwd, ids);
	return { files, unrecorded };
}

export async function collectDelivery(
	service: FileChangesService,
	sessionId: string,
	cwd: string,
	messages: readonly Message[],
	locale: Locale,
): Promise<FileChangesSummary> {
	const { ids, warnings } = recordedChanges(messages);
	const value: FileChangesSummary = { files: [], warnings };
	try {
		const summary = await service.collect(sessionId, cwd, ids);
		value.files = summary.files;
		value.warnings.push(...summary.warnings);
	} catch (error) {
		value.warnings.push(MESSAGES[locale].collectFailed(String(error)));
	}
	return value;
}
