/*
 * 工具行行首那枚图标，`ToolCard` 和 `WorkStep` 共用：一段几次调用合成的那一行用的是它第一次调用的图标，
 * 和它只有一次调用时那一行是同一枚——从一次长到两次，行首不换。
 */

import { FileCode, FilePlus, FileText, FolderTree, Search, Terminal } from "@plume/ui/icons";
import { toolLine } from "./tool-lines.ts";

const ICONS: Record<string, typeof FileText> = {
	read: FileText,
	write: FilePlus,
	edit: FileCode,
	ls: FolderTree,
	glob: Search,
	grep: Search,
	bash: Terminal,
	// 查后台命令的输出，和起它的那条命令同一枚。
	bash_output: Terminal,
};

export function ToolIcon({ name }: { name: string }) {
	// 插件登记了说法的，用它给的图标或它像的那个内置工具的。不认得的工具用终端那枚：一个工具调用读起来就是「跑了一件事」，
	// 扳手说的是设置。
	const line = toolLine(name);
	const Icon = (line ? (line.icon ?? (line.like ? ICONS[line.like] : undefined)) : ICONS[name]) ?? Terminal;
	return <Icon size={13} strokeWidth={1.8} className="shrink-0" />;
}
