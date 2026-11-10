/**
 * 一轮从哪条消息开始、算到哪、花了多久和多少 token。
 *
 * 分行（`grouping.ts`）、分块（`turn-blocks.ts`）、回答底下的页脚和底部运行指示问的都是同一件事，换轮的规矩只能有一份：
 * 页脚算的一轮和分行切的一轮不一样，花销就记到了别的回合头上。
 */

import type { AssistantMessage, Message } from "@plume/contract";
import { CARRY_ON_PROMPTS } from "./turn-stop.ts";

export type TurnStats = {
	/**
	 * 这一轮实际跑了多久：墙上的钟，不是请求耗时之和。模型在想、工具在跑，对等在外面的人来说都是同一件事还没做完。
	 * 请求耗时之和只是模型在应答的那段，长命令占掉大半的一轮会报成短短几十秒，运行行读的又是墙钟，回合一结束数字当场掉一截。
	 * 唯一不算进来的是停下来之后那一段，见 `Clock.halted`。
	 */
	durationMs: number;
	/** 其中模型在应答的时间，工具不在里面：「这一轮 13 分钟、模型只答了 2 分钟」本身是句有用的话，放进悬浮说明。 */
	requestMs: number;
	/** 纯出字的时间，tok/s 的分母：去掉了排队、首字延迟和连接往返。 */
	sseDurationMs: number;
	outputTokens: number;
	requestCount: number;
	/** 这一轮从哪一条消息开始（人开口的那条）。 */
	startIndex: number;
};

/**
 * 一轮的表，边读转录边走。可变对象，只在这里和 `runs` 里边走边改；要交出去时 `snapshot` 出一份不可变的 `TurnStats`：
 * 那是要塞进 memo 过的行里的东西，原地改的总数 React 有权当作没变过。
 */
export type Clock = {
	/** 当前这一段从哪儿起表；`null` 是这一轮还没有任何消息。 */
	from: number | null;
	/** 当前这一段已知走到了哪儿。 */
	to: number;
	/** 之前那些结清了的段加起来有多长。 */
	closedMs: number;
	/** 上一条回复是停下的（出错、被人按停），下一条消息来之前这段不算：停在那里等人回来的十分钟是人的时间。 */
	halted: boolean;
	requestMs: number;
	sseDurationMs: number;
	outputTokens: number;
	requestCount: number;
	start: number;
};

/** 一轮还什么都没发生。 */
export function newClock(start = 0): Clock {
	return { from: null, to: 0, closedMs: 0, halted: false, requestMs: 0, sseDurationMs: 0, outputTokens: 0, requestCount: 0, start };
}

/**
 * 一条回复用掉的新 token：输入、写进缓存的和输出。读缓存的不算：那是上一轮已经付过的上下文，算进来一轮里每一步都把整段历史再数一遍。
 */
function freshTokens(usage: Pick<AssistantMessage["usage"], "input" | "output" | "cacheWrite">): number {
	return usage.input + usage.cacheWrite + usage.output;
}

/**
 * 人开口了，新的一轮从这里起。界面替人说的（「继续」、续写的催促）都是 `synthetic`，接着的是上一轮：
 * 停下又按了继续，做的还是同一件事，算成新的一轮，一段没做完的活就被切成两段。
 */
export function opensTurn(message: Message): boolean {
	return message.role === "user" && !message.synthetic;
}

/**
 * 这条回复是停在了这里，还是中途歇一下。
 *
 * `pending` 还在写；`toolUse` 交给了工具，后面还有。其余的——正常停、长度上限、出错、被停下——都是停了。
 */
export function settled(stopReason: AssistantMessage["stopReason"]): boolean {
	return stopReason !== "pending" && stopReason !== "toolUse";
}

/**
 * 一条消息在时间轴上占到哪儿为止。回复的 `timestamp` 是流开始的时刻，加上 `durationMs` 才是它收尾的时刻；工具结果的
 * `timestamp` 本身就是工具跑完的时刻。
 */
function endOf(message: Message): number {
	if (message.role === "assistant" && typeof message.durationMs === "number" && message.durationMs > 0) return message.timestamp + message.durationMs;
	return message.timestamp;
}

/**
 * 把一条消息记进表里。每一条都记，包括画不出行的那些（工具结果、界面替人说的「继续」）：它们占的是真实时间，
 * 一条命令跑四分钟，这一轮就是过了四分钟。取 `max`：工具结果的时刻可以比派它的那条回复的收尾更早。
 */
