/**
 * 转录按回合分块：开口那句话之后到下一句之前算一轮，有过程的一轮里同一类连着做的调用合成一步。
 *
 * 和 `grouping.ts` 是两层：那边把消息切成 Run（一句话、一段工具），这里把 Run 按回合收起来。规则性的东西
 * 在数据这一层定，不在渲染时定，才能单独测。
 */

import type { DeliveredReport } from "@plume/contract";
import { runKey, type Call, type Run, type ToolCallBlock } from "./grouping.ts";
import { isPluginGroup, toolCategory } from "./tool-category.ts";
import { opensTurn, settled } from "./turns.ts";

type MessageRun = Extract<Run, { kind: "message" }>;

/**
 * 一轮：开口的那句话之后，到下一句之前的全部。
 *
 * 读下来是「想 → 做 → 说」。有过程的一轮（`work`）整块交给 `TurnWork` 一行行摊开：同一类连着做的调用合成一行
 * （`Step`），中途说的话、最后的回答各占一行，顺序就是发生的顺序。`plain` 是一行原样画的东西：开口的那句话，
 * 或者第一句话之前的标记。
 */
export interface TurnBlock {
	kind: "work" | "plain";
	/** 跑着的一轮刚发出时 `work` 的这一项是空的（见 `turnBlocks` 的 `live`）。 */
	runs: Run[];
	/** 一轮里按画出来的顺序排好的每一行；`plain` 时为空。 */
	items: TurnItem[];
	/** 这一块属于第几轮。「正在做的那一段」问的是这一轮跑完没有，不是这一块是不是最后一块。 */
	turn: number;
}

/** 有过程的一轮里的一行：一段活（`step`），或者原样画的一条（话、插件的卡片、标记）。 */
type TurnItem = { kind: "run"; key: string; run: Run } | { kind: "step"; key: string; step: Step };

/**
 * 一段连着做的活，连同夹在中间、跟在后面的推理——画出来是一行。插在这样一段中间回来的后台命令结果挂在这一段上（`delivery`，
 * 见 `inlineReturn`），不另起一行。
 *
 * 推理落在哪一段就算哪一段，放下就不再挪：挂在一段活后面的推理就是那一段的，下一次调用换了一类也不跟过去——
 * 跟过去的话上一行的「思考 N 次」会少一次，数往回跳。前面还没有活的推理（一轮开头、说完一句话之后）等下一次调用，
 * 跟着它开新的一段；一直没等到调用的自己是一行。
 *
 * `key` 是第一次调用的 id：一段活往后长，它不换。
 */
export interface Step {
	key: string;
	category: string;
	calls: Call[];
	members: StepMember[];
}

export type StepMember = { kind: "call"; call: Call } | { kind: "thinking" | "delivery"; run: MessageRun };

/**
 * 一段活有没有要重画的东西——`WorkStep` 的 memo 比较。分块每次转录变了都整个重做，不比内容的话，
 * 一个工具结果落地，可见的每一段活都要重画一遍。
 *
 * 调用比 `block` 本身而不是只比 id：那一行的话读的是参数，参数还在流进来时 id 不变、block 换了。推理和送回来的结果比消息本身。
 */
export function sameStep(before: Step, after: Step): boolean {
	if (before === after) return true;
	if (before.key !== after.key || before.category !== after.category || before.members.length !== after.members.length) return false;
	return before.members.every((member, i) => {
		const other = after.members[i]!;
		if (member.kind === "call" || other.kind === "call") {
			return member.kind === "call" && other.kind === "call" && member.call.block === other.call.block && member.call.stopReason === other.call.stopReason;
		}
		return member.kind === other.kind && member.run.message === other.run.message && member.run.upTo === other.run.upTo && member.run.from === other.run.from;
	});
}

/** 一行只有推理的回复：想完以后只调了工具。没有推理的行（失败唯一留下的那一行空行）不算。 */
function thinkingOnly(run: MessageRun): boolean {
	if (run.message.role !== "assistant") return false;
	const own = run.message.content.slice(run.from ?? 0, run.upTo);
	return own.some((block) => block.type === "thinking") && !own.some((block) => block.type === "text" && block.text.trim());
}

