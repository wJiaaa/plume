/**
 * 已经被后来的观察顶替掉的工具结果，清成一句话。
 *
 * 按大小剪是因为结果大；这里剪是因为它「死了」：同一个文件又读了一遍、文件被改了、同一个工具用同样的参数又跑了一次。后来的那份是现在的
 * 观察，早的那份是一张模型不会再要的快照（要的话 `recall`）。
 *
 * 只在压缩里做：压缩本来就要重写前缀，会话中途改写已经发出去的内容，为省几百字让整段缓存作废不划算。清空不删：没有结果的调用会让之后的
 * 每个请求都被拒。
 */

import { homedir, tmpdir } from "node:os";
import { isAbsolute, posix, resolve } from "node:path";
import type { Message, ToolResultMessage } from "@plume/contract";
import type { KindOf } from "./head.ts";
import { isCut, PRUNE_FLOOR_CHARS, PRUNE_THRESHOLD_CHARS } from "./prune.ts";

/** read 对一行最多给多少字（超过的给一个窗口，用 `char_offset` 接着读），和 plume.tools 的 read 一致。 */
const MAX_LINE_CHARS = 2000;

interface StaleCut {
	index: number;
	notice: string;
}

function staleCuts(messages: Message[], cwd: string, kindOf: KindOf): StaleCut[] {
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

		const path = pathOf(call.arguments);
		const key = path ? resolvedKey(cwd, path) : "";
		const fingerprint = `${call.name} ${stable(call.arguments)}`;
		const kind = kindOf(call.name);
		const isRead = kind === "view";
		/*
		 * 一次读盖住的是它返回的那些，不是它要的那些：不带范围读一个长源文件，返回的可能是只有大纲的版本；宽的窗口也可能停在输出上限上。
		 * 按参数判断会清掉模型读过、之后再没见过的正文。也只认原样发出去的结果：剪过头尾的那份，`details` 说的范围还是剪之前的，
		 * 信它的话两次读的中段都没了。
		 */
		const returned = isRead && !message.isError && goesOutWhole(message) ? returnedWindow(message.details, call.arguments) : undefined;
		const duplicate = seenExact.has(fingerprint);
		const superseded =
			!message.isError && isRead && key !== "" && (mutated.has(key) || coversAny(latestReads.get(key), returned ?? askedWindow(call.arguments)));

		if (duplicate || superseded) {
			const notice = superseded ? supersededNotice(path) : duplicateNotice(call.name);
			const size = textChars(message);
			if (size > Math.max(PRUNE_FLOOR_CHARS, notice.length)) cuts.push({ index, notice });
		}

		/*
		 * 失败、被取消的调用什么也没观察到，不能顶替更早的那次。不只是读：重复的 edit 失败往往正是因为第一次已经改上了，清掉那次成功只剩
		 * 失败，模型就以为改动从没落地。
		 */
		if (!message.isError) seenExact.add(fingerprint);
		if (key && (kind === "create" || kind === "modify") && !message.isError) mutated.add(key);
		if (key && returned) {
			const list = latestReads.get(key) ?? [];
			list.push(returned);
			latestReads.set(key, list);
		}
	}

	return cuts;
}

