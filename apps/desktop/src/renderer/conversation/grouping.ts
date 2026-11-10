/**
 * 转录的一行从哪里起、到哪里止，只看数据决定。
 *
 * 转录不是消息列表。一段工具活不管跨了几条消息都是一行，而且从第一次调用到最后一次都得是**同一**行：
 * 等模型说完话才成形的组，会在一轮中间冒出来、把下面的东西往下推，再把内容交给上面那一行然后消失——
 * agent 干活时转录一直在动，就是这么来的。
 *
 * 所以这里的规则从不问一条消息写完了没有，只读已经到了的东西，而已经到了的东西只会变多。
 */

import type { AssistantMessage, CompactionRun, Hiccup, Message } from "@plume/contract";
import { isPlanTick } from "./turn-stop.ts";
import { type Clock, newClock, opensTurn, resumesTurn, saw, settled, snapshot, type TurnStats } from "./turns.ts";

export type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/** 一次调用，连同发出它的那条消息此刻的状态：调用只在它那一轮还在跑时才算活着。 */
export type Call = { block: ToolCallBlock; stopReason: AssistantMessage["stopReason"] };

export type Run =
	/** 连接抖了一下，画在它抖的那个位置上（`Hiccup.at`）。 */
	| { kind: "hiccup"; hiccup: Hiccup }
	/** 一次压缩，画在它开始时的位置上（`CompactionRun.at`）：自动的进度和结果，人敲的 `/compact` 和它的结果。 */
	| { kind: "compaction"; compaction: CompactionRun }
	/**
	 * 从这里起换了一个模型回答。按回复上记的模型认，不按「切换」那个动作认：只在菜单里换一下、一句没发，转录里什么也没发生。
	 * `at` 是它插在哪一条消息之前。
	 */
	| { kind: "model"; at: number; from: ModelUsed; to: ModelUsed }
	/**
	 * 一条消息，以及其中归这一行的那一段。
	 *
	 * `upTo` 是内容块的个数：从那里到末尾都是工具活，归下面那一段，不归这句话。消息末尾没有调用时就是整条。
	 *
	 * `from` 是另一头：回复开头的推理在上面单独成了一行时，正文这一行从它后面起，同一段推理不画两遍。两行是
	 * 同一条消息，所以有 `lead`：开头那行只是引子，时间、复制那一行属于后面那句话。
	 *
	 * `turnStats` 跟着回复行走，和分组一起算：在画的时候算，每次渲染都是新对象，memo 过的行每次都比出不等。
	 *
	 * `closes` 标在一轮里最后一条落定的回复上：时间、耗时、复制那一行只属于它。一条回答常常是好几条回复——说要做什么、调工具、
	 * 再说下一件——每条都挂一行的话，一句回答底下盖了四次时间。
	 *
	 * `newest` 标在转录最后一轮的 `closes` 上。会话还在跑时它只是「到目前为止」的最后一句，页脚要等跑完才知道该落在谁身上。
	 *
	 * `pauses` 标在一轮中间说完了的一句上：它说完时一份后台结果正好送到、插进了这一轮，这一轮于是没在它这里收尾。对读的人
	 * 它和收尾那句一样是说完了的一段，所以也有时间和复制，只是没有整轮的统计。送达那一行自己不留空白，和上面那句话之间的
	 * 空白就是这一行页脚。
	 *
	 * `trailer` 是收尾那句的页脚单独成的一行，接在这一轮最后一行后面：收尾那句后面还跟着这一轮的活时（被停下的回复末尾那几个
	 * 没执行的调用），页脚留在话底下，那几行就落到了「这一轮已经结束」的下面。它和那句话是同一段，只画页脚，不画正文。
	 */
	| {
			kind: "message";
			message: Message;
			index: number;
			upTo: number;
			from?: number;
			lead?: true;
			key?: string;
			turnStats?: TurnStats;
			closes?: true;
			newest?: true;
			pauses?: true;
			trailer?: true;
	  }
	/**
	 * 一段工具活。`own`：插件给这个工具登记了自己的卡片，整张卡单独一行，不和别的调用合成一段（见
	 * `turn-blocks.ts`）——卡片长什么样是插件的事，合进一行就看不见了。
	 */
	| { kind: "tools"; calls: Call[]; own?: true };

/** 一条回复是谁答的。同一个模型名挂在两家服务商底下是两个模型，所以两样一起比。 */
export type ModelUsed = { provider: string; model: string };

/**
 * 一行的身份，内容变多也不变。
 *
 * 不能用展示数组的下标或流式文本的长度：重复的 key 会让 React 留下回收不掉的旧节点，表现为重复的思考行、
 * 滚动范围变长和跨会话的残留。每一种 `Run` 都要有分支。
 */
