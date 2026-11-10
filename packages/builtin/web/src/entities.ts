/**
 * HTML / XML 字符引用，一遍解完。
 *
 * 必须一遍：先解 `&amp;` 再解 `&lt;` 会把字面的 `&amp;lt;` 变成 `<`。具名实体只认常见的几个，数字引用全解。
 */
export function decodeEntities(text: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		ndash: "–",
		mdash: "—",
		hellip: "…",
		laquo: "«",
		raquo: "»",
		ldquo: "“",
		rdquo: "”",
		lsquo: "‘",
		rsquo: "’",
		middot: "·",
	};
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
		if (code[0] === "#") {
			const value = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
		}
		return named[code.toLowerCase()] ?? whole;
	});
}