export function saw(clock: Clock, message: Message): void {
	if (clock.from === null) {
		clock.from = message.timestamp;
		clock.to = message.timestamp;
	} else if (clock.halted) {
		clock.closedMs += Math.max(0, clock.to - clock.from);
		clock.from = message.timestamp;
		clock.to = message.timestamp;
	}
	clock.halted = false;
	clock.to = Math.max(clock.to, endOf(message));
	if (message.role !== "assistant") return;
	const duration = typeof message.durationMs === "number" && message.durationMs > 0 ? message.durationMs : 0;
	const sse = typeof message.sseDurationMs === "number" && message.sseDurationMs > 0 ? message.sseDurationMs : 0;
	const output = message.usage.output > 0 ? message.usage.output : 0;
	clock.requestMs += duration;
	// 没记 sse 的消息退回整条请求的耗时，至少分母不会是 0。
	clock.sseDurationMs += sse || duration;
	clock.outputTokens += output;
	clock.requestCount += 1;
	if (message.stopReason === "error" || message.stopReason === "aborted") clock.halted = true;
}

/** 此刻为止这一轮的账，一份定下来的副本。 */
export function snapshot(clock: Clock): TurnStats {
	const open = clock.from === null ? 0 : Math.max(0, clock.to - clock.from);
	return {
		durationMs: clock.closedMs + open,
		requestMs: clock.requestMs,
		sseDurationMs: clock.sseDurationMs,
		outputTokens: clock.outputTokens,
		requestCount: clock.requestCount,
		startIndex: clock.start,
	};
}

/** 两份账说的是不是同一组数：分组每次重做都给一份新的副本，比引用永远不等。 */
function sameStats(a: TurnStats | undefined, b: TurnStats | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.durationMs === b.durationMs &&
		a.requestMs === b.requestMs &&
		a.sseDurationMs === b.sseDurationMs &&
		a.outputTokens === b.outputTokens &&
		a.requestCount === b.requestCount &&
		a.startIndex === b.startIndex
	);
}

/**
 * `memo` 自己的比较，只是 `turnStats` 按数比。分组每个流式的字都重做一遍，每一行都拿到一份新的 `TurnStats`，按引用比的话
 * 窗口里每一条回复每个字都要重画。页脚读的是数，比的就是数。
 */
export function sameRow<P extends { turnStats?: TurnStats | undefined }>(a: Readonly<P>, b: Readonly<P>): boolean {
	const keys = Object.keys(a) as (keyof P)[];
	if (keys.length !== Object.keys(b).length) return false;
	for (const key of keys) {
		if (key === "turnStats") continue;
		if (!Object.is(a[key], b[key])) return false;
	}
	return sameStats(a.turnStats, b.turnStats);
}

function userText(message: Message): string {
	if (message.role !== "user") return "";
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
}

/**
 * 这句话是在接上一轮停下的活，不是开新的一轮：人自己打了「继续」那句话，而上一条回复确实是停下的（出错、被按停）。
 * 算成新的一轮，一件做了二十分钟、中途断过两次的事只报最后一段的时长和 token。上一轮正常答完了再打这句，是新的吩咐。
 */
export function resumesTurn(messages: readonly Message[], index: number): boolean {
	const message = messages[index];
	if (message?.role !== "user") return false;
	if (!(CARRY_ON_PROMPTS as readonly string[]).includes(userText(message))) return false;
	for (let at = index - 1; at >= 0; at--) {
		const previous = messages[at]!;
		if (previous.role === "toolResult") continue;
		if (previous.role !== "assistant") return false;
		return previous.stopReason === "error" || previous.stopReason === "aborted";
	}
	return false;
}

/**
 * 还在跑的这一轮：`startedAt` 是扣掉停顿之后的起点（`now - startedAt` 就是这一轮跑了多久），`tokens` 是已经收尾的
 * 回复花掉的。和页脚读同一份时钟，这一轮结束时印在回答底下的数字接得上。
 */
export function liveTurnMeter(messages: readonly Message[]): { startedAt: number; tokens: number } | null {
	let start = 0;
	for (let at = messages.length - 1; at >= 0; at--) {
		if (opensTurn(messages[at]!) && !resumesTurn(messages, at)) {
			start = at;
			break;
		}
	}
	const clock = newClock(start);
	let tokens = 0;
	for (let at = start; at < messages.length; at++) {
		const message = messages[at]!;
		saw(clock, message);
		if (message.role === "assistant" && message.stopReason !== "pending") tokens += freshTokens(message.usage);
	}
	return clock.from === null ? null : { startedAt: clock.from - clock.closedMs, tokens };
}