export function runKey(run: Run): string {
	if (run.kind === "hiccup") return `hiccup-${run.hiccup.id}`;
	if (run.kind === "compaction") return `compaction-${run.compaction.id}`;
	if (run.kind === "model") return `model-${run.at}`;
	if (run.kind === "tools") return `tools-${run.calls[0]?.block.id ?? "empty"}`;
	// 写着的回复和写完落盘的那条时间戳、位置相同：换过来时行不卸掉重挂。
	return run.key ?? `${run.message.role}-${run.message.timestamp}-${run.index}`;
}

/**
 * 开头有几块是推理——思考行的全部内容。
 *
 * 从头数，而不是「第一次调用之前的全部」：一条先想后做的回复两种数法一样，一条已经开口说过话的回复就不一样，
 * 宽松的那种会把正文也算进思考行。
 */
function leadingThinking(content: AssistantMessage["content"]): number {
	let count = 0;
	for (const block of content) {
		if (block.type !== "thinking") break;
		count++;
	}
	return count;
}

/** 开头那段推理已经有字了没有：推理块先宣布、字后到，空的一行只是一块空白，下一刻才被填上。 */
function written(content: AssistantMessage["content"], think: number): boolean {
	for (let at = 0; at < think; at++) {
		const block = content[at];
		if (block?.type === "thinking" && block.thinking.length > 0) return true;
	}
	return false;
}

/**
 * 回复末尾那串调用从哪里开始——之前的都是这条回复自己的行。
 *
 * 从末尾往回数，不从最后一句话往后数：模型说完话又回去想的时候，从话往后数会让那段收尾的推理落在每一行之外，
 * 哪儿都画不出来。
 */
function beforeTrailingCalls(content: AssistantMessage["content"]): number {
	let end = content.length;
	while (end > 0 && content[end - 1]?.type === "toolCall") end--;
	return end;
}

type MessageRun = Extract<Run, { kind: "message" }>;

/** 这一行有话：时间和复制那一行只挂在有话的回复下面。 */
function spoke(run: MessageRun): boolean {
	return run.message.content.slice(run.from ?? 0, run.upTo).some((block) => block.type === "text" && block.text.trim() !== "");
}

/**
 * 消息列表，切成行。
 *
 * 调用跨消息合并，不只在一条消息里合：调一次工具、读结果、再调下一个，每次都是一条新的回复，只在一条里合
 * 抓得住并行的一批、抓不住先后的一串——而后者才是常见的。一条带话的回复结束这一段：那是模型在说值得读的东西。
 *
 * `settledCount` 是已经落盘的消息有几条，后面跟着的是还在写的那条回复。连接岔子、压缩分隔按它们发生时的消息条数
 * 插进去；数到末尾的那些排在最后，包括还在写的回复后面——它们说的正是此刻。
 */
export function runs(messages: readonly Message[], options: RunsOptions = {}): Run[] {
	return walkRuns(messages, options).rows;
}

export interface RunsOptions {
	settledCount?: number;
	hiccups?: readonly Hiccup[];
	compactionRuns?: readonly CompactionRun[];
	ownCard?: (toolName: string) => boolean;
}

/** 插进转录的一个标记，连同它来自的那条压缩记录或连接记录：接着走时按它认前面消费掉的是不是同一批。 */
export type RunMark = { at: number; source: CompactionRun | Hiccup; run: Run };

/** 压缩和连接记录按位置排好，位置相同的压缩在前。 */
export function runMarks(options: Pick<RunsOptions, "hiccups" | "compactionRuns">): RunMark[] {
	return [
		...(options.compactionRuns ?? []).map((compaction) => ({ at: compaction.at, source: compaction, run: { kind: "compaction", compaction } as const })),
		...(options.hiccups ?? []).map((hiccup) => ({ at: hiccup.at, source: hiccup, run: { kind: "hiccup", hiccup } as const })),
	].sort((a, b) => a.at - b.at);
}

/**
 * 走到某一轮开头那一刻的全部状态：从这里接着往下走，得到的行和从头走一遍逐个相同。
 *
 * 流式时只有最后一轮在变，而从头分组一遍是整个会话的量，每拍一次。`transcript-shape.ts` 在最后一轮开头记一个，之后每拍从它接着走。
 * `at` 处的消息开一轮（`opensTurn` 且不是「继续」），前面那一轮的页脚已经落定；`rows` 是那之前的全部行，此后谁也不再改它们。
 */
