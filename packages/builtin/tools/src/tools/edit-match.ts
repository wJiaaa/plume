/**
 * `old_string` 和文件对不上字节时，它到底指的是哪一段。
 *
 * 先认原文；再依次试模型抄错文字的常见方式：弯引号打成了直引号、留着 read 的行号前缀、把转义写了出来、
 * 行尾空格、缩进不同、中间某行记错。第一种找到东西的读法说了算：只有一种文字就是它，几种就算有歧义，
 * 不去猜。`replace_all` 跳过按行形状比的三种，它们松到会扫进模型没想改的文字。
 */

export type MatchStrategy =
	| "exact"
	| "quote_normalized"
	| "line_number_prefix_stripped"
	| "escape_normalized"
	| "unicode_escape_normalized"
	| "line_trimmed"
	| "indentation_flexible"
	| "block_anchor";

export type EditMatch = { status: "matched"; actual: string; strategy: MatchStrategy } | { status: "ambiguous"; count: number } | { status: "not_found" };

interface Candidate {
	value: string;
	index: number;
}

const FALLBACKS: MatchStrategy[] = [
	"quote_normalized",
	"line_number_prefix_stripped",
	"escape_normalized",
	"unicode_escape_normalized",
	"line_trimmed",
	"indentation_flexible",
	"block_anchor",
];
const BROAD = new Set<MatchStrategy>(["line_trimmed", "indentation_flexible", "block_anchor"]);
const BLOCK_ANCHOR_MIN_SIMILARITY = 0.8;
const LEFT_SINGLE = "‘";
const RIGHT_SINGLE = "’";
const LEFT_DOUBLE = "“";
const RIGHT_DOUBLE = "”";

export function findEditMatch(content: string, search: string, replaceAll: boolean): EditMatch {
	const exact = substringCandidates(content, search);
	if (exact.length > 0) return toMatch("exact", exact);
	for (const strategy of FALLBACKS) {
		if (replaceAll && BROAD.has(strategy)) continue;
		const candidates = collect(strategy, content, search);
		if (candidates.length > 0) return toMatch(strategy, candidates);
	}
	return { status: "not_found" };
}

/** 按找到匹配的方式改写 `new_string`：去掉转义、去掉行号前缀、换成文件里的引号。 */
export function replacementFor(strategy: MatchStrategy, search: string, actual: string, replacement: string): string {
	let result = replacement;
	if (strategy === "escape_normalized") result = unescapeVisible(result);
	// 把行号前缀抄进 `old_string` 的模型，`new_string` 里多半也写了；不去掉就会写进文件。
	if (strategy === "line_number_prefix_stripped") result = stripLineNumberPrefixes(result) ?? result;
	// 只有引号本身对不上时才换：别的读法下模型抄对了引号，文件里别处（比如中文注释）的弯引号不该改写代码里的直引号。
	if (strategy !== "quote_normalized" || search === actual) return result;
	if (actual.includes(LEFT_DOUBLE) || actual.includes(RIGHT_DOUBLE)) result = curlyDouble(result);
	if (actual.includes(LEFT_SINGLE) || actual.includes(RIGHT_SINGLE)) result = curlySingle(result);
	return result;
}

function toMatch(strategy: MatchStrategy, candidates: Candidate[]): EditMatch {
	const values = [...new Set(candidates.map((candidate) => candidate.value))];
	if (values.length !== 1) return { status: "ambiguous", count: candidates.length };
	return { status: "matched", actual: values[0]!, strategy };
}

function collect(strategy: MatchStrategy, content: string, search: string): Candidate[] {
	switch (strategy) {
		case "exact":
			return substringCandidates(content, search);
		case "quote_normalized":
			return normalizedCandidates(content, search, normalizeQuotes);
		case "line_number_prefix_stripped": {
			const stripped = stripLineNumberPrefixes(search);
			return stripped === null || stripped === search ? [] : substringCandidates(content, stripped);
		}
		case "escape_normalized": {
			const unescaped = unescapeVisible(search);
			return unescaped === search ? [] : substringCandidates(content, unescaped);
		}
		case "unicode_escape_normalized": {
			const unescaped = unescapeUnicode(search);
			return unescaped === search ? [] : substringCandidates(content, unescaped);
		}
		case "line_trimmed":
			return blockCandidates(content, search, 1, (block, lines) => block.every((line, i) => line.trim() === lines[i]!.trim()));
		case "indentation_flexible":
			return blockCandidates(content, search, 2, (block, lines) => removeCommonIndent(block) === removeCommonIndent(lines));
		case "block_anchor":
			return blockCandidates(
				content,
				search,
				3,
				(block, lines) =>
					block[0]!.trim() === lines[0]!.trim() &&
					block.at(-1)!.trim() === lines.at(-1)!.trim() &&
					middleSimilarity(block, lines) >= BLOCK_ANCHOR_MIN_SIMILARITY,
			);
	}
}

