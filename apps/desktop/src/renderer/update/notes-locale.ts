/**
 * 「更新内容」只显示一种语言。
 *
 * GitHub Release 正文里中英两种语言写在一起，分段标记是注释，在发布页上看不见。关于页和更新对话框不是发布页：
 * 界面是英文只出英文，是中文只出中文，中文段没写时退回英文。
 *
 *     <!-- plume:notes en -->
 *     ### New
 *     ...
 *     <!-- plume:notes zh-CN -->
 *     ### 新功能
 *     ...
 */

import type { ResolvedUiLocale } from "@plume/ui";

/** 行首的分段标记，语言码取 `ResolvedUiLocale`（`zh-CN`、`en`）。 */
const MARKER = /^[ \t]*<!--[ \t]*plume:notes[ \t]+([A-Za-z-]+)[ \t]*-->[ \t]*$/gm;

/** 正文切成「语言 → 那一段」。没有任何标记时返回空表，交给调用方原样处理。 */
function splitNotesByLocale(notes: string): Map<string, string> {
	const sections = new Map<string, string>();
	const normalized = notes.replace(/\r\n?/g, "\n");
	const marks = [...normalized.matchAll(MARKER)];
	for (const [index, mark] of marks.entries()) {
		const tag = mark[1];
		if (!tag) continue;
		const from = mark.index + mark[0].length;
		const to = marks[index + 1]?.index ?? normalized.length;
		const body = unwrapReleaseFold(normalized.slice(from, to).trim());
		// 同一个语言码写了两次是笔误，留先到的那段，至少是稳定的。
		if (body && !sections.has(tag)) sections.set(tag, body);
	}
	return sections;
}

/** GitHub 上非英文段可以收在 `<details>` 里；这里已经按语言挑过了，披露条是多余的壳。 */
function unwrapReleaseFold(body: string): string {
	let text = body.trim();
	const commented = /^<!--\s*([\s\S]*?)\s*-->$/.exec(text);
	if (commented?.[1]) text = commented[1].trim();
	text = text.replace(/^<details\b[^>]*>\s*<summary\b[^>]*>[\s\S]*?<\/summary>\s*/i, "");
	text = text.replace(/\s*<\/details>\s*$/i, "");
	return text.trim();
}

/** 关于页、更新对话框用的那一段。没有分段标记的整段返回；写了标记，就不再把几种语言一起交出去。 */
export function notesForLocale(notes: string, locale: ResolvedUiLocale): string {
	const trimmed = notes.replace(/\r\n?/g, "\n").trim();
	if (!trimmed) return "";

	const sections = splitNotesByLocale(trimmed);
	if (sections.size === 0) return trimmed;
	return sections.get(locale) ?? sections.get("en") ?? sections.values().next().value ?? "";
}
