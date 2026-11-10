import { parseMarkdownChunks } from "./blocks.ts";

/** 只转换完整围栏，其余原文及块间空行保留。 */
export function copyReply(text: string, transform: (language: string, code: string) => string | undefined): string {
	let cursor = 0;
	let result = "";
	for (const { block, raw } of parseMarkdownChunks(text)) {
		const at = text.indexOf(raw, cursor);
		if (at < 0) return text;
		result += text.slice(cursor, at);
		let shown: string | undefined;
		if (block.kind === "code" && !block.open) {
			try {
				shown = transform(block.lang, block.code);
			} catch {
				/* 插件失败不影响复制原文。 */
			}
		}
		result += shown === undefined ? raw : shown + raw.slice(raw.trimEnd().length);
		cursor = at + raw.length;
	}
	return result + text.slice(cursor);
}
