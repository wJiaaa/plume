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

export function formatMatchWindowAt(text: string, matchAt: number, max = MAX_LINE_CHARS): string {
	if (text.length <= max) return text;
	return formatWindow(matchWindowAt(text, matchAt, max), text.length);
}

export function formatMatchWindow(text: string, pattern?: string, options?: MatchOptions, max = MAX_LINE_CHARS): string {
	if (text.length <= max) return text;
	return formatWindow(matchWindow(text, pattern, options, max), text.length);
}

/** `text` 里的 UTF-8 字节偏移换成字符串下标。 */
export function utf8ByteOffsetToIndex(text: string, bytes: number): number {
	if (bytes <= 0) return 0;
	const buf = Buffer.from(text, "utf8");
	if (bytes >= buf.length) return text.length;
	return buf.subarray(0, bytes).toString("utf8").length;
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

export function longLineFooter(entries: { line: number; length: number; shownFrom: number; shownTo: number }[]): string {
	if (entries.length === 0) return "";
	if (entries.length === 1) {
		const entry = entries[0]!;
		const next = entry.shownTo < entry.length ? `; call read again with char_offset=${entry.shownTo + 1} for more` : "";
		return `\n\n[line ${entry.line} is ${entry.length} characters; showing ${entry.shownFrom}-${entry.shownTo}${next}]`;
	}
	return `\n\n[${entries.length} lines exceed ${MAX_LINE_CHARS} characters; showing a ${MAX_LINE_CHARS}-character window. Continue a line with char_offset]`;
}
