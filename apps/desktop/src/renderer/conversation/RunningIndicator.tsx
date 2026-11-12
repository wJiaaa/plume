import type { Message } from "@plume/contract";
import type { ToolCallContent } from "@plume/llm/types";
import { StatusSpinner, translate, useCountUp, useNow } from "@plume/ui";
import { memo, useEffect, useRef, useState } from "react";
import { pushSample, type RateSample, rateFrom, trustworthy } from "./live-rate.ts";
import { formatElapsed, formatTokens } from "./running-line.ts";
import { moodFor, phraseFor } from "./thinking-words.ts";
import { ThinkingOrb } from "./ThinkingOrb.tsx";
import { liveTurnMeter } from "./turns.ts";

/** 换一句的间隔：按这一轮已经跑了多久算，不另开一只钟。 */
const PHRASE_MS = 4200;

/**
 * 跑完的工具在这一行上多留多久。大多数调用比这短得多：`read`、`ls` 几十毫秒就完了，不留的话它代表的那个状态一闪而过，
 * 这一行几乎一直在说「什么都没在跑」。两秒读起来是「刚做了这个」，又不会比做这件事本身还长。
 */
const TOOL_HOLD_MS = 2000;

/**
 * 跑着的这一轮在花什么：一句在做什么、跑了多久、这一轮用了多少 token、此刻写得多快。
 *
 * 长的一轮大半是安静的：工具卡片一张张滚过去，看不出是跑了十秒还是十分钟、花了多少。三个点只说「有事在发生」，这一行说是什么。
 */
export const RunningIndicator = memo(function RunningIndicator({
	messages,
	startedAt: callStarts,
	waiting,
	waitingText,
	retrying,
}: {
	/** 转录加上正在写的那条回复。 */
	messages: readonly Message[];
	/** 正在执行的调用开始的时刻。 */
	startedAt: Readonly<Record<string, number>>;
	/** 有一次调用在等人：`approval` 是等批准，`answer` 是等人给答案（提问、表单、计划，`run.request`）。 */
	waiting: "approval" | "answer" | undefined;
	/** 插件给的「在等什么」（`HumanRequest.waiting`）；不给时按 `waiting` 说。 */
	waitingText?: string | undefined;
	/** 连接断了，在等重连。 */
	retrying: boolean;
}) {
	const meter = liveTurnMeter(messages);
	const startedAt = meter?.startedAt ?? null;
	// 四分之一秒一拍，秒数看上去不会跳过一个。
	const now = useNow(startedAt !== null, 250);
	const doing = latestCall(messages, callStarts);
	const writing = writingText(messages);
	const rate = useLiveRate(producedChars(messages), now, startedAt);

	if (waiting) {
		return (
			<div
				data-plume-running=""
				data-plume-mood="waiting"
				data-plume-waiting={waiting}
				className="mt-2 flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-detail whitespace-nowrap text-ink-muted"
			>
				<StatusSpinner size={14} className="text-ink-muted" />
				<span className="plume-fade-in">{waitingText ?? translate(waiting === "answer" ? "running.waitingForAnswer" : "sessionStatus.waiting")}</span>
			</div>
		);
	}

	const elapsed = startedAt === null ? 0 : now - startedAt;
	// 跑完的那个只在 `TOOL_HOLD_MS` 里算数：`now` 一秒走四拍，到点自己就过期了，已经去想下一步的一轮不再说自己在读文件。
	const fresh = doing !== undefined && (doing.finishedAt === undefined || now - doing.finishedAt < TOOL_HOLD_MS);
	const mood = moodFor(fresh ? doing.name : undefined, fresh ? doing.summary : undefined, retrying, writing);
	// 重连时不说话：下面那条连接记录已经在数秒了，这里再说一句是同一件事说两遍。
	const phrase = retrying ? null : phraseFor(mood, Math.floor(elapsed / PHRASE_MS), elapsed);
	return (
		// 8px 而不是正文里的 10px：这一行连上间距和回答底下那一行一样高，答完时两者同一帧一出一进，转录不抖。见 `RunningRow`。
		<div
			data-plume-running=""
			data-plume-mood={mood}
			className="mt-2 flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-detail whitespace-nowrap text-ink-muted"
		>
			{/* 装饰，旁边那句话已经说了这是什么。用 20 而不是缩小的 64：两种尺寸是各自的设计，这一颗是画来放进一行字里的。 */}
			<ThinkingOrb state={mood} size={20} className="shrink-0" />
			{/* 按字记 key：一句淡入、一句走开，不原地换字。 */}
			{phrase && (
				<span key={phrase} className="plume-fade-in">
					{phrase}…
				</span>
			)}
			{startedAt !== null && (
				<>
					{phrase && <span className="text-ink-faint">·</span>}
					<span className="tabular-nums text-ink-faint">{formatElapsed(elapsed)}</span>
				</>
			)}
			<TurnTokens total={meter?.tokens ?? 0} />
			<LiveRate rate={rate} />
		</div>
	);
});

