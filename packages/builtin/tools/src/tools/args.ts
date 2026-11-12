/**
 * `grep`、`glob` 的参数别名：模型会给同一个参数换名字（schema 写的是 `pattern`，它传 `query`）。
 * 宿主在执行前换成规范名（`ToolDefinition.aliases`），工具只读规范名。
 */
export const SEARCH_ALIASES = { pattern: ["query", "search"], path: ["dir", "cwd"] } as const;
