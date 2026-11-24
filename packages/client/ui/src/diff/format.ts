/**
 * 多文件 diff 的纯计算：路径拆成目录和文件名、统计数缩写。不碰 DOM 和 React，单测在 `test/diff-format.test.ts`。
 */

/** 拆出目录和文件名（`/`、`\` 都认）；目录不带结尾的分隔符，未跟踪的整个目录（`a/untracked/`）文件名保留结尾的 `/`。 */
export function splitPath(path: string): { dir: string; name: string } {
	const cut = Math.max(path.lastIndexOf("/", path.length - 2), path.lastIndexOf("\\", path.length - 2));
	return { dir: cut < 0 ? "" : path.slice(0, cut), name: path.slice(cut + 1) };
}

/** 万以内写全，上万缩成 `12.3k`、`1.2m`，不把行尾撑歪。 */
export function formatStatCount(value: number): string {
	if (value < 10_000) return String(value);
	if (value < 999_500) {
		const k = value / 1000;
		return `${k < 100 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
	}
	const m = value / 1_000_000;
	return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`;
}
