/**
 * 两个版本哪个新。
 *
 * 自己写而不引一个库：这里要的只是排序，而排序出错是看不见的——按字符串比的应用认为 0.10.0 比 0.9.0 旧，之后再也不提示更新。
 * 预发布后缀排在它要变成的正式版前面：1.0.0-beta.2 不是 1.0.0，跑着 beta 的人才不会被告知没有更新的。
 */

interface Parsed {
	numbers: number[];
	/** `-` 后面按点分的标识，正式版是空的。 */
	pre: string[];
}

/** 认开头的 `v` 和末尾的构建信息，release 的 tag 里两种都会出现。 */
function parseVersion(raw: string): Parsed | null {
	const cleaned = raw.trim().replace(/^v/i, "").split("+")[0] ?? "";
	const [core, ...rest] = cleaned.split("-");
	if (!core) return null;
	const numbers = core.split(".").map((part) => Number(part));
	if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n < 0)) return null;
	const pre = rest.join("-");
	return { numbers, pre: pre ? pre.split(".") : [] };
}

/** −1、0 或 1，和比较函数的约定一样。 */
export function compareVersions(a: string, b: string): number {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return 0;

	const length = Math.max(left.numbers.length, right.numbers.length);
	for (let i = 0; i < length; i++) {
		// 缺的一段当 0：1.2 和 1.2.0 是同一个版本。
		const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}

	// 带预发布的比同样数字不带的早。
	if (left.pre.length === 0 && right.pre.length > 0) return 1;
	if (left.pre.length > 0 && right.pre.length === 0) return -1;

	const parts = Math.max(left.pre.length, right.pre.length);
	for (let i = 0; i < parts; i++) {
		const x = left.pre[i];
		const y = right.pre[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		// 纯数字的按数比，排在带字母的前面。
		const nx = /^\d+$/.test(x) ? Number(x) : null;
		const ny = /^\d+$/.test(y) ? Number(y) : null;
		if (nx !== null && ny !== null) return nx > ny ? 1 : -1;
		if (nx !== null) return -1;
		if (ny !== null) return 1;
		return x > y ? 1 : -1;
	}
	return 0;
}

/** `latest` 值不值得告诉跑着 `current` 的人。 */
export function isNewer(latest: string, current: string): boolean {
	return compareVersions(latest, current) > 0;
}
