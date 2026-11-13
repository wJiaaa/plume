/**
 * 已经被后来的观察顶替掉的工具结果，清成一句话。
 *
 * 按大小剪是因为结果大；这里剪是因为它「死了」：同一个文件又读了一遍、文件被改了、同一个工具用同样的参数又跑了一次。后来的那份是现在的
 * 观察，早的那份是一张模型不会再要的快照（要的话 `recall`）。
 *
 * 只在压缩里做：压缩本来就要重写前缀，会话中途改写已经发出去的内容，为省几百字让整段缓存作废不划算。清空不删：没有结果的调用会让之后的
 * 每个请求都被拒。
 */

import { isAbsolute, posix, relative, sep } from "node:path";
import type { FileViewDetails, Message, ToolResultMessage } from "@plume/contract";
import { isCut, PRUNE_FLOOR_CHARS, PRUNE_THRESHOLD_CHARS } from "./prune.ts";

interface StaleCut {
	index: number;
	notice: string;
}

function staleCuts(messages: Message[], cwd: string): StaleCut[] {
	const calls = callsById(messages);
	const latestReads = new Map<string, Window[]>();
	const mutated = new Set<string>();
	const seenExact = new Set<string>();
	const cuts: StaleCut[] = [];

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as Message;
		if (message.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		// 要照着做的说明（技能正文，`ToolOutput.instructions`）不是观察，不会被顶替。
		if (!call || message.instructions) continue;

		/*
		 * 读了哪个文件的哪一块，只认结果里的通用声明（`FileViewDetails`），改了哪些文件只认本体记在结果上的（`ToolResultMessage.changes`），
		 * 都不认是哪个工具、参数叫什么：别的插件的工具参数和 `details` 另是一个样子，照猜就会错认；命令改的文件在参数里根本看不出来。
		 * 没带声明的读不当作读，只照下面的「同样的调用」处理。
		 */
		const view = message.isError ? undefined : fileViewOf(message.details);
		const key = view ? pathKey(view.path) : "";
		const fingerprint = `${call.name} ${stable(call.arguments)}`;
		/*
		 * 一次读盖住的是它返回的那些，不是它要的那些：不带范围读一个长源文件，返回的可能是只有大纲的版本；宽的窗口也可能停在输出上限上。
		 * 所以只认声明说原样给出的那一块（`verbatim`）。也只认原样发出去的结果：剪过头尾的那份，声明说的范围还是剪之前的，
		 * 信它的话两次读的中段都没了。
		 */
		const returned = view?.verbatim && goesOutWhole(message) ? windowOf(view) : undefined;
		const duplicate = seenExact.has(fingerprint);
		const superseded = view !== undefined && (mutated.has(key) || coversAny(latestReads.get(key), windowOf(view)));

		if (duplicate || superseded) {
			const notice = superseded ? supersededNotice(shownPath(cwd, view.path)) : duplicateNotice(call.name);
			const size = textChars(message);
			if (size > Math.max(PRUNE_FLOOR_CHARS, notice.length)) cuts.push({ index, notice });
		}

		/*
		 * 失败、被取消的调用什么也没观察到，不能顶替更早的那次。不只是读：重复的 edit 失败往往正是因为第一次已经改上了，清掉那次成功只剩
		 * 失败，模型就以为改动从没落地。
		 */
		if (!message.isError) seenExact.add(fingerprint);
		// 出了错的结果上记着改动，也是真改了：两边的路径都是解析好的绝对路径（`FileChanges.paths`、`FileViewDetails.path`），比全等。
		for (const path of message.changes?.paths ?? []) mutated.add(pathKey(path));
		if (key && returned) {
			const list = latestReads.get(key) ?? [];
			list.push(returned);
			latestReads.set(key, list);
		}
	}

	return cuts;
}

/** `cwd`：告诉模型清掉的是哪个文件时，它里面的写成相对路径。 */
export function dropStaleResults(messages: Message[], cwd: string): Message[] {
	const cuts = staleCuts(messages, cwd);
	if (cuts.length === 0) return messages;
	const byIndex = new Map(cuts.map((cut) => [cut.index, cut.notice]));
	return messages.map((message, index) => {
		const notice = byIndex.get(index);
		if (!notice || message.role !== "toolResult") return message;
		return { ...message, content: [{ type: "text" as const, text: notice }] } satisfies ToolResultMessage;
	});
}