/**
 * 不显示推理时的转录：只有推理的行拿掉。
 *
 * 在 Run 这一层拿，不在画的时候藏：藏起来的行仍然会让只想不做的一轮算成有过程、让一段活读成「思考 2 次 · 读取文件」，
 * 点开却什么也没有。一轮停在一段推理上（想到一半被停下、想完没说话），那一行是这一轮的最后一行，留个壳：推理切掉，行还在。
 */
export function withoutThinking(list: Run[]): Run[] {
	const out: Run[] = [];
	for (const run of list) {
		if (run.kind !== "message" || !thinkingOnly(run)) out.push(run);
		else if (!run.lead && run.message.role === "assistant" && settled(run.message.stopReason)) out.push({ ...run, from: run.upTo });
	}
	return out;
}

function reasoning(run: Run): run is MessageRun {
	return run.kind === "message" && thinkingOnly(run);
}

/** 一条 run 是不是「人开的口」：新一轮从这里开始。 */
export function opensBlock(run: Run): boolean {
	return run.kind === "message" && opensTurn(run.message);
}

/** 一行推理是不是还在写：后面什么都还没有。写着的推理落在一段活的末尾时，那一行说的是它，见 `WorkStep`。 */
export function thinkingLive(run: MessageRun): boolean {
	return run.message.role === "assistant" && run.message.stopReason === "pending" && run.upTo === run.message.content.length;
}

/**
 * 互相接成一段的几类：读、跑命令、改文件，加上插件起名的那几类（`ToolLine.group`：操作网页、抓取和搜索网络、和别的会话往来、
 * 加载技能）。边改边在页面上验本来就是一件事；查资料时抓一页、在浏览器里点几下、再搜一次也是。
 */
const MERGES = new Set(["explore", "terminal", "files"]);

/** 这一类是不是读、跑、改、插件起名的那几类活：它们互相接成一段，后台命令的结果挂得上来（`inlineReturn`）。 */
function merges(category: string): boolean {
	return MERGES.has(category) || isPluginGroup(category);
}

/**
 * MCP 的工具不论哪个服务器都算一类。名字是 `mcp__<服务器>__<工具>`，超长的会截短加哈希，从名字里拆不出可靠的服务器。
 */
function kindOf(category: string): string {
	return category.startsWith("mcp__") ? "mcp" : category;
}

/**
 * 更新清单是这段活的记账，不是一件单独的事：它跟 `MERGES` 那几类接成一段，不自己占一行——勾到哪一项清单上看得到，
 * 转录里每勾一次就横一行，一段连着的活被切成好几截。
 */
const TODO = "todo_write";

/** 这次调用接不接在这一段后面：`MERGES` 里的几类和清单互相接，其余的只和同一种接（MCP 不分服务器）。 */
function joins(step: Step, category: string): boolean {
	const work = (one: string) => merges(one) || one === TODO;
	return (work(step.category) && work(category)) || kindOf(step.category) === kindOf(category);
}

/**
 * 插在一轮中间、每份都标着 `inline` 的送达（后台命令的结果这样标，由交它的插件定，见 `DeliveredReport.inline`）。
 *
 * 回来时正在做的是 `MERGES` 那一段，就挂在它上面：放到后台的那次 `bash` 当场就以「已放到后台」跑完了，结果单独一行等于
 * 把同一条命令说两遍，还把这一段切成两截。别的时候（刚说完话、在清单这类调用后面、这一轮已经停了）照旧自己一行：挂到问人、
 * 清单那一行上就成了不相干的两件事，等下一次调用再挂又会先冒一行再收走。不标的（子会话交回的结果、定时唤醒）、别的会话的信
 * 不在此列：接下来那段话是就着它们说的。
 */
function inlineReturn(run: Run): run is MessageRun {
	if (run.kind !== "message" || run.message.role !== "user" || !run.message.synthetic || run.message.peer?.length) return false;
	const reports = run.message.delivery ?? [];
	return reports.length > 0 && reports.every((report) => report.inline === true);
}

/** 只带 `inline` 结果的那条送达里的几条结果；别的 run 是 `null`。 */
function inlineOf(run: Run): DeliveredReport[] | null {
	return inlineReturn(run) && run.message.role === "user" ? (run.message.delivery ?? []) : null;
}

