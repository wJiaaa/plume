/**
 * 一次调用、一段调用在行上用的那几个词和数。
 *
 * 工具行（`ToolCard`）、一段活那一行（`WorkStep`）和跑完收起的那一行（`TurnWork`）共用：同一次调用在几种行上是同一种说法。
 */

import type { FileDiffDetails, ToolKind, ToolResultMessage } from "@plume/contract";
import { activeLocale, formatList, type MessageKey, translate } from "@plume/ui";
import { baseName } from "../files/open-file.ts";
import { relativeTo } from "../markdown/assets.ts";
import type { Call, ToolCallBlock } from "./grouping.ts";
import { checklistTool, lineCommand, lineFile, lineJob, lineNote, lineSubject, lineVerb, runsCommand, toolKind, toolLine } from "./tool-lines.ts";
import { polledJob } from "./turn-blocks.ts";

/** 每种活（`ToolDefinition.kind`）默认的说法，存 key：这张表在模块加载时成型，那会儿窗口还没说自己是哪种语言。 */
const KIND: Record<ToolKind, MessageKey> = {
	view: "tools.read",
	list: "tools.ls",
	find: "tools.find",
	search: "tools.grep",
	create: "tools.create",
	modify: "tools.edit",
	command: "tools.bash",
	watch: "tools.bash",
	job: "tools.output",
};

/** 插件没给动作时的说法：按做的是哪种活。没声明种类的没有。 */
function defaultVerb(tool: string): MessageKey | undefined {
	const kind = toolKind(tool);
	return kind ? KIND[kind] : undefined;
}

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
		const key = defaultVerb(call.toolName);
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
 * 清单（工具定义上的 `category: "checklist"`）并在一段活里时不点名：那一行说的是干了什么活，勾到哪一项清单上看得到。只有清单时照旧说它，
 * 也不说进度：进度是每一次的，合在一起说的是动作。
 * 查输出（种类是 `job`）是那条后台命令的一部分：这一段里有命令（种类是 `command`、`watch`）时不另记；只有查看时，一个任务记一次。按调用数的话，一条命令被查了九次，
 * 这一行就说「执行命令 1 个、查看输出 9 个」。
 */
export function describeCalls(calls: Call[]): string {
	return describeRun(
		counted(calls).map(({ block }) => ({ toolName: block.name, subject: checklistTool(block.name) ? undefined : subjectFor(block) })),
		true,
	);
}

