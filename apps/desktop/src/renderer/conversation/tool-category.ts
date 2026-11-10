/**
 * 一段活按什么归类：同一类连着做的调用，在转录里合成一行（见 `turn-blocks.ts` 的 `Step`）。
 *
 * 分的是「从外面看在干同一件事」：读、搜、列目录都是在看代码；写和改都是在动文件。表里没有的工具自成一类，
 * 连着调同一个工具才合在一起。插件的工具按它登记的 `group` 归到它起名的那一类（浏览器那几个都是在用同一个页面），
 * 没有 `group` 时按 `like` 归到那个内置工具的类（见 `tool-lines.ts`）。
 *
 * `bash` 看命令本身：`rg`、`sed -n`、`git log` 和 read、grep 是同一件事，归探索（`isShellRead`）。
 * 不和说法（`call-words.ts`）放在一起：分组要在测试里直接跑，不能连带界面的文案。
 */

import { isShellRead } from "./shell-reads.ts";
import { toolLine } from "./tool-lines.ts";

const CATEGORY: Record<string, string> = {
	write: "files",
	edit: "files",
	read: "explore",
	ls: "explore",
	glob: "explore",
	grep: "explore",
	bash_output: "terminal",
	monitor: "terminal",
};

/** 插件起名的一类活（`ToolLine.group`）带这个前缀：和工具名、内置的几类分开，叫 browser 的工具不会和 group 为 browser 的那几个算成一类。 */
const GROUP = "group:";

/** 这一类是不是插件起名的一类活：它们和读、跑命令、改文件互相接成一段（见 `turn-blocks.ts` 的 `joins`）。 */
export function isPluginGroup(category: string): boolean {
	return category.startsWith(GROUP);
}

export function toolCategory(toolName: string, args?: unknown): string {
	const line = toolLine(toolName);
	if (line?.group) return GROUP + line.group;
	// 像 bash 的插件工具没有 `command`，归跑命令；不像哪个的自成一类。
	if (line) return line.like ? toolCategory(line.like, args) : toolName;
	if (toolName === "bash") {
		const command = (args as { command?: unknown } | undefined)?.command;
		return typeof command === "string" && isShellRead(command) ? "explore" : "terminal";
	}
	return CATEGORY[toolName] ?? toolName;
}
