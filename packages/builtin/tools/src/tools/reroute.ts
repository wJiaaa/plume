/**
 * 把 `cat a.txt` 改道到 `read`，而不是在提示词里说第十遍。
 *
 * 提示词是建议，改道是保证：bash 的说明早就写着「用 read 别用 cat」，模型照样 `cat`，不是没读到，是 `cat` 更顺手。
 * 无歧义的 `cat`/`ls`/`rg` 由 bash 的外壳（`index.ts`）用 `translatedShellCommand` 当场改用 read、ls、grep 执行，结果末尾注明下次直接用哪个，
 * 钩子仍按 bash 跑；回一个错误再等一轮会白花一整个请求。其余匹配 `REROUTES` 的才在 bash 里拦下报错。
 *
 * 只拦纯粹的等价调用：`cat a.txt | wc -l` 在数行数，`cat a > b` 在复制，`cat a && echo done` 在组合，
 * 出现任何管道、重定向、串联，都说明这条命令有 read 给不了的东西，放行。
 *
 * 建议的工具必须在这个会话里可用：说「用 read」却没有 read，是把模型推向一扇不存在的门。
 */

export interface Reroute {
	/** 该用哪个工具。 */
	tool: string;
	/** 给模型看的那句话，它就是工具结果。 */
	message: string;
}

/** 按空白切词，引号里的算一个词（连引号）。 */
const WORDS = /\x22[^\x22]*\x22|\x27[^\x27]*\x27|[^\s\x22\x27]+/g;

/** 只翻译没有歧义的参数；shell 组合和不支持的旗标留给 bash。 */
export function translatedShellCommand(command: string): { name: string; args: Record<string, unknown> } | null {
	if (/[\n|<>;&\x60$*?{}[\]~\\]/.test(command)) return null;
	const words = command.trim().match(WORDS);
	if (!words || words.join(" ") !== command.trim().replace(/\s+/g, " ")) return null;
	const [name, ...args] = words.map((word) => (/^[\x22\x27]/.test(word) ? word.slice(1, -1) : word));
	if (name === "cat" && args.length === 1 && !args[0]!.startsWith("-")) return { name: "read", args: { path: args[0] } };
	if (name === "ls") {
		const all = args[0] === "-a" || args[0] === "-la" || args[0] === "-al";
		const rest = all || args[0] === "-l" ? args.slice(1) : args;
		if (rest.length <= 1 && !rest[0]?.startsWith("-")) return { name: "ls", args: { path: rest[0] ?? ".", all } };
	}
	if (name === "rg" || name === "grep") {
		const rest = args[0] === "-n" ? args.slice(1) : args;
		// 只认字面的词：grep 的基本正则、rg 和兜底的正则引擎对它们的理解一样。
		if (rest.length === 2 && /^[\w-]+$/.test(rest[0]!) && !rest[0]!.startsWith("-") && !rest[1]!.startsWith("-"))
			return { name: "grep", args: { pattern: rest[0], path: rest[1] } };
	}
	return null;
}

/**
 * find、fd 里 glob 也做得到的只有「在哪些目录下、按名字模式找文件」：起点目录、`-name`、`-type f`（fd 的模式、目录、
 * `-e`、`-t f`、`-g`）。别的条件和动作（`-delete`、`-exec`、`-size +1M`、`-mtime -1`、`-newer`、`-type d`、fd 的 `-x`、
 * `--changed-within`……）glob 给不了，叫模型去用 glob 是让它丢掉这些，放行。按白名单认，不按黑名单：find 的谓词太多。
 */
function globEquivalent(line: string): boolean {
	const [name, ...args] = (line.trim().match(WORDS) ?? []).map((word) => (/^[\x22\x27]/.test(word) ? word.slice(1, -1) : word));
	if (name === "find") {
		// 起点目录在前，第一个以 `-`、`(`、`!`、`\` 开头的词起是表达式。
		let at = 0;
		while (at < args.length && !/^[-(!\\]/.test(args[at]!)) at++;
		for (; at < args.length; at += 2) {
			const [flag, value] = [args[at], args[at + 1]];
			if (value === undefined) return false;
			if (flag === "-name" || (flag === "-type" && value === "f")) continue;
			return false;
		}
		return true;
	}
	let positional = 0;
	for (let at = 0; at < args.length; at++) {
		const word = args[at]!;
		if (!word.startsWith("-")) positional++;
		else if (word === "-g" || word === "--glob") continue;
		else if ((word === "-e" || word === "--extension") && args[at + 1] !== undefined) at++;
		else if ((word === "-t" || word === "--type") && (args[at + 1] === "f" || args[at + 1] === "file")) at++;
		else return false;
	}
	return positional <= 2;
}

/**
 * 命中一条就是等价调用；`[^|<>;&$]*$` 是「后面没有任何组合」。按命令名匹配行首，不试图解析 shell：
 * 这里要挡的只是最常见的那四五个字。
 */
// i18n-exempt：工具结果是发给模型的，不随界面语言变。
const REROUTES: { pattern: RegExp; only?: (line: string) => boolean; tool: string; message: string }[] = [
	{
		pattern: /^\s*(?:cat|head|tail)\s+[^|<>;&\x60$]+$/,
		tool: "read",
		message: "用 `read` 读文件——它带行号、有结构视图、大文件会给摘要，而且下一次 `edit` 会认得这份快照。`cat` 只在管道里用。",
	},
	{
		pattern: /^\s*(?:rg|grep|egrep|fgrep)\s+[^|<>;&\x60$]+$/,
		tool: "grep",
		message: "用 `grep` 工具搜——它不受 shell 引号转义的折磨，结果带文件名和行号，而且会跳过 node_modules。",
	},
	{
		pattern: /^\s*(?:find|fd)\s+[^|<>;&\x60$]+$/,
		only: globEquivalent,
		tool: "glob",
		message: "用 `glob` 找文件——按模式匹配，结果是干净的路径列表。",
	},
	{
		pattern: /^\s*ls\s+[^|<>;&\x60$]+$/,
		tool: "ls",
		message: "用 `ls` 工具列目录——它会标出目录和文件，而且不会把颜色转义码带进结果。",
	},
];

/**
 * 这条命令该不该改道，null 就是照常跑。
 *
 * `available` 是 undefined 时一律放行：不知道有没有 read 的情况下让模型去用 read，比让它 `cat` 更糟。
 */
export function rerouteShellCommand(command: string, available: ReadonlySet<string> | undefined): Reroute | null {
	if (!available) return null;
	// 多行命令是脚本，不是「一次 cat」。
	const first = command.split("\n")[0] ?? "";
	if (
		command.includes("\n") &&
		command
			.trim()
			.split("\n")
			.filter((line) => line.trim()).length > 1
	)
		return null;
	for (const { pattern, only, tool, message } of REROUTES) {
		if (!pattern.test(first) || (only && !only(first))) continue;
		if (!available.has(tool)) return null;
		return { tool, message };
	}
	return null;
}
