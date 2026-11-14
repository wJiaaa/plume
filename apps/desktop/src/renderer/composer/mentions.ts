/** 引用标记保留原文；文件统一加引号，空格、反斜线和引号都能往返。 */
export interface MentionCompletion {
	term: string;
	start: number;
	end: number;
}
export interface MentionItem {
	id: string;
	title: string;
	kind: "action" | "file" | "agent" | "plugin" | "session";
	description?: string;
	origin?: string;
	token?: string;
	avatar?: string;
	sessionId?: string;
}
export function parseMentionTrigger(text: string, start: number, end: number): MentionCompletion | null {
	if (start !== end) return null;
	const match = /(?:^|\s)@([^\s]*)$/.exec(text.slice(0, start));
	if (!match || match[1]!.startsWith('"') || match[1]!.startsWith("'")) return null;
	return { term: match[1]!, start: start - match[1]!.length - 1, end };
}
export function formatMention(path: string): string {
	return `@"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
export function findMentionRanges(text: string): Array<{ start: number; end: number; inner: string }> {
	const ranges: Array<{ start: number; end: number; inner: string }> = [];
	const regex = /(?:^|\s)(@(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|[^\s]+))/g;
	for (const match of text.matchAll(regex)) {
		const token = match[1]!;
		const start = match.index + match[0].length - token.length;
		ranges.push({ start, end: start + token.length, inner: match[2] !== undefined ? match[2].replace(/\\(["\\])/g, "$1") : (match[3] ?? token.slice(1)) });
	}
	return ranges;
}
export function rankMentions(term: string, items: MentionItem[]): MentionItem[] {
	const lower = term.trim().toLowerCase();
	return items.filter((item) => !lower || [item.title, item.description, item.id].some((field) => field?.toLowerCase().includes(lower)));
}