/** `cwd`：工具调用里的相对路径按它解析。`kindOf`：哪个工具是读文件、写改文件的。 */
export function dropStaleResults(messages: Message[], cwd: string, kindOf: KindOf): Message[] {
	const cuts = staleCuts(messages, cwd, kindOf);
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

const WHOLE: Window = { from: 1, to: Number.POSITIVE_INFINITY, charFrom: 1, charTo: Number.POSITIVE_INFINITY };

/**
 * read 的结果凭 `details` 能证明原样返回了哪一段。证明不了（大纲、截断的文档、资源地址、没有 details 的结果）就是 undefined：
 * 凭猜清掉更早的一次读，丢的是模型看过的字；留着只多几个字。
 */
function returnedWindow(details: unknown, args: Record<string, unknown>): Window | undefined {
	if (!details || typeof details !== "object") return undefined;
	const d = details as Record<string, unknown>;
	if (d.kind === "image" || (d.kind === "document" && d.truncated === false)) return WHOLE;
	if (d.kind !== "text" || d.outlined === true) return undefined;
	const from = numberOf(d.shownFrom);
	const to = numberOf(d.shownTo);
	const total = numberOf(d.totalLines);
	if (from === undefined || to === undefined) return undefined;
	return { from, to: from <= 1 && total !== undefined && to >= total ? Number.POSITIVE_INFINITY : to, ...charSpan(args) };
}

/**
 * 这条结果现在和以后发给模型的是不是它回来时的样子。剪过的（这次压缩里剪的、宿主记着的视图）已经改写过；超过剪枝线的，同一次压缩里
 * 接下来会被剪成头尾，那时它顶替掉的更早那次读就成了中段的唯一一份。
 */
function goesOutWhole(message: ToolResultMessage): boolean {
	if (isCut(message)) return false;
	return textChars(message, true) <= PRUNE_THRESHOLD_CHARS;
}

/** 更早的一次读最多看到了什么：它要的那些。只用在被盖住的那一边。 */
function askedWindow(args: Record<string, unknown>): Window {
	const offset = numberOf(args.offset);
	const limit = numberOf(args.limit);
	const from = offset ?? 1;
	return { from, to: limit === undefined ? Number.POSITIVE_INFINITY : from + limit - 1, ...charSpan(args) };
}

// read 对选中的每一行用同一个字符窗口；从第 1 个字符起的短行都在窗口里。
function charSpan(args: Record<string, unknown>): Pick<Window, "charFrom" | "charTo"> {
	const charFrom = Math.max(1, numberOf(args.char_offset) ?? numberOf(args.charOffset) ?? 1);
	return { charFrom, charTo: charFrom + MAX_LINE_CHARS - 1 };
}

function coversAny(laters: Window[] | undefined, earlier: Window): boolean {
	if (!laters) return false;
	return laters.some((later) => later.from <= earlier.from && later.to >= earlier.to && later.charFrom <= earlier.charFrom && later.charTo >= earlier.charTo);
}

function pathOf(args: Record<string, unknown>): string {
	for (const key of ["path", "file", "filePath", "file_path"] as const) {
		const value = args[key];
		if (typeof value === "string" && value) return value;
	}
	return "";
}

function pathKey(path: string): string {
	return posix.normalize(path.replace(/\\/g, "/")).replace(/\/+$/, "");
}

/**
 * 路径照工具自己的解析办法（`~/` 展开、Windows 上 shell 的写法、相对路径按工作目录）变成绝对路径，之后只认全等：
 * `package.json` 和 `apps/cli/package.json` 是两个文件；绝对路径恰好以某个相对路径结尾、却不在 cwd 下的，也是两个文件。
 */
function resolvedKey(cwd: string, path: string): string {
	const native = process.platform === "win32" ? windowsSpelling(path) : path;
	const expanded = native === "~" || native.startsWith("~/") ? native.replace("~", homedir()) : native;
	return pathKey(isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded));
}

/**
 * Windows 上 shell 写的路径，换成它指的那个 Windows 路径：Git Bash 的 `/c/…`（`/cygdrive/c/…`）是 C 盘，`/tmp` 是用户的
 * 临时目录，`~\` 是 PowerShell 写的家目录。Node 把前两种读成 `C:\c\…`、`C:\tmp`，同一个文件换种写法再读就认不出是同一个。
 * 和 plume.tools 解析路径的写法一致。
 */
function windowsSpelling(path: string): string {
	const drive = /^(?:\/cygdrive)?\/([a-zA-Z])(?=\/|$)(.*)$/.exec(path);
	if (drive) return `${drive[1]!.toUpperCase()}:\\${drive[2]!.replace(/^[/]/, "").replaceAll("/", "\\")}`;
	const temp = /^\/tmp(?=\/|$)(.*)$/.exec(path);
	if (temp) return `${tmpdir()}${temp[1]!.replaceAll("/", "\\")}`;
	if (path === "~" || path.startsWith("~\\")) return `${homedir()}${path.slice(1)}`;
	return path;
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