function callsById(messages: Message[]): Map<string, { name: string; arguments: Record<string, unknown> }> {
	const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			calls.set(part.id, { name: part.name, arguments: part.arguments ?? {} });
		}
	}
	return calls;
}

interface Window {
	from: number;
	/** 读到了最后一行时是 `Infinity`。 */
	to: number;
	charFrom: number;
	charTo: number;
}

type FileView = FileViewDetails["fileView"];

/** 结果里的 `fileView` 声明；形状不对的当没有：凭猜清掉更早的一次读，丢的是模型看过的字，留着只多几个字。 */
function fileViewOf(details: unknown): FileView | undefined {
	const view = (details as Partial<FileViewDetails> | undefined)?.fileView as { [K in keyof FileView]?: unknown } | undefined;
	if (!view || typeof view.path !== "string" || !view.path || typeof view.verbatim !== "boolean") return undefined;
	const lines = spanOf(view.lines);
	const columns = spanOf(view.columns);
	if (lines === null || columns === null) return undefined;
	return { path: view.path, verbatim: view.verbatim, ...(lines ? { lines } : {}), ...(columns ? { columns } : {}) };
}

/** 没给是 undefined（从头到尾、整行），给了却认不出是 null。 */
function spanOf(value: unknown): { from: number; to: number } | undefined | null {
	if (value === undefined) return undefined;
	const span = value as { from?: unknown; to?: unknown } | null;
	const from = numberOf(span?.from);
	const to = numberOf(span?.to);
	return from === undefined || to === undefined ? null : { from, to };
}

/** 声明说的那一块。用在被盖住的那一边时，它是那次读最多看到的；用在盖住别人的那一边时，只取原样给出的。 */
function windowOf(view: FileView): Window {
	return {
		from: view.lines?.from ?? 1,
		to: view.lines?.to ?? Number.POSITIVE_INFINITY,
		charFrom: view.columns?.from ?? 1,
		charTo: view.columns?.to ?? Number.POSITIVE_INFINITY,
	};
}

/**
 * 这条结果现在和以后发给模型的是不是它回来时的样子。剪过的（这次压缩里剪的、宿主记着的视图）已经改写过；超过剪枝线的，同一次压缩里
 * 接下来会被剪成头尾，那时它顶替掉的更早那次读就成了中段的唯一一份。
 */
function goesOutWhole(message: ToolResultMessage): boolean {
	if (isCut(message)) return false;
	return textChars(message, true) <= PRUNE_THRESHOLD_CHARS;
}

function coversAny(laters: Window[] | undefined, earlier: Window): boolean {
	if (!laters) return false;
	return laters.some((later) => later.from <= earlier.from && later.to >= earlier.to && later.charFrom <= earlier.charFrom && later.charTo >= earlier.charTo);
}

/** 告诉模型是哪个文件：工作目录里的写成相对路径，和读文件结果的头部一样短。 */
export function shownPath(cwd: string, path: string): string {
	const inside = relative(cwd, path);
	return inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? inside : path;
}

function pathKey(path: string): string {
	return posix.normalize(path.replace(/\\/g, "/")).replace(/\/+$/, "");
}

function stable(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${k}:${stable(v)}`).join(",")}}`;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textChars(message: ToolResultMessage, points = false): number {
	return message.content.reduce((sum, block) => sum + (block.type === "text" ? (points ? [...block.text].length : block.text.length) : 0), 0);
}

function supersededNotice(path: string): string {
	return `[Earlier read of \`${path}\` superseded by a later observation. The latest read, or the edit that replaced it, is below. Full text stays in the session — recall or read again if you need that snapshot.]`;
}

function duplicateNotice(tool: string): string {
	return `[Duplicate ${tool} result omitted; a later call used the same arguments. Full text stays in the session.]`;
}
