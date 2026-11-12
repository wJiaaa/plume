/**
 * 插件经 `ui.toolLine` 给自己的工具登记的说法：动作、对象、像哪个内置工具、归哪一类、图标。
 *
 * 说法（`call-words.ts`）、归类（`tool-category.ts`）、图标（`tool-icons.tsx`）、运行行（`thinking-words.ts`）都先查这里，
 * 查不到才用产品给内置工具的表：插件可以换掉同名的内置工具，说法跟着它走。单独一个模块、不碰界面：分组要在测试里直接跑。
 */

import type { Locale } from "@plume/contract";
import type { ToolLine } from "@plume/contract/ui";

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
