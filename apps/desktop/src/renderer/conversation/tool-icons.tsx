/*
 * 工具行行首那枚图标，`ToolCard` 和 `WorkStep` 共用：一段几次调用合成的那一行用的是它第一次调用的图标，
 * 和它只有一次调用时那一行是同一枚——从一次长到两次，行首不换。
 */

import type { ToolKind } from "@plume/contract/ui";
import { FileCode, FilePlus, FileText, FolderTree, Search, Terminal } from "@plume/ui/icons";
import { toolLine } from "./tool-lines.ts";

/** 每种活（`ToolLine.kind`）默认的图标。 */
const ICONS: Record<ToolKind, typeof FileText> = {
	view: FileText,
	create: FilePlus,
	modify: FileCode,
	list: FolderTree,
	find: Search,
	search: Search,
	command: Terminal,
};

export function ToolIcon({ name }: { name: string }) {
	// 插件给的图标，没给就按它做的那种活。不认得的工具用终端那枚（查后台命令的输出也是这枚，和起它的那条命令同一枚）：
	// 一个工具调用读起来就是「跑了一件事」，扳手说的是设置。
	const line = toolLine(name);
	const Icon = line?.icon ?? (line?.kind ? ICONS[line.kind] : undefined) ?? Terminal;
	return <Icon size={13} strokeWidth={1.8} className="shrink-0" />;
}