/** 这条送达再添上几条结果。是一份新的 run：原来那条还是转录里的那条。 */
function withDelivery(run: Run, more: DeliveredReport[]): Run {
	if (run.kind !== "message" || run.message.role !== "user") return run;
	return { ...run, message: { ...run.message, delivery: [...(run.message.delivery ?? []), ...more] } };
}

/**
 * 这一段活所在的那一轮还在往下做：最后一条回复停在交给工具上。停在别处（被按停、出错、想完没说话就收了尾）时送回来的结果
 * 是把空闲的会话叫醒了，不是插在这段活中间。
 */
function stillWorking(step: Step): boolean {
	for (let at = step.members.length - 1; at >= 0; at--) {
		const member = step.members[at]!;
		if (member.kind === "call") return !settled(member.call.stopReason);
		if (member.kind === "thinking") return member.run.message.role === "assistant" && !settled(member.run.message.stopReason);
	}
	return false;
}

/**
 * `live`：最后一轮还在跑。人开的这一轮从发出就算有过程，先占住 `work` 的位置。
 *
 * 一轮要等到第一次推理或工具调用才算有过程的话，在那之前说的第一句话是 `plain`，有了过程就被挪进 `work` 重挂一遍；
 * 有的模型根本不把推理流出来，第一次调用之前什么也问不出。跑完了也不退回 `plain`：退回去，那句回答在收尾那一帧换了父元素，
 * 整段卸掉重挂、再演一遍进场。
 */
export function turnBlocks(list: Run[], live = false): TurnBlock[] {
	return blocksFrom(list, live).blocks;
}

/** 一轮开头的那一行在 `list` 里的位置，和它之前已经分出来的块数、轮数：从这里接着分，前面的块不变。 */
export interface BlockStart {
	at: number;
	blocks: number;
	turn: number;
}

/**
 * `turnBlocks` 的本体，可以从某一轮开头接着分（`from`，`prefix` 是上一次分出来的块）。
 *
 * 块只在开一轮的那一行处断开，一块里有什么只看它自己那一段，所以那一行之前的块和后面怎么长无关——`transcript-shape.ts` 据此每拍
 * 只重分最后一轮。`starts` 记下这一次走过的每一轮开头。
 */
export function blocksFrom(list: Run[], live = false, from?: BlockStart, prefix: TurnBlock[] = []): { blocks: TurnBlock[]; starts: BlockStart[] } {
	const out: TurnBlock[] = from ? prefix.slice(0, from.blocks) : [];
	const starts: BlockStart[] = [];
	let turn = from?.turn ?? 0;
	// 从某一轮开头接着分时，那一行马上就会把它设上。
	let asked = false;
	const plain = (run: Run) => out.push({ kind: "plain", runs: [run], items: [], turn });

	let at = from?.at ?? 0;
	while (at < list.length) {
		if (opensBlock(list[at]!)) {
			starts.push({ at, blocks: out.length, turn });
			asked = true;
			turn++;
			plain(list[at++]!);
			continue;
		}
		let end = at;
		while (end < list.length && !opensBlock(list[end]!)) end++;
		const body = list.slice(at, end);
		if (asked || body.some((run) => run.kind === "tools" || reasoning(run))) out.push({ kind: "work", runs: body, items: itemsOf(body), turn });
		else for (const run of body) plain(run);
		at = end;
	}
	if (live && asked && list.length > 0 && opensBlock(list[list.length - 1]!)) out.push({ kind: "work", runs: [], items: [], turn });
	return { blocks: out, starts };
}

/**
 * 一条 bash 的命令还在生成：先不画，命令到齐时直接出现在它该在的那一段里。
 *
 * 归哪一类要看命令，而参数没生成完时 `arguments` 是空的。按空参数先算终端，一条 `sed -n` 会先在底下冒一行、
 * 几百毫秒后再并进上面的探索。代价是生成一条长命令的那几秒里，这条调用还不在转录上，底部运行指示的计时照走。
 */
