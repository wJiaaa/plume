/**
 * 超出上限的长行，按窗口给，每段省略的都有地址。
 *
 * 一行两千字是成本上的门槛。以前把「前两千字」当成了整行：一行长的目录里第八万字的命中，报了命中却看不见。
 * 上限照旧，被省略的每一段都带地址（`char_offset`），下一次调用能打开它。
 */

export const MAX_LINE_CHARS = 2000;

export interface CharWindow {
	/** 在原文里的起点，从 0 数，含。 */
	start: number;
	/** 终点，从 0 数，不含。 */
	end: number;
	text: string;
}

export interface MatchOptions {
	literal?: boolean;
	ignoreCase?: boolean;
}

/** 从 `start` 起最多 `max` 个 UTF-16 单元，不切开代理对。 */
export function charWindow(text: string, start = 0, max = MAX_LINE_CHARS): CharWindow {
	let from = Math.max(0, Math.min(start, text.length));
	let to = Math.min(text.length, from + max);
	let slice = text.slice(from, to);
	if (from > 0 && /^[\uDC00-\uDFFF]/.test(slice)) {
		slice = slice.slice(1);
		from += 1;
	}
	if (/[\uD800-\uDBFF]$/.test(slice)) {
		slice = slice.slice(0, -1);
		to -= 1;
	}
	return { start: from, end: to, text: slice };
}

/**
 * 命中处附近的窗口，而不是行首。
 *
 * 三分之一的额度放在命中之前：模型看得到一点左边的上下文（名字旁边的 id），又不至于全花在那里。
 */
function matchWindowAt(text: string, matchAt: number, max = MAX_LINE_CHARS): CharWindow {
	let start = 0;
	if (matchAt > 0) start = matchAt - Math.min(matchAt, Math.floor(max / 3));
	if (start + max > text.length) start = Math.max(0, text.length - max);
	return charWindow(text, start, max);
}

export function matchWindow(text: string, pattern?: string, options?: MatchOptions, max = MAX_LINE_CHARS): CharWindow {
	return matchWindowAt(text, matchIndex(text, pattern, options), max);
}

function formatWindow(window: CharWindow, length: number): string {
	const head = window.start > 0 ? `… [${window.start} characters omitted] ` : "";
	const tail = window.end < length ? ` … [${length - window.end} characters omitted; continue with char_offset=${window.end + 1}]` : "";
	return `${head}${window.text}${tail}`;
}

export function formatCharWindow(text: string, start = 0, max = MAX_LINE_CHARS): string {
	if (text.length <= max && start <= 0) return text;
	return formatWindow(charWindow(text, start, max), text.length);
}

/** 一行里命中散在各处时，每处给多宽：两千字的窗口只罩得住一处，几十处命中要的是每处附近的一小段。 */
const HIT_WINDOW_CHARS = 400;
/** 一行最多给几处：再多就该收窄模式了，也免得一行就占满 grep 的输出上限。 */
const MAX_HIT_WINDOWS = 12;

/**
 * 长行里每处命中的窗口，按位置排好，一处一段。
 *
 * 压缩过的 JS 整个文件是一行：只给第一处的窗口，同一行里后面几十处命中就看不见，模型只能自己写脚本去找位置。
 * 所有命中落在一个常规窗口里时照旧给一个；否则每处给一个窄窗口，各自带着地址（省略了多少字、从哪里接着读）。
 */
export function formatMatchWindowsAt(text: string, starts: readonly number[]): string[] {
	const sorted = [...new Set(starts)].sort((a, b) => a - b);
	if (text.length <= MAX_LINE_CHARS) return [text];
	const wide = matchWindowAt(text, sorted[0] ?? 0);
	if (sorted.every((at) => at >= wide.start && at < wide.end)) return [formatWindow(wide, text.length)];

	const windows: CharWindow[] = [];
	let hidden = 0;
	for (const at of sorted) {
		const last = windows[windows.length - 1];
		if (last && at < last.end) continue;
		if (windows.length === MAX_HIT_WINDOWS) {
			hidden++;
			continue;
		}
		// 不和上一段重叠：重叠的那几个字已经给过了。
		const start = Math.max(last?.end ?? 0, at - Math.floor(HIT_WINDOW_CHARS / 3));
		windows.push(charWindow(text, start, HIT_WINDOW_CHARS));
	}
	const shown = windows.map((window) => formatWindow(window, text.length));
	if (hidden > 0) shown[shown.length - 1] += ` [${hidden} more match${hidden === 1 ? "" : "es"} on this line not shown; narrow the pattern]`;
	return shown;
}

export function formatMatchWindow(text: string, pattern?: string, options?: MatchOptions, max = MAX_LINE_CHARS): string {
	if (text.length <= max) return text;
	return formatWindow(matchWindow(text, pattern, options, max), text.length);
}

/** 同一行的一串 UTF-8 字节偏移换成字符串下标，按偏移从小到大一段段解码，不为每个偏移把整行重新编码一遍。 */
export function utf8ByteOffsetsToIndices(text: string, bytes: readonly number[]): number[] {
	const buf = Buffer.from(text, "utf8");
	const order = bytes.map((_, index) => index).sort((a, b) => bytes[a]! - bytes[b]!);
	const out = Array.from<number>({ length: bytes.length });
	let byte = 0;
	let index = 0;
	for (const at of order) {
		const target = Math.max(0, Math.min(buf.length, bytes[at]!));
		if (target > byte) {
			index += buf.subarray(byte, target).toString("utf8").length;
			byte = target;
		}
		out[at] = index;
	}
	return out;
}

function matchIndex(text: string, pattern: string | undefined, options?: MatchOptions): number {
	if (!pattern) return 0;
	if (options?.literal) {
		const at = options.ignoreCase ? text.toLowerCase().indexOf(pattern.toLowerCase()) : text.indexOf(pattern);
		return at >= 0 ? at : 0;
	}
	try {
		const found = new RegExp(pattern, options?.ignoreCase ? "i" : "").exec(text);
		return found ? found.index : 0;
	} catch {
		const at = text.indexOf(pattern);
		return at >= 0 ? at : 0;
	}
}

export function longLineFooter(entries: { line: number; length: number; shownFrom: number; shownTo: number }[], width = MAX_LINE_CHARS): string {
	if (entries.length === 0) return "";
	if (entries.length === 1) {
		const entry = entries[0]!;
		const next = entry.shownTo < entry.length ? `; call read again with char_offset=${entry.shownTo + 1} for more` : "";
		return `\n\n[line ${entry.line} is ${entry.length} characters; showing ${entry.shownFrom}-${entry.shownTo}${next}]`;
	}
	return `\n\n[${entries.length} lines exceed ${width} characters; showing a ${width}-character window. Continue a line with char_offset]`;
}