export interface RunsCheckpoint {
	at: number;
	rows: Run[];
	/** 走到这里时已经插进去的标记。 */
	marks: RunMark[];
	used: ModelUsed | null;
}

/**
 * `runs` 的本体，可以从一个检查点接着走（`from`），也可以在走过某一轮开头时留一个（`mark`）。`marks` 由调用方排好传进来
 * （`runMarks`），接着走的时候拿同一份比。
 */
export function walkRuns(
	messages: readonly Message[],
	options: RunsOptions & { marks?: RunMark[]; from?: RunsCheckpoint | undefined; mark?: number | undefined } = {},
): { rows: Run[]; mark?: RunsCheckpoint } {
	const resume = options.from;
	const start = resume?.at ?? 0;
	const settledCount = options.settledCount ?? messages.length;
	const ownCard = options.ownCard ?? (() => false);
	const out: Run[] = resume ? resume.rows.slice() : [];
	const marks = options.marks ?? runMarks(options);
	let nextMark = resume?.marks.length ?? 0;
	let checkpoint: RunsCheckpoint | undefined;

	/** 接到最后一段活上，或者另起一段。插件自己画的那张卡单独一段。 */
	const work = (calls: Call[]) => {
		for (const call of calls) {
			const last = out[out.length - 1];
			if (ownCard(call.block.name)) out.push({ kind: "tools", calls: [call], own: true });
			else if (last?.kind === "tools" && !last.own) last.calls.push(call);
			else out.push({ kind: "tools", calls: [call] });
		}
	};

	/*
	 * 上一条回复是哪个模型答的。换了就落一条分隔：换在两轮之间的，落在开这一轮的那句话上面——人是先换模型再开口的；
	 * 换在一轮当中的（跑着的时候换，下一步才生效），落在第一条新回复上面。
	 */
	let used: ModelUsed | null = resume?.used ?? null;
	const answeredBy = (message: AssistantMessage, at: number) => {
		// 读不出来的那一行（`intact`）没记是谁答的，不算换了模型。
		if (!message.provider || !message.model) return;
		const next = { provider: message.provider, model: message.model };
		if (used && (used.provider !== next.provider || used.model !== next.model)) out.push({ kind: "model", at, from: used, to: next });
		used = next;
	};

	/*
	 * 这一轮到目前为止最后一条落定的回复行，轮换了（或者走完了）才把 `closes` 落到它身上。不看紧跟在后面的是什么：
	 * 只问「这一轮最后一句是哪条」，续跑的催促、「继续」插进来是什么都无所谓。
	 */
	// 断言而不是标注：它只在闭包里被赋值，标注的话 TS 在循环里把它收窄成初值 `null`。
	let closer = null as MessageRun | null;
	/**
	 * `ended`：这一轮确实收了尾。还在跑的那一轮谁是最后一行还没定，页脚留在原处——它跑着时本来就不画（`Run.newest`），
	 * 先拆出一行只会是一行空的。交回挂上 `closes` 的那一行，最后一轮要在它上面再标一个 `newest`。
	 */
	const closeTurn = (ended = true) => {
		let closing = closer;
		if (closer && ended && spoke(closer) && out.slice(out.lastIndexOf(closer) + 1).some((run) => run.kind === "tools")) {
			const { message, index, upTo, from } = closer;
			// 页脚整个搬下去，话底下不留：一句中途的 `pauses` 也是页脚，留着就是同一轮两个。
			delete closer.pauses;
			// 账也记到这一轮最后，和页脚站的位置说同一件事：话后面那段活的时间在里面。
			closing = {
				kind: "message",
				message,
				index,
				upTo,
				...(from === undefined ? {} : { from }),
				turnStats: snapshot(clock),
				closes: true,
				trailer: true,
				key: `trailer-${message.timestamp}-${index}`,
			};
			out.push(closing);
		} else if (closer) closer.closes = true;
		closer = null;
		return closing;
	};
	// 还在写的、说完要接着调工具的都不是一轮的最后一句；只开头推理的那一行也不是，页脚归后面的正文。
	const consider = (row: MessageRun) => {
		if (row.lead || row.message.role !== "assistant" || !settled(row.message.stopReason)) return;
		closer = row;
	};
	// 这一轮到此为止花了多少，跟着转录往下走：一遍走完，不用每一行往回扫一次。
	let clock: Clock = newClock(start);

	for (let index = start; index < messages.length; index++) {
		const message = messages[index]!;
		// 先于标记换轮：上一轮的页脚可能要单独接在它最后一行后面，排到标记后面就落进了下一轮。
		if (opensTurn(message) && !resumesTurn(messages, index)) {
			closeTurn();
			clock = newClock(index);
			if (index === options.mark && index !== start) checkpoint = { at: index, rows: out.slice(), marks: marks.slice(0, nextMark), used };
		}
		while (index < settledCount && nextMark < marks.length && marks[nextMark]!.at <= index) out.push(marks[nextMark++]!.run);
		// 每一条都记进表里，包括下面画不出行的那几种：它们不出现在转录上，可是占的时间是真的。
		saw(clock, message);

		// 工具结果不是转录里的一行，是卡片的内容。把它们当成普通消息，每两次调用之间都隔着一条，七次调用的一段就成了七段。
		if (message.role === "toolResult") continue;
		// 界面替人说的话（「继续」、续写的催促）不画，也不该把它两边的活切成两段：那是一段没断过的工作。送达除外，见下面。
		if (message.role === "user") {
			if (!opensTurn(message)) {
				// 后台送回来的结果、别的会话的信画成一行（`DeliveryRow`、`PeerLetterRow`）：不画，读的人看到的是 agent 说完一段话、隔了一阵又自己动了起来。
				// 送达紧挨着一句说完了的话：那句话就是一段的结尾。
				if (message.delivery?.length && closer && out.at(-1) === closer && spoke(closer)) closer.pauses = true;
				if (message.delivery?.length || message.peer?.length) out.push({ kind: "message", message, index, upTo: message.content.length });
				continue;
			}
			// 这一轮的第一条回复。下一句人话先到说明这句没得到回答，那就不归它管。
			for (let ahead = index + 1; ahead < messages.length; ahead++) {
				const next = messages[ahead]!;
				if (next.role === "assistant") answeredBy(next, index);
				if (next.role === "assistant" || opensTurn(next)) break;
			}
			out.push({ kind: "message", message, index, upTo: message.content.length });
			continue;
		}

		/*
		 * 回答之后补勾清单的那一次 todo_write 不画：回答和它的页脚已经是这一轮的结尾，再在下面画一行工作，
		 * 读起来像回答完又动手干了点什么。勾的结果清单卡片上看得到。时间上面 `saw` 已经记了。
		 */
		if (isPlanTick(messages, index)) continue;

		answeredBy(message, index);
		const think = leadingThinking(message.content);
		const own = beforeTrailingCalls(message.content);
		const calls: Call[] = [];
		for (const block of message.content.slice(own)) if (block.type === "toolCall") calls.push({ block, stopReason: message.stopReason });

		/*
		 * 回复开头的推理在它写下的位置单独一行：一轮读下来是想、做、想、做，正是它跑的样子。
		 * 推进来的这一行也正好结束上一段活：`work` 只接最后一行，一行推理落在两批调用之间，就把它们分成两段。
		 */
		if (think > 0 && written(message.content, think)) {
			const row: MessageRun = {
				kind: "message",
				message,
				index,
				upTo: think,
				// 只在下面还有这条回复自己的一行时才是引子；否则这一行就是整条，页脚也归它——推理途中断线正是这种。
				...(own > think ? { lead: true as const } : {}),
				key: `thinking-${message.timestamp}-${index}`,
			};
			out.push(row);
			consider(row);
		}

		/*
		 * 插件自己画卡的调用夹在回复的话中间时，照样单独一行：把回复从它那里切开，前面那截是引子，最后一截是这条回复。
		 */
		let from = think;
		for (let at = think; at < own; at++) {
			const block = message.content[at];
			if (block?.type !== "toolCall" || !ownCard(block.name)) continue;
			if (at > from) out.push({ kind: "message", message, index, upTo: at, from, lead: true, key: `part-${at}-${message.timestamp}-${index}` });
			work([{ block, stopReason: message.stopReason }]);
			from = at + 1;
		}
		if (own > from) {
			const row: MessageRun = { kind: "message", message, index, upTo: own, ...(from > 0 ? { from } : {}), turnStats: snapshot(clock) };
			out.push(row);
			consider(row);
		} else if (think === 0 && calls.length === 0 && message.stopReason !== "pending") {
			// 没想、没说、没做，这一轮却结束了：一次什么都没产出的失败。这是它唯一能露面的机会。
			const row: MessageRun = { kind: "message", message, index, upTo: message.content.length, turnStats: snapshot(clock) };
			out.push(row);
			consider(row);
		}

		work(calls);
	}
	const latest = messages.findLast((message) => message.role === "assistant");
	const newest = closeTurn(!(latest?.role === "assistant" && !settled(latest.stopReason)));
	if (newest) newest.newest = true;
	while (nextMark < marks.length) out.push(marks[nextMark++]!.run);
	return checkpoint ? { rows: out, mark: checkpoint } : { rows: out };
}