function unclassified(call: Call): boolean {
	return call.block.name === "bash" && call.stopReason === "pending" && typeof call.block.arguments?.command !== "string";
}

function itemsOf(body: Run[]): TurnItem[] {
	const items: TurnItem[] = [];
	// 断言而不是标注：循环里 TS 把它收窄成初值 `null`，看不见循环后半段的赋值。
	let step = null as Step | null;
	// 前面还没有活时想过的推理：等下一次调用来开一段。
	let thoughts: MessageRun[] = [];
	const settle = () => {
		for (const run of thoughts) items.push({ kind: "run", key: runKey(run), run });
		thoughts = [];
	};
	for (const run of body) {
		if (run.kind === "tools" && !run.own) {
			for (const call of run.calls) {
				if (unclassified(call)) continue;
				const category = toolCategory(call.block.name, call.block.arguments);
				const before = thoughts.map((thought) => ({ kind: "thinking" as const, run: thought }));
				thoughts = [];
				if (step && joins(step, category)) {
					// 清单开的头、接着来了活：这一段从此是那一类活，后台命令的结果也挂得上来（`inlineReturn`）。
					if (step.category === TODO) step.category = category;
					step.calls.push(call);
					step.members.push(...before, { kind: "call", call });
					continue;
				}
				step = { key: `step-${call.block.id}`, category, calls: [call], members: [...before, { kind: "call", call }] };
				items.push({ kind: "step", key: step.key, step });
			}
			continue;
		}
		if (reasoning(run)) {
			if (step) step.members.push({ kind: "thinking", run });
			else thoughts.push(run);
			continue;
		}
		if (step && merges(step.category) && stillWorking(step) && inlineReturn(run)) {
			step.members.push({ kind: "delivery", run });
			continue;
		}
		settle();
		step = null;
		const last = items[items.length - 1];
		// 挨着自己一行的 `inline` 结果并成一行（交它的插件一次拿到几份，「N 个后台命令结束」），key 跟第一条走。
		const more = inlineOf(run);
		if (more && last?.kind === "run" && inlineOf(last.run)) {
			last.run = withDelivery(last.run, more);
			continue;
		}
		items.push({ kind: "run", key: runKey(run), run });
	}
	settle();
	return items;
}

/** 一次 `bash_output` 查的是哪个后台任务。停掉它的那一次不是在看输出，不和查看合在一起。 */
export function polledJob(block: ToolCallBlock): string | undefined {
	if (block.name !== "bash_output") return undefined;
	const { id, kill } = (block.arguments ?? {}) as { id?: unknown; kill?: unknown };
	return typeof id === "string" && kill !== true ? id : undefined;
}

/** 一段活展开后挂在竖线上的一行：一次调用、一段推理、一份送回来的结果，或者连着查同一个后台任务的几次输出。 */
export type StepLine = StepMember | { kind: "polls"; calls: Call[] };

/**
 * 连着查同一个后台任务的几次合成一行：九次查看不再是九行「查看输出」。
 *
 * 只合紧挨着的：中间隔了推理、别的调用，就是模型在两次查看之间做了别的事，那是两件事。
 */
export function foldPolls(members: StepMember[]): StepLine[] {
	const lines: StepLine[] = [];
	for (const member of members) {
		const job = member.kind === "call" ? polledJob(member.call.block) : undefined;
		const last = lines[lines.length - 1];
		const before = last?.kind === "polls" ? last.calls : last?.kind === "call" ? [last.call] : [];
		if (job && member.kind === "call" && before.length > 0 && polledJob(before[0]!.block) === job) {
			lines[lines.length - 1] = { kind: "polls", calls: [...before, member.call] };
		} else lines.push(member);
	}
	return lines;
}

/**
 * 几次查看读到的输出，接成一段。
 *
 * 每一次 `bash_output` 只给上次之后新打出来的，按顺序接起来就是这段时间里的全部，不重复。去掉的是给模型看的那两样：
 * 开头那行带任务 id 的状态（`[job … running]`），和没有新输出时的那句占位。
 */
export function pollOutput(texts: string[]): string {
	return texts.map((text) => text.replace(/^\[job [^\]\n]*\]\n?/, "").replace(/^\(no new output\)/, "")).join("");
}