/** 走过去，不跳过去：用量按条落地，一次跳几千。 */
function TurnTokens({ total }: { total: number }) {
	const counted = useCountUp(total);
	if (total <= 0) return null;
	return (
		<>
			<span className="text-ink-faint">·</span>
			{/* 走着的时候 `tabular-nums` 更要紧：字宽每帧在变，整行会跟着左右挪。 */}
			<span className="tabular-nums text-ink-faint">{translate("running.turnTokens", { n: formatTokens(Math.round(counted)) })}</span>
		</>
	);
}

/** 速度双向地走：慢下来和快起来一样真实。走得比总数快一点，刚好接得上采样的节奏。 */
function LiveRate({ rate: reading }: { rate: number }) {
	const rate = useCountUp(reading, 240, { bidirectional: true });
	if (rate < 0.05) return null;
	return (
		<>
			<span className="text-ink-faint">·</span>
			<span className="plume-fade-in tabular-nums text-ink-faint">{rate.toFixed(1)} tok/s</span>
		</>
	);
}

/**
 * 此刻的写入速度，跟着 `now` 一起走：每拍取一次字数作为采样。采样收在 ref 里：它每 250ms 变一次，而这一行本来就每 250ms 重画一次。
 *
 * 读数留在那里直到被新的读数替换，不在没字可写时消失：一轮的大半时间在跑工具，按「此刻有没有在写」来显示就是几十次闪烁。
 * 换了一轮就从头来过。
 */
function useLiveRate(chars: number, now: number, turnStartedAt: number | null): number {
	const samples = useRef<RateSample[]>([]);
	const [held, setHeld] = useState(0);
	useEffect(() => {
		samples.current = [];
		setHeld(0);
	}, [turnStartedAt]);
	useEffect(() => {
		samples.current = pushSample(samples.current, now, chars);
		if (trustworthy(samples.current)) setHeld(rateFrom(samples.current));
	}, [chars, now]);
	return held;
}

/** 正在写的那条回复此刻有多少字：推理和正文都算，工具参数不算——它一次落地，算进来曲线会在那一帧冲高。 */
function producedChars(messages: readonly Message[]): number {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return 0;
	let chars = 0;
	for (const block of last.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "thinking") chars += block.thinking.length;
	}
	return chars;
}

/** 回答正在往外写，而不是在想：最后一块是有字的正文。 */
function writingText(messages: readonly Message[]): boolean {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return false;
	const block = last.content[last.content.length - 1];
	return block?.type === "text" && block.text.length > 0;
}

/**
 * 这一轮最新的调用：在跑的就取开始得最晚的那个；没有在跑的，取最近跑完的那个，带上它跑完的时刻。
 *
 * 刚跑完的和在跑的一样要紧：一次 `read` 几十毫秒就完了，只看在跑的，它代表的状态一闪而过。排着还没轮到的调用不算在跑。
 */
function latestCall(
	messages: readonly Message[],
	startedAt: Readonly<Record<string, number>>,
): { name: string; summary: string | undefined; finishedAt?: number } | undefined {
	const finished = new Map<string, number>();
	let running: { block: ToolCallContent; at: number } | undefined;
	let done: { block: ToolCallContent; at: number } | undefined;
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at]!;
		if (message.role === "user" && !message.synthetic) break;
		if (message.role === "toolResult") finished.set(message.toolCallId, message.timestamp);
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const end = finished.get(block.id);
			const start = startedAt[block.id];
			if (end === undefined && start !== undefined && (!running || start > running.at)) running = { block, at: start };
			else if (end !== undefined && (!done || end > done.at)) done = { block, at: end };
		}
	}
	if (running) return { name: running.block.name, summary: summaryOf(running.block) };
	return done ? { name: done.block.name, summary: summaryOf(done.block), finishedAt: done.at } : undefined;
}

function summaryOf(block: ToolCallContent): string | undefined {
	const { command, description } = block.arguments as { command?: unknown; description?: unknown };
	return typeof command === "string" ? command : typeof description === "string" ? description : undefined;
}
