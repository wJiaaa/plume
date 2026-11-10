/**
 * 命令面板的排序：打进去的字和每一条的名字、别名比，比出一个分数。
 *
 * 分档而不是模糊匹配：名字整个对上 > 名字开头对上 > 别名整个对上 > 名字里有 > 别名里有 > 拆开的
 * 每个词都能在某处找到。档内保持给进来的顺序，所以调用方排好的「常用在前」不会被打乱。
 */

export interface PaletteEntry {
	label: string;
	/** 不显示、只用来被搜到的说法：「暗色」找到「深色」，「git」找到「Git」面板。 */
	keywords?: readonly string[];
}

const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/** 不匹配返回 null。空查询人人 0 分，等于原样保留。 */
export function scoreEntry(entry: PaletteEntry, query: string): number | null {
	const needle = normalize(query);
	if (!needle) return 0;
	const label = normalize(entry.label);
	const keywords = (entry.keywords ?? []).map(normalize);
	if (label === needle) return 140;
	if (label.startsWith(needle)) return 120;
	if (keywords.includes(needle)) return 110;
	if (label.includes(needle)) return 100;
	if (keywords.some((keyword) => keyword.includes(needle))) return 90;
	const tokens = needle.split(" ");
	const fields = [label, ...keywords];
	if (tokens.length > 1 && tokens.every((token) => fields.some((field) => field.includes(token)))) return 60;
	return null;
}

/** 留下匹配的，按分数从高到低；同分的保持原来的先后。 */
export function rankEntries<T extends PaletteEntry>(entries: readonly T[], query: string): T[] {
	return entries
		.map((entry, index) => ({ entry, index, score: scoreEntry(entry, query) }))
		.filter((candidate): candidate is { entry: T; index: number; score: number } => candidate.score !== null)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((candidate) => candidate.entry);
}
