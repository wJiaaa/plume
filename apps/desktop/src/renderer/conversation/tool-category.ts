/**
 * 一段活按什么归类：同一类连着做的调用，在转录里合成一行（见 `turn-blocks.ts` 的 `Step`）。
 *
 * 分的是「从外面看在干同一件事」：读、搜、列目录都是在看代码；写和改都是在动文件。按工具定义上声明的种类归（`ToolDefinition.kind`），
 * 本体不认工具名；什么都没声明的工具自成一类，连着调同一个工具才合在一起。插件的工具按它登记的 `group` 归到它起名的那一类
 * （浏览器那几个都是在用同一个页面）；记进度清单的另成一类（`CHECKLIST`）；查后台任务的（种类是 `job`）归跑命令。
 *
 * 跑命令的看命令本身（`ToolLine.command`）：`rg`、`sed -n`、`git log` 和读文件、搜内容是同一件事，归探索（`isShellRead`）。
 * 不和说法（`call-words.ts`）放在一起：分组要在测试里直接跑，不能连带界面的文案。
 */

import type { ToolKind } from "@plume/contract";
import { isShellRead } from "./shell-reads.ts";
import { checklistTool, lineCommand, runsCommand, toolKind, toolLine } from "./tool-lines.ts";

const CATEGORY: Record<ToolKind, string> = {
	view: "explore",
	list: "explore",
	find: "explore",
	search: "explore",
	create: "files",
	modify: "files",
	command: "terminal",
	watch: "terminal",
	job: "terminal",
};

/** 插件起名的一类活（`ToolLine.group`）带这个前缀：和工具名、内置的几类分开，叫 browser 的工具不会和 group 为 browser 的那几个算成一类。 */
const GROUP = "group:";
/** 自成一段的那几类（`ToolLine.apart`）：前缀和 `GROUP` 分开，它们不和读、跑命令、改文件接。 */
const APART = "apart:";

/** 记进度清单的那一类（工具定义上的 `category: "checklist"`）：它跟着旁边那段活走，见 `turn-blocks.ts` 的 `joins`。 */
export const CHECKLIST = "checklist";

/** 这一类是不是插件起名的一类活：它们和读、跑命令、改文件互相接成一段（见 `turn-blocks.ts` 的 `joins`）。 */
export function isPluginGroup(category: string): boolean {
	return category.startsWith(GROUP);
}

export function toolCategory(toolName: string, args?: unknown): string {
	if (checklistTool(toolName)) return CHECKLIST;
	const line = toolLine(toolName);
	if (line?.group) return (line.apart ? APART : GROUP) + line.group;
	const kind = toolKind(toolName);
	if (runsCommand(kind)) {
		const command = lineCommand(toolName, args);
		return command !== undefined && isShellRead(command) ? "explore" : "terminal";
	}
	return kind ? CATEGORY[kind] : toolName;
}
