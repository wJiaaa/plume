/**
 * 转录怎么认一个工具：工具定义上声明的种类（`ToolDefinition.kind`，agent 进程经 `listTools` 和 `tools` 事件给），和插件经
 * `ui.toolLine` 给自己的工具登记的说法：动作、对象、对着哪个文件、归哪一类、图标。
 *
 * 说法（`call-words.ts`）、归类（`tool-category.ts`）、图标（`tool-icons.tsx`）、运行行（`thinking-words.ts`）、回复里的文件签
 * （`files/scope.ts`）都只查这里，本体不认工具名：读文件、跑命令这些基本工具也是 plume.tools 在定义上声明、在这里登记的。
 * 单独一个模块、不碰界面：分组要在测试里直接跑。
 */

import type { Locale, RegisteredToolInfo, ToolKind } from "@plume/contract";
import type { ToolFile, ToolLine } from "@plume/contract/ui";

const KINDS: ReadonlySet<string> = new Set<ToolKind>(["view", "list", "find", "search", "create", "modify", "command", "watch", "job"]);

/** 工具名 → 工具定义上声明的种类。认不出的值当作没声明。 */
let kinds = new Map<string, ToolKind>();

/** 换上 agent 进程给的工具表。返回种类有没有变（变了转录要重新分组）。 */
export function setToolTable(tools: readonly RegisteredToolInfo[]): boolean {
	const next = new Map<string, ToolKind>();
	for (const tool of tools) if (typeof tool.kind === "string" && KINDS.has(tool.kind)) next.set(tool.name, tool.kind);
	const same = next.size === kinds.size && [...next].every(([name, kind]) => kinds.get(name) === kind);
	kinds = next;
	return !same;
}

/** 这个工具做的是哪种活（`ToolDefinition.kind`）；没声明、不在工具表里的是 undefined。 */
export function toolKind(tool: string): ToolKind | undefined {
	return kinds.get(tool);
}

/** 跑命令的两种：一次跑完的、长跑着边跑边送输出的。说法、归类、运行行一样，命令原文从 `ToolLine.command` 取。 */
export function runsCommand(kind: ToolKind | undefined): boolean {
	return kind === "command" || kind === "watch";
}

interface Entry {
	plugin: string;
	line: ToolLine;
}

/** 工具名（按前缀登记的是前缀）→ 登记过的说法，后登记的在末尾、生效。 */
const lines = new Map<string, Entry[]>();
const prefixes = new Map<string, Entry[]>();

export function addToolLine(plugin: string, tool: string, line: ToolLine, match: "tool" | "prefix" = "tool"): void {
	const table = match === "prefix" ? prefixes : lines;
	table.set(tool, [...(table.get(tool) ?? []), { plugin, line }]);
}

/** 插件停用时撤下它登记的，前一个恢复。 */
export function removeToolLines(plugin: string): void {
	for (const table of [lines, prefixes]) {
		for (const [tool, list] of table) {
			const kept = list.filter((entry) => entry.plugin !== plugin);
			if (kept.length > 0) table.set(tool, kept);
			else table.delete(tool);
		}
	}
}

/** 精确工具名登记的优先；没有时取对得上的最长前缀。 */
export function toolLine(tool: string): ToolLine | undefined {
	const exact = lines.get(tool)?.at(-1)?.line;
	if (exact) return exact;
	let best: string | undefined;
	for (const prefix of prefixes.keys()) if (tool.startsWith(prefix) && prefix.length > (best?.length ?? -1)) best = prefix;
	return best === undefined ? undefined : prefixes.get(best)?.at(-1)?.line;
}

/** 记进度清单的工具（`ToolLine.checklist`）。 */
export function checklistTool(tool: string): boolean {
	return toolLine(tool)?.checklist === true;
}

/** 插件给的动作，按当前语言取；插件的函数出错或不给字时是空串，由调用方退回工具名。没给 `verb` 的照没登记说法的工具说，不走到这里（见 `call-words.ts` 的 `spokenLine`）。 */
export function lineVerb(line: ToolLine, locale: Locale): string {
	if (line.verb === undefined) return "";
	if (typeof line.verb === "string") return line.verb.trim();
	try {
		const verb = line.verb(locale);
		return typeof verb === "string" ? verb.trim() : "";
	} catch (error) {
		console.error("插件给的工具说法取不出来：", error);
		return "";
	}
}

/** 插件取的对象：插件的函数出错或不给字，就当没有对象，只说动作。 */
export function lineSubject(line: ToolLine, args: unknown): string | undefined {
	if (!line.subject) return undefined;
	try {
		const subject = line.subject((args ?? {}) as Record<string, unknown>);
		return typeof subject === "string" && subject.trim() !== "" ? subject.trim() : undefined;
	} catch (error) {
		console.error("插件给的工具对象取不出来：", error);
		return undefined;
	}
}

/** 插件从参数里取值的函数：插件的函数出错当作取不出。 */
function fromArgs<T>(take: ((args: Record<string, unknown>) => T) | undefined, args: unknown): T | undefined {
	if (!take) return undefined;
	try {
		return take((args ?? {}) as Record<string, unknown>);
	} catch (error) {
		console.error("插件给的工具说法取不出来：", error);
		return undefined;
	}
}

/** 这次调用对着的文件或目录（`ToolLine.file`）；形状不对当作没有。 */
export function lineFile(tool: string, args: unknown): ToolFile | undefined {
	const file = fromArgs(toolLine(tool)?.file, args);
	return typeof file?.path === "string" ? file : undefined;
}

/** 模型写给人看的那句说明（`ToolLine.note`），去掉两头空白；空的当作没有。 */
export function lineNote(tool: string, args: unknown): string | undefined {
	const note = fromArgs(toolLine(tool)?.note, args);
	return typeof note === "string" && note.trim() !== "" ? note.trim() : undefined;
}

/** 这次跑的命令原文（`ToolLine.command`）。 */
export function lineCommand(tool: string, args: unknown): string | undefined {
	const command = fromArgs(toolLine(tool)?.command, args);
	return typeof command === "string" ? command : undefined;
}

/** 这次调用查看或停掉的后台任务（种类是 `job`，任务从 `ToolLine.job` 取）；不是这类调用时是 undefined，认不出任务时 `id` 是 undefined。 */
export function lineJob(tool: string, args: unknown): { id: string | undefined; stop: boolean } | undefined {
	if (toolKind(tool) !== "job") return undefined;
	const job = fromArgs(toolLine(tool)?.job, args);
	if (!job || typeof job !== "object") return { id: undefined, stop: false };
	return { id: typeof job.id === "string" ? job.id : undefined, stop: job.stop === true };
}
