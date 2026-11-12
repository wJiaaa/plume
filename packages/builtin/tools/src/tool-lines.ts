/**
 * 本插件的工具在转录里怎么说（`ui.toolLine`）：做的是哪种活、对着哪个文件、模型写的说明、跑的命令、查的是哪个后台任务。
 * 本体只按这些声明给说法、图标、归类和回复里的文件签，不认工具名；动作的字由本体按种类给，这里只有 monitor 自己说。
 *
 * 参数是模型给的、没校验过，取不出就返回 undefined。单独一个模块、不碰界面：测试直接读这张表。
 */

import type { ToolLine } from "@plume/contract/ui";
import { MESSAGES } from "./messages.ts";

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
/** 模型在参数里写给人看的那句说明：命令、正则、通配人一眼读不出在干什么。 */
const note = (args: Record<string, unknown>) => text(args.description);
/** 对着的文件：`path` 照模型写的样子。 */
const file = (args: Record<string, unknown>) => {
	const path = text(args.path);
	return path === undefined ? undefined : { path };
};

/** 读了哪几行：只给了起点是读到末尾，只给了行数从第 1 行算。模型常把没给的参数写成 null，所以按类型认。 */
function readLines(args: Record<string, unknown>): { from: number; to?: number } | undefined {
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return undefined;
	const from = offset ?? 1;
	return limit === undefined ? { from } : { from, to: from + limit - 1 };
}

export const TOOL_LINES: Record<string, ToolLine> = {
	read: {
		kind: "view",
		file: (args) => {
			const path = text(args.path);
			const lines = readLines(args);
			return path === undefined ? undefined : { path, ...(lines ? { lines } : {}) };
		},
	},
	// 没给目录是工作目录。
	ls: { kind: "list", file: (args) => ({ path: text(args.path) ?? "" }) },
	glob: { kind: "find", note },
	grep: { kind: "search", note },
	write: { kind: "create", file },
	edit: { kind: "modify", file },
	bash: { kind: "command", note, command: (args) => text(args.command) },
	bash_output: { job: (args) => ({ ...(typeof args.id === "string" ? { id: args.id } : {}), stop: args.kill === true }) },
	// monitor 是长跑的命令：和 bash 归成「跑命令」一类，模型写了说明就说它，没写说「监视命令」。
	monitor: { verb: (locale) => MESSAGES[locale].monitorVerb, kind: "command", note, command: (args) => text(args.command) },
};
