/**
 * 文本文件在磁盘上的样子（有没有 BOM、CRLF 还是 LF），让文件工具在一种干净的形式上干活，写回时还原。
 *
 * Windows 上 git 默认 `core.autocrlf=true`，检出的文件几乎全是 CRLF，编辑器还爱加 UTF-8 BOM。
 * 按 `\n` 切会给模型每行末尾一个 `\r`；`edit` 找不到跨行的 `old_string`，还会把 BOM 连同第一行一起弄丢；
 * `write` 会把整个文件压成 LF。所以 read、edit、write 都经这里：匹配、替换、显示都在解码后的文本上
 * （没有 BOM、换行是 `\n`），只有写回磁盘的字节重新编码。
 *
 * 行数、读过的记录也都按解码后的文本算：read 和 edit 各算各的形式，工具自己的记录就会把编辑判成过期。
 */

export interface TextLayout {
	/** 文件以 UTF-8 BOM 开头。它不是第一行的一部分，单独记着。 */
	bom: boolean;
	/**
	 * 每个换行都是 `\r\n` 时是 `\r\n`；LF 文件或者没有换行的是 `\n`。
	 *
	 * 两种混着的是 `null`，进出都原样不动：往哪边转都会改写少数那种的每一行，而那些行没人编辑过。
	 */
	eol: "\n" | "\r\n" | null;
}

const BOM = "\uFEFF";
/** 不是 CRLF 开头的 `\r`，或者不是 CRLF 结尾的 `\n`。 */
const LONE_BREAK = /\r(?!\n)|(?<!\r)\n/;

export function decodeText(raw: string): { text: string; layout: TextLayout } {
	const bom = raw.startsWith(BOM);
	const body = bom ? raw.slice(1) : raw;
	const crlf = body.includes("\r\n");
	const eol = !crlf ? "\n" : LONE_BREAK.test(body) ? null : "\r\n";
	return { text: eol === "\r\n" ? body.replaceAll("\r\n", "\n") : body, layout: { bom, eol } };
}

/**
 * 解码后的文本还原成文件自己的形式。
 *
 * 用 `\r?\n` 而不是 `\n`：从别处混进来的 CRLF 不会变成 `\r\r\n`。
 */
export function encodeText(text: string, layout: TextLayout): string {
	const body = layout.eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
	return layout.bom ? BOM + body : body;
}

/**
 * 模型给的文字（`old_string`、整个文件）换成解码后的形式，才能和解码后的文件比较、一起重新编码。
 * 模型从哪里看到换行就照抄哪种，两种都得认。混合换行的文件按存着的样子逐字节比。
 */
export function decodeInput(text: string, layout: TextLayout): string {
	return layout.eol === null ? text : text.replaceAll("\r\n", "\n");
}
