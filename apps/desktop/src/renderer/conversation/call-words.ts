/**
 * 一次调用、一段调用在行上用的那几个词和数。
 *
 * 工具行（`ToolCard`）、一段活那一行（`WorkStep`）和跑完收起的那一行（`TurnWork`）共用：同一次调用在几种行上是同一种说法。
 */

import type { ToolResultMessage } from "@plume/contract";
import { activeLocale, formatList, type MessageKey, translate } from "@plume/ui";
import { baseName } from "../files/open-file.ts";
import { relativeTo } from "../markdown/assets.ts";
import type { Call, ToolCallBlock } from "./grouping.ts";
import { lineSubject, lineVerb, toolLine } from "./tool-lines.ts";
import { polledJob } from "./turn-blocks.ts";

/** 工具名到「它在做什么」的那个说法，存 key：这张表在模块加载时成型，那会儿窗口还没说自己是哪种语言。 */
const KIND: Record<string, MessageKey> = {
	write: "tools.create",
	edit: "tools.edit",
	read: "tools.read",
	bash: "tools.bash",
	bash_output: "tools.output",
	glob: "tools.find",
	grep: "tools.grep",
	ls: "tools.ls",
	todo_write: "tools.todo",
};

/** 插件登记了动作的说法；只登记了归类、图标（没给 `verb`）的照没登记说法的工具说。 */
function spokenLine(tool: string) {
	const line = toolLine(tool);
	return line?.verb === undefined ? undefined : line;
}

/**
 * 一串调用做了什么，用事后描述它时会用的话说。
 *
 * 按动作归，不按工具名归：从外面看，「读取」是好几个工具的同一件事。一种动作只有一次、对象值得点名时说出对象；
 * 多于一次就数个数。插件登记了说法的工具（`ui.toolLine`）用它给的动作。
 */
function describeRun(calls: { toolName: string; subject?: string | undefined }[], step = false): string {
	const counts = new Map<string, { count: number; subjects: string[]; times: boolean }>();
	for (const call of calls) {
		const registered = spokenLine(call.toolName);
		const line = step && registered?.callOnly ? undefined : registered;
		const key = KIND[call.toolName];
		const kind = line ? lineVerb(line, activeLocale()) || call.toolName : key ? translate(key) : translate("tools.using");
		const entry = counts.get(kind) ?? { count: 0, subjects: [], times: false };
		entry.count += 1;
		if (call.subject) entry.subjects.push(call.subject);
		if (line?.times) entry.times = true;
		counts.set(kind, entry);
	}
	const parts: string[] = [];
	for (const [kind, { count, subjects, times }] of counts) {
		if (count === 1 && subjects.length === 1) parts.push(`${kind} ${subjects[0]}`);
		// 一次、又没什么可点名的——「执行命令 1 个」数到一，只是噪音。
		else if (count === 1) parts.push(kind);
		// 网页上的点击、输入是「次」不是「个」（`ToolLine.times`）。
		else parts.push(translate(times ? "tools.countTimes" : "tools.countOf", { kind, count }));
	}
	return formatList(parts);
}

/**
 * 一段调用做了什么，一段活那一行和收起的那一行说的那一句。
 *
 * 清单并在一段活里时不点名：那一行说的是干了什么活，勾到哪一项清单上看得到。只有清单时照旧说它。
 * 查输出是那条后台命令的一部分：这一段里有命令（`bash` 和像它的）时不另记；只有查看时，一个任务记一次。按调用数的话，一条命令被查了九次，
 * 这一行就说「执行命令 1 个、查看输出 9 个」。
 */
export function describeCalls(calls: Call[]): string {
	return describeRun(
		counted(calls).map(({ block }) => ({ toolName: block.name, subject: subjectFor(block) })),
		true,
	);
}

function counted(calls: Call[]): Call[] {
	const work = calls.some(({ block }) => block.name !== "todo_write");
	const commands = calls.some(({ block }) => block.name === "bash" || toolLine(block.name)?.like === "bash");
	const jobs = new Set<unknown>();
	return calls.filter(({ block }) => {
		if (work && block.name === "todo_write") return false;
		if (block.name !== "bash_output") return true;
		const job = (block.arguments as { id?: unknown } | undefined)?.id;
		if (commands || jobs.has(job)) return false;
		jobs.add(job);
		return true;
	});
}

/** 查看后台任务输出那一行：说是哪个任务（启动它的那条命令的说明），连着查了几次也说。找不到说明，就只说「查看输出」。 */
export function describePolls(what: string | undefined, times: number): string {
	if (what) return times > 1 ? translate("tools.outputOfTimes", { what, n: times }) : translate("tools.outputOf", { what });
	return times > 1 ? translate("tools.outputTimes", { n: times }) : translate("tools.output");
}

/**
 * 模型给人写了一句说明就用它的那几个（插件的工具说像它们的也算，见 `ToolLine.like`）：命令人一眼读不出在干什么，正则和通配也是。
 * 参数里没给 `pattern` 时那里是模型错放的式子，照样只当说明用模型自己写的那句。
 */
const DESCRIBED = new Set(["grep", "glob", "bash"]);