function counted(calls: Call[]): Call[] {
	const work = calls.some(({ block }) => !checklistTool(block.name));
	const commands = calls.some(({ block }) => runsCommand(toolKind(block.name)));
	const jobs = new Set<unknown>();
	return calls.filter(({ block }) => {
		if (work && checklistTool(block.name)) return false;
		if (toolKind(block.name) !== "job") return true;
		const job = lineJob(block.name, block.arguments)?.id;
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
 * 读文件（种类是 `view`）、列目录（`list`）那一行说的对象：插件给的文件（`ToolLine.file`）相对工作区的完整路径。
 *
 * 只说文件名时，`apps/web/src/main.tsx` 和 `apps/cli/src/main.ts` 读起来是同一个 main。只读了一段的带上行号，同一个文件
 * 读两段才分得开；目录带 `/`，和文件一眼分开，没给目录的是工作目录。工作区外的路径照原样，家目录缩成 `~`。
 * 改文件、写文件的那一行照旧只说名字：展开是带着完整路径的 diff。
 */
function locationOf(block: ToolCallBlock, root?: string): string | undefined {
	const kind = toolKind(block.name);
	if (kind !== "view" && kind !== "list") return undefined;
	const file = lineFile(block.name, block.arguments);
	const shown = (value: string) => tildeHome(root ? (relativeTo(root, value) ?? value) : value);
	if (kind === "list") {
		const dir = shown(file && file.path !== "" ? file.path : ".");
		return /[\\/]$/.test(dir) ? dir : `${dir}/`;
	}
	if (!file || file.path === "") return undefined;
	return `${shown(file.path)}${lineRange(file.lines)}`;
}

/** `:10-29`；没给到哪一行是 `:10-`。 */
function lineRange(lines: { from: number; to?: number } | undefined): string {
	if (!lines) return "";
	return `:${lines.from}-${lines.to === undefined ? "" : lines.to}`;
}

/**
 * 一次调用在行上怎么说：模型写了一句给人看的说明（`ToolLine.note`）就用它；读文件、列目录说路径（`root` 是工作区）；其余说动作和对象。
 * 查后台任务输出的那一次说是哪个任务（种类是 `job`：启动它的那条命令的说明），停掉它的那一次说停止命令。
 */
export function describeOne(block: ToolCallBlock, root?: string, job?: string): string {
	if (polledJob(block)) return describePolls(job, 1);
	if (toolKind(block.name) === "job") return translate("tools.stopJob");
	const said = lineNote(block.name, block.arguments);
	if (said) return said;
	const spoken = spokenLine(block.name);
	if (spoken) return describeRun([{ toolName: block.name, subject: lineSubject(spoken, block.arguments) }]);
	const location = locationOf(block, root);
	if (location) return describeRun([{ toolName: block.name, subject: location }]);
	if (defaultVerb(block.name)) return describeRun([{ toolName: block.name, subject: subjectFor(block) }]);
	// 不认得的工具（没登记说法的插件工具）照原名说：「使用工具」读不出是哪一个。
	return block.name;
}

/** 家目录缩成 `~`：`/Users/someone/…` 那一截在一行摘要里只占地方，谁都知道它是哪里。 */
function tildeHome(path: string): string {
	return path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=$|[\\/])/, "~");
}

/** 一次调用在一段活的总说法里点名的对象：插件登记了说法的按它取，给了文件（`ToolLine.file`）的说文件名，其余见 `subjectOf`。 */
function subjectFor(block: ToolCallBlock): string | undefined {
	const line = spokenLine(block.name);
	if (line) return lineSubject(line, block.arguments);
	const file = lineFile(block.name, block.arguments);
	if (file) return file.path !== "" ? baseName(file.path) : undefined;
	return subjectOf(block);
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

/** 一次改动加、删了几行：工具结果的 `details` 声明的文件改动（`FileDiffDetails`），没声明是 0。 */
export function diffOf(result: ToolResultMessage | undefined, key: "added" | "removed"): number {
	const value = (result?.details as Partial<Record<keyof FileDiffDetails, unknown>> | undefined)?.[key];
	return typeof value === "number" ? value : 0;
}

/**
 * 工具组（`ToolGroup`）里一次调用的那一行：动作、点名的对象、淡一档的附注（读了哪几行）。对象单独给出来，行上画得深一档。
 *
 * 和 `describeOne` 是同一套取法，只是动作分了时态：跑着时「正在查看」，跑完「查看」——一行字原地换一次，读的人不用再看记号
 * 就知道它跑完了。模型写了说明（`ToolLine.note`）、插件登记了动作的照它们说，不分时态。
 */
export interface CallLabel {
	verb: string;
	subject?: string;
	note?: string;
}

type TensedKind = Exclude<ToolKind, "watch" | "job">;

const TENSED: Record<TensedKind, { now: MessageKey; done: MessageKey; nowBare: MessageKey; doneBare: MessageKey; sum: MessageKey }> = {
	view: { now: "toolNow.view", done: "toolDone.view", nowBare: "toolNowBare.view", doneBare: "toolDoneBare.view", sum: "toolSum.view" },
	list: { now: "toolNow.list", done: "toolDone.list", nowBare: "toolNowBare.list", doneBare: "toolDoneBare.list", sum: "toolSum.list" },
	find: { now: "toolNow.find", done: "toolDone.find", nowBare: "toolNowBare.find", doneBare: "toolDoneBare.find", sum: "toolSum.find" },
	search: { now: "toolNow.search", done: "toolDone.search", nowBare: "toolNowBare.search", doneBare: "toolDoneBare.search", sum: "toolSum.search" },
	create: { now: "toolNow.create", done: "toolDone.create", nowBare: "toolNowBare.create", doneBare: "toolDoneBare.create", sum: "toolSum.create" },
	modify: { now: "toolNow.modify", done: "toolDone.modify", nowBare: "toolNowBare.modify", doneBare: "toolDoneBare.modify", sum: "toolSum.modify" },
	command: { now: "toolNow.command", done: "toolDone.command", nowBare: "toolNowBare.command", doneBare: "toolDoneBare.command", sum: "toolSum.command" },
};

/** 分时态说的那几种；长跑的命令（`watch`）和一次跑完的说法一样。查后台任务（`job`）另有说法。 */
function tensedKind(tool: string): TensedKind | undefined {
	const kind = toolKind(tool);
	if (kind === "watch") return "command";
	return kind === undefined || kind === "job" ? undefined : kind;
}

export function labelText(label: CallLabel): string {
	return [label.verb, label.subject, label.note].filter(Boolean).join(" ");
}

/** `live`：这次调用还没跑完（参数在写、排着、等批准、在跑）。`root` 是工作区，`job` 是查看的那个后台任务的说明。 */
export function callLabel(block: ToolCallBlock, live: boolean, root?: string, job?: string): CallLabel {
	if (polledJob(block)) return { verb: describePolls(job, 1) };
	if (toolKind(block.name) === "job") return { verb: translate("tools.stopJob") };
	const said = lineNote(block.name, block.arguments);
	if (said) return { verb: said };
	const spoken = spokenLine(block.name);
	if (spoken) {
		const subject = lineSubject(spoken, block.arguments);
		return { verb: lineVerb(spoken, activeLocale()) || block.name, ...(subject ? { subject } : {}) };
	}
	const kind = tensedKind(block.name);
	// 不认得的工具（没登记说法的插件工具）照原名说。
	if (!kind) return { verb: block.name };
	const words = TENSED[kind];
	const file = lineFile(block.name, block.arguments);
	let subject: string | undefined;
	let note: string | undefined;
	if (kind === "list") subject = locationOf(block, root);
	else if (kind === "command") subject = lineCommand(block.name, block.arguments)?.split("\n")[0]?.trim() || undefined;
	else if (file) {
		subject = file.path !== "" ? baseName(file.path) : undefined;
		if (kind === "view" && file.lines) note = `(${file.lines.from}–${file.lines.to ?? ""})`;
	} else subject = subjectFor(block);
	if (!subject) return { verb: translate(live ? words.nowBare : words.doneBare) };
	return { verb: translate(live ? words.now : words.done), subject, ...(note ? { note } : {}) };
}

/**
 * 一组调用跑完以后标题上那一句：按种类数，「运行 3 个命令（1 个失败），查看 2 个文件」。读、写、改按文件数（同一个文件改三次
 * 是「修改 1 个文件」），其余按次数。插件登记了动作的、不认得的工具照 `describeCalls` 的说法接在后面；推理有几次也说。
 * 哪些调用不数（清单、查输出）和 `describeCalls` 一样，见 `counted`。
 */
export function summarizeCalls(calls: Call[], failed: ReadonlySet<string>, thought = 0, thoughtFirst = false): string {
	const kinds = new Map<TensedKind, { seen: Set<string>; failed: number }>();
	const others: Call[] = [];
	for (const call of counted(calls)) {
		const { block } = call;
		const kind = spokenLine(block.name) ? undefined : tensedKind(block.name);
		if (!kind) {
			others.push(call);
			continue;
		}
		const entry = kinds.get(kind) ?? { seen: new Set<string>(), failed: 0 };
		const path = kind === "view" || kind === "create" || kind === "modify" ? lineFile(block.name, block.arguments)?.path : undefined;
		entry.seen.add(path || block.id);
		if (failed.has(block.id)) entry.failed += 1;
		kinds.set(kind, entry);
	}
	const parts: string[] = [];
	for (const [kind, entry] of kinds) {
		const count = translate(TENSED[kind].sum, { n: entry.seen.size });
		parts.push(entry.failed > 0 ? count + translate("toolSum.failed", { n: entry.failed }) : count);
	}
	if (others.length > 0)
		parts.push(
			describeRun(
				others.map(({ block }) => ({ toolName: block.name, subject: checklistTool(block.name) ? undefined : subjectFor(block) })),
				true,
			),
		);
	if (thought > 0) parts[thoughtFirst ? "unshift" : "push"](translate("step.thinking", { n: thought }));
	return parts.join(translate("toolSum.separator"));
}