function substringCandidates(content: string, search: string): Candidate[] {
	if (search.length === 0) return [];
	const candidates: Candidate[] = [];
	for (let at = content.indexOf(search); at !== -1; at = content.indexOf(search, at + search.length)) {
		candidates.push({ value: search, index: at });
	}
	return candidates;
}

/** 这里的规整都是一个字符换一个字符，规整后文本里的下标就是文件里的下标。 */
function normalizedCandidates(content: string, search: string, normalize: (value: string) => string): Candidate[] {
	const haystack = normalize(content);
	const needle = normalize(search);
	return substringCandidates(haystack, needle).map(({ index }) => ({ value: content.slice(index, index + search.length), index }));
}

/**
 * 文件里的整行和 `old_string` 逐行比。
 *
 * `old_string` 末尾的换行留在匹配里：丢掉的话，这样匹配到的一块留着自己的换行，`new_string` 又带来一个，文件多出一个空行。
 */
function blockCandidates(content: string, search: string, minLines: number, same: (block: string[], lines: string[]) => boolean): Candidate[] {
	const fileLines = content.split("\n");
	const endsWithNewline = search.endsWith("\n");
	const lines = endsWithNewline ? search.slice(0, -1).split("\n") : search.split("\n");
	if (lines.length < minLines) return [];
	const candidates: Candidate[] = [];
	let offset = 0;
	for (let start = 0; start + lines.length <= fileLines.length; start++) {
		const block = fileLines.slice(start, start + lines.length);
		const followed = start + lines.length < fileLines.length;
		if (same(block, lines) && (!endsWithNewline || followed)) {
			candidates.push({ value: block.join("\n") + (endsWithNewline ? "\n" : ""), index: offset });
		}
		offset += fileLines[start]!.length + 1;
	}
	return candidates;
}

/** `  12→text`，read 和 edit 回显给行编号的样子；不是每行都有时返回 null。 */
function stripLineNumberPrefixes(text: string): string | null {
	const lines = text.split("\n").map((line) => /^ *\d+→(.*)$/.exec(line)?.[1] ?? null);
	return lines.every((line) => line !== null) ? lines.join("\n") : null;
}

function unescapeVisible(text: string): string {
	return text.replace(/\\([ntr"'`\\$])/g, (_, token: string) => (token === "n" ? "\n" : token === "t" ? "\t" : token === "r" ? "\r" : token));
}

function unescapeUnicode(text: string): string {
	return text.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (match, escapedBackslash: string | undefined, hex: string) =>
		escapedBackslash === undefined ? String.fromCharCode(Number.parseInt(hex, 16)) : match,
	);
}

function removeCommonIndent(lines: string[]): string {
	const filled = lines.filter((line) => line.trim().length > 0);
	if (filled.length === 0) return lines.join("\n");
	const indent = Math.min(...filled.map((line) => /^[\t ]*/.exec(line)![0].length));
	return lines.map((line) => (line.trim().length === 0 ? line : line.slice(indent))).join("\n");
}

function middleSimilarity(actual: string[], expected: string[]): number {
	if (actual.length <= 2) return 1;
	let total = 0;
	for (let i = 1; i < actual.length - 1; i++) total += similarity(actual[i]!.trim(), expected[i]!.trim());
	return total / (actual.length - 2);
}

function similarity(left: string, right: string): number {
	if (left === right) return 1;
	const longest = Math.max(left.length, right.length);
	return longest === 0 ? 1 : 1 - levenshtein(left, right) / longest;
}

function levenshtein(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[right.length]!;
}

function normalizeQuotes(text: string): string {
	return text.replaceAll(LEFT_SINGLE, "'").replaceAll(RIGHT_SINGLE, "'").replaceAll(LEFT_DOUBLE, '"').replaceAll(RIGHT_DOUBLE, '"');
}

function curlyDouble(text: string): string {
	return [...text].map((char, i, chars) => (char !== '"' ? char : opens(chars, i) ? LEFT_DOUBLE : RIGHT_DOUBLE)).join("");
}

function curlySingle(text: string): string {
	return [...text]
		.map((char, i, chars) => {
			if (char !== "'") return char;
			// 词中间的撇号（don’t、it’s 里那种）是右引号，不会是左引号。
			if (isLetter(chars[i - 1]) && isLetter(chars[i + 1])) return RIGHT_SINGLE;
			return opens(chars, i) ? LEFT_SINGLE : RIGHT_SINGLE;
		})
		.join("");
}

function opens(chars: string[], i: number): boolean {
	return i === 0 || [" ", "\t", "\n", "\r", "(", "[", "{", "—", "–"].includes(chars[i - 1]!);
}

function isLetter(char: string | undefined): boolean {
	return char !== undefined && /\p{L}/u.test(char);
}