/**
 * 读文件、列目录那一行说的对象：相对工作区的完整路径。
 *
 * 只说文件名时，`apps/web/src/main.tsx` 和 `apps/cli/src/main.ts` 读起来是同一个 main。只读了一段的带上行号，同一个文件
 * 读两段才分得开；目录带 `/`，和文件一眼分开。工作区外的路径照原样，家目录缩成 `~`。
 */
function locationOf(block: ToolCallBlock, root?: string): string | undefined {
	const { path, offset, limit } = (block.arguments ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown };
	const shown = (value: string) => tildeHome(root ? (relativeTo(root, value) ?? value) : value);
	if (block.name === "ls") {
		const dir = shown(typeof path === "string" && path !== "" ? path : ".");
		return /[\\/]$/.test(dir) ? dir : `${dir}/`;
	}
	if (block.name !== "read" || typeof path !== "string" || path === "") return undefined;
	return `${shown(path)}${lineRange(offset, limit)}`;
}

/** `:10-29`；只给了起点是 `:10-`，只给了行数从第 1 行算。模型常把没给的参数写成 null，所以按类型认。 */
function lineRange(offset: unknown, limit: unknown): string {
	const from = typeof offset === "number" ? offset : undefined;
	const count = typeof limit === "number" ? limit : undefined;
	if (from === undefined && count === undefined) return "";
	const start = from ?? 1;
	return `:${start}-${count === undefined ? "" : start + count - 1}`;
}

/**
 * 一次调用在行上怎么说：读文件、列目录说路径（`root` 是工作区）；模型写了一句给人看的说明就用它；其余说动作和对象。
 * 查后台任务输出的那一次说是哪个任务（`job`：启动它的那条命令的说明），停掉它的那一次说停止命令。
 */
export function describeOne(block: ToolCallBlock, root?: string, job?: string): string {
	if (polledJob(block)) return describePolls(job, 1);
	if (block.name === "bash_output") return translate("tools.stopJob");
	const line = toolLine(block.name);
	const { description } = (block.arguments ?? {}) as { description?: unknown };
	const said = typeof description === "string" ? description.trim() : "";
	if (said && DESCRIBED.has((line ? line.like : block.name) ?? "")) return said;
	const spoken = spokenLine(block.name);
	if (spoken) return describeRun([{ toolName: block.name, subject: lineSubject(spoken, block.arguments) }]);
	if (block.name === "todo_write") return describeTodos(block.arguments);
	const location = locationOf(block, root);
	if (location) return describeRun([{ toolName: block.name, subject: location }]);
	if (KIND[block.name]) return describeRun([{ toolName: block.name, subject: subjectOf(block) }]);
	// 不认得的工具（没登记说法的插件工具）照原名说：「使用工具」读不出是哪一个。
	return block.name;
}

/** 更新清单那一行：进度，加上接下来在做的那一项。参数还在流进来时清单不全，退回只说「更新清单」。 */
function describeTodos(args: unknown): string {
	const todos = (args as { todos?: unknown } | undefined)?.todos;
	if (!Array.isArray(todos) || todos.length === 0) return translate("tools.todo");
	const items = todos.filter((todo): todo is { content?: unknown; status?: unknown } => !!todo && typeof todo === "object");
	const done = items.filter((todo) => todo.status === "completed").length;
	const task = items.find((todo) => todo.status === "in_progress")?.content;
	const progress = { done, total: todos.length };
	return typeof task === "string" && task.trim() ? translate("tools.todoAt", { ...progress, task: task.trim() }) : translate("tools.todoOf", progress);
}

/** 家目录缩成 `~`：`/Users/someone/…` 那一截在一行摘要里只占地方，谁都知道它是哪里。 */
function tildeHome(path: string): string {
	return path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=$|[\\/])/, "~");
}

/** 一次调用在一段活的总说法里点名的对象：插件登记了说法的按它取，其余见 `subjectOf`。 */
function subjectFor(block: ToolCallBlock): string | undefined {
	const line = spokenLine(block.name);
	return line ? lineSubject(line, block.arguments) : subjectOf(block);
}

/** 一次调用说的是哪个文件、哪个网页，值得在一句摘要里点名的那部分。 */
function subjectOf(block: ToolCallBlock): string | undefined {
	const { path, url } = (block.arguments ?? {}) as { path?: unknown; url?: unknown };
	if (typeof path === "string") return path !== "" ? baseName(path) : undefined;
	// 打开的网页（插件的工具）：本地文件报文件名，网站报主机名——整串地址放在一行摘要里只会被截掉。
	if (typeof url !== "string") return undefined;
	try {
		const parsed = new URL(url);
		const name = baseName(parsed.pathname);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? (/\.html?$/i.test(name) ? name : parsed.host) : name || undefined;
	} catch {
		return baseName(url) || undefined;
	}
}

/** 一次改动加、删了几行，读工具结果的 `details`。 */
export function diffOf(result: ToolResultMessage | undefined, key: "added" | "removed"): number {
	const value = (result?.details as Record<string, unknown> | undefined)?.[key];
	return typeof value === "number" ? value : 0;
}
