/**
 * 一次还在写的调用，参数写到哪儿了。
 *
 * 写着的时候 `arguments` 还是空的，只有 `argumentsText` 在长。几百行的文件要生成十几秒，那段时间只有「创建文件」在扫光，
 * 看不出是在往前走还是卡住了，所以标题带上路径，行尾说写了几行。不整段解析：一个文件上万行，每来一段参数都要过一遍。
 * 只在写文件（`ToolLine.kind` 是 `create`）时用，不认参数名：路径从已经写完的短值里由插件的 `ToolLine.file` 取，行数数整段参数里的换行。
 */

/**
 * 已经写完的那几个字符串值，按键：路径一类不含转义的短值；还没写完的、带转义的不算。
 *
 * 前面不是 `\` 的 `"key"` 只可能是键：字符串里的引号都转义过，正文里的 `"key": "value"` 不会被当成参数。
 */
export function streamedStrings(raw: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const match of raw.matchAll(/(?<!\\)"([^"\\]+)"\s*:\s*"([^"\\]*)"/g)) values[match[1]!] ??= match[2]!;
	return values;
}

/** 已经写了几行：数转义过的换行。 */
export function streamedLines(raw: string): number {
	let lines = 0;
	for (let at = 0; at < raw.length; at++) {
		if (raw[at] !== "\\") continue;
		// 一个转义占两个字符：`\\n` 是反斜杠加字母 n，不是换行。
		if (raw[at + 1] === "n") lines++;
		at++;
	}
	return lines;
}
