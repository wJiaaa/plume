/**
 * 一次还在写的调用，参数写到哪儿了。
 *
 * 写着的时候 `arguments` 还是空的，只有 `argumentsText` 在长。几百行的文件要生成十几秒，那段时间只有「创建文件」在扫光，
 * 看不出是在往前走还是卡住了，所以标题带上路径，行尾说写了几行。不整段解析：一个文件上万行，每来一段参数都要过一遍。
 */

/** 前面不是 `\` 的 `"key"` 只可能是键：字符串里的引号都转义过。 */
function valueStart(raw: string, key: string): number {
	const match = new RegExp(`(?<!\\\\)"${key}"\\s*:\\s*"`).exec(raw);
	return match ? match.index + match[0].length : -1;
}

/** 已经写完的一个字符串值；还没写完的不算。路径一类不含转义的短值用它。 */
export function streamedString(raw: string, key: string): string | undefined {
	const start = valueStart(raw, key);
	if (start < 0) return undefined;
	const end = raw.indexOf('"', start);
	const value = end < 0 ? "" : raw.slice(start, end);
	return end < 0 || value.includes("\\") ? undefined : value;
}

/** `key` 那个字符串值写完了几行：数转义过的换行。还没写到这个键时是 `undefined`。 */
export function streamedLines(raw: string, key: string): number | undefined {
	const start = valueStart(raw, key);
	if (start < 0) return undefined;
	let lines = 0;
	for (let at = start; at < raw.length; at++) {
		const char = raw[at];
		if (char === '"') break;
		if (char !== "\\") continue;
		// 一个转义占两个字符：`\\n` 是反斜杠加字母 n，不是换行。
		if (raw[at + 1] === "n") lines++;
		at++;
	}
	return lines;
}
