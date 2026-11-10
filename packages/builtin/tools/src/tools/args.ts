/**
 * `keys` 里第一个是非空字符串的参数。
 *
 * 模型会给同一个参数换名字（schema 写的是 `pattern`，它传 `query`），工具认几个别名。
 */
export function textArg(args: unknown, keys: readonly string[]): string | undefined {
	const raw = args as Record<string, unknown>;
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

/** `grep`、`glob` 找什么、在哪里找。 */
export const PATTERN_KEYS = ["pattern", "query", "search"] as const;
export const ROOT_KEYS = ["path", "dir", "cwd"] as const;
