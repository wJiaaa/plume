/**
 * 导出会话成 Markdown 时每个工具的一次调用写成的那一行（`ToolDefinition.describe`）。本体不认工具名，说法跟着工具定义走。
 *
 * 参数是模型给的、没校验过：模型偶尔把路径写在 `file`、`filePath`，把式子写在 `query`、`search` 上，这里一并认。
 */

type Args = Record<string, unknown>;

const str = (args: Args, ...keys: string[]) => keys.map((key) => args[key]).find((value): value is string => typeof value === "string");
const pathOf = (args: Args) => str(args, "path", "file", "filePath");
const termOf = (args: Args) => str(args, "pattern", "query", "search");

// i18n-exempt：导出是英文的。
export const describeRead = (args: Args) => (pathOf(args) ? `Read ${pathOf(args)}` : "Read file");
export const describeWrite = (args: Args) => (pathOf(args) ? `Write ${pathOf(args)}` : "Write file");
export const describeEdit = (args: Args) => (pathOf(args) ? `Edit ${pathOf(args)}` : "Edit file");
export const describeLs = (args: Args) => `List ${str(args, "path", "dir", "cwd") ?? "."}`;
export const describeGlob = (args: Args) => (termOf(args) ? `Find ${termOf(args)}` : "Find files");
export const describeGrep = (args: Args) => (termOf(args) ? `Search "${termOf(args)}"` : "Search");
/** 跑命令（bash、monitor）：模型写的说明，没有就是命令的第一行。 */
export const describeCommand = (args: Args) =>
	(str(args, "description") ?? (str(args, "command") ?? "bash").split("\n")[0]!.slice(0, 80)) || "Run bash command";
export const describeJobRead = (args: Args) => (args.kill === true ? "Stop job" : "Check job");
