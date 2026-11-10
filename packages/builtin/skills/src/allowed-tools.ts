/**
 * 读 frontmatter 的 `allowed-tools`：技能声明它只用这些工具，生效期间别的工具调不了（见逻辑入口的 tool.execute 层）。
 *
 * `.claude/skills` 原样读进来，那边三种写法都有：YAML 列表、空格分隔或逗号分隔的一串，名字是它自己的（`Read`、`WebFetch`），
 * 有时带权限范围（`Bash(git add *)`）。名字按现在登记着的工具对上；对不上的照写下的样子留着、报出来，不丢：
 * 空列表等于不限制，丢掉一个技能仅有的名字就把它要的限制整个去掉了；留着的名字谁也对不上，限制照样在。
 */

export interface AllowedToolsProblem {
	/**
	 * `notList`：既不是列表也不是字符串，整个忽略；`strays`：列表里不是字符串的项；`scoped`：括号里的范围不生效，按整个工具放行；
	 * `unmatched`：对不上任何工具，不放行任何调用；`serverWide`：指整个 MCP 服务，只认完整的工具名。
	 */
	kind: "notList" | "strays" | "scoped" | "unmatched" | "serverWide";
	/** 出问题的那几项，原样（截短过）。 */
	items: string[];
	/** `scoped`：按整个工具放行的那些工具名。 */
	widened?: string[];
}

export interface AllowedTools {
	/** 对上的工具名，去重、按写下的顺序。不限制时不给。 */
	tools?: string[];
	problems: AllowedToolsProblem[];
}

/** 大小写、`_`、`-` 在这里分不出两个工具：Claude Code 把我们的 `web_fetch` 写成 `WebFetch`。 */
const fold = (name: string): string => name.toLowerCase().replace(/[-_]/g, "");

/**
 * Claude Code 的工具在这里换了名字的，键是 `fold` 过的。目标工具登记着才算数（它来自插件，没装就对不上）。
 * 这边没有对应的（`NotebookEdit`、`Workflow`……）故意不写：报出来，而不是悄悄放行一个相近的。
 */
const RENAMED: [string, string][] = [
	// 它的子 Agent 工具，改名前叫 `Task`；`Task` 本身就能对上。
	["agent", "task"],
	["askuserquestion", "ask_user"],
	["multiedit", "edit"],
	// 读后台任务和停掉它，这边都是 `bash_output`。
	["taskoutput", "bash_output"],
	["taskstop", "bash_output"],
	["killshell", "bash_output"],
	["killbash", "bash_output"],
	// 它的任务清单是四个工具，这边是一个清单。
	["taskcreate", "todo_write"],
	["taskget", "todo_write"],
	["tasklist", "todo_write"],
	["taskupdate", "todo_write"],
];

/** `Bash(git add *)` → `Bash` 和 `git add *`。 */
const SCOPED = /^([^\s()]+)\((.*)\)$/s;

/** `known` 是现在登记着的全部工具名（`ctx.tools.names()`）。 */
export function readAllowedTools(value: unknown, known: readonly string[]): AllowedTools {
	if (value === undefined || value === null) return { problems: [] };
	if (typeof value !== "string" && !Array.isArray(value)) return { problems: [{ kind: "notList", items: [show(value)] }] };

	// 用 Map 不用对象字面量：`constructor` 也是有人会写的名字。
	const names = new Map(known.map((name) => [fold(name), name] as const));
	for (const [from, to] of RENAMED) if (known.includes(to) && !names.has(from)) names.set(from, to);

	const problems: AllowedToolsProblem[] = [];
	const items: unknown[] = typeof value === "string" ? [value] : value;
	const strays = items.filter((item) => typeof item !== "string");
	if (strays.length > 0) problems.push({ kind: "strays", items: strays.map(show) });

	const tools: string[] = [];
	const scoped: string[] = [];
	const widened: string[] = [];
	const unmatched: string[] = [];
	const serverWide: string[] = [];
	for (const entry of items.filter((item): item is string => typeof item === "string").flatMap(splitEntries)) {
		const match = SCOPED.exec(entry);
		const name = match?.[1] ?? entry;
		// MCP 工具在这里和 Claude Code 一样叫 `mcp__<服务>__<工具>`，大小写也是名字的一部分；服务可能还没连上，不按登记的查。
		const mcp = name.startsWith("mcp__");
		const tool = mcp ? name : (names.get(fold(name)) ?? name);
		add(tools, tool);
		if (mcp && namesWholeServer(name)) add(serverWide, clip(entry));
		else if (!mcp && !names.has(fold(name))) add(unmatched, clip(entry));
		else if (match?.[2]?.trim()) {
			// 放行整个工具而不是拒绝：这里没有按命令、按路径的范围可收窄，拒绝 `bash` 会让 `Bash(git commit *)` 的技能连它点名的那件事都做不了。
			add(scoped, clip(entry));
			add(widened, tool);
		}
	}
	if (scoped.length > 0) problems.push({ kind: "scoped", items: scoped, widened });
	if (unmatched.length > 0) problems.push({ kind: "unmatched", items: unmatched });
	if (serverWide.length > 0) problems.push({ kind: "serverWide", items: serverWide });
	return { tools, problems };
}

/** 按逗号和空白分，括号里的不分：`Agent(scan-inventory, scan-verifier)`、`Bash(git add *)` 各是一项。 */
function splitEntries(text: string): string[] {
	const entries: string[] = [];
	let current = "";
	let depth = 0;
	for (const char of text) {
		if (depth === 0 && (char === "," || /\s/.test(char))) {
			if (current) entries.push(current);
			current = "";
			continue;
		}
		if (char === "(") depth += 1;
		else if (char === ")" && depth > 0) depth -= 1;
		current += char;
	}
	if (current) entries.push(current);
	return entries;
}

/** `mcp__github` 或 `mcp__github__*`：一个服务的全部工具，一列确切的名字说不出这个意思。 */
function namesWholeServer(name: string): boolean {
	const rest = name.slice("mcp__".length);
	return !rest.includes("__") || rest.endsWith("__*");
}

function add(into: string[], item: string): void {
	if (!into.includes(item)) into.push(item);
}

function show(value: unknown): string {
	try {
		return clip(JSON.stringify(value) ?? String(value));
	} catch {
		// `&x [read, *x]` 是个包含自己的列表：一个怪文件不能让其余的读不下去。
		return typeof value;
	}
}

function clip(text: string): string {
	return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
