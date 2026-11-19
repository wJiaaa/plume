import type { Message } from "@plume/contract";
import type { ToolCallContent } from "@plume/llm/types";
import { GLIDE, RollWords, StatusSpinner, translate, useCountUp, useHeldKey, useI18n, useNow, useTickedAnimations } from "@plume/ui";
import { memo, type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import { callLabel, describeRunning, labelText } from "./call-words.ts";
import type { ToolCallBlock } from "./grouping.ts";
import { estimateTokens, pushSample, type RateSample, rateFrom, trustworthy } from "./live-rate.ts";
import { formatElapsed, formatTokens } from "./running-line.ts";
import { StreamTrace } from "./StreamTrace.tsx";
import { SwapText } from "./SwapText.tsx";
import { moodFor, phraseFor } from "./thinking-words.ts";
import { ThinkingOrb } from "./ThinkingOrb.tsx";
import { liveTurnMeter } from "./turns.ts";
import { useTranscript } from "./view-state.ts";

/** 换一句的间隔：按这一轮已经跑了多久算，不另开一只钟。 */
const PHRASE_MS = 4200;

/**
 * 跑完的工具在这一行上多留多久。大多数调用比这短得多：`read`、`ls` 几十毫秒就完了，不留的话它代表的那个状态一闪而过，
 * 这一行几乎一直在说「什么都没在跑」。两秒读起来是「刚做了这个」，又不会比做这件事本身还长。
 */
const TOOL_HOLD_MS = 2000;

/**
 * 模型这么久一个字没回，就显示「静候下文」。正常写的时候句读之间也会停一两秒，短了会在每个停顿上报一次；
 * 再长，人已经开始怀疑卡住了。
 */
const STALL_MS = 4000;

/** 等第一个字到这么久才说「静候回音」、断流到这么久换成警示色：多半不是在想，是请求出了状况。 */
const SILENT_MS = 15_000;

/**
 * 模型这一侧此刻在哪一步。工具在跑（`tool`）和等重连（`retrying`）时不论有没有字：命令跑两分钟一个字不出是正常的。
 *
 * - `awaiting`  请求发出去了，这一步还没收到一个字
 * - `streaming` 字在来（推理、正文、工具参数都算）
 * - `stalled`   来过字，`STALL_MS` 没再来
 */
type Stage = "retrying" | "tool" | "awaiting" | "streaming" | "stalled";

/**
 * 跑着的这一轮在花什么：一句在做什么、跑了多久、这一轮写出了多少 token、此刻写得多快，和最近几秒字到达的样子（`StreamTrace`）。
 *
 * 长的一轮大半是安静的：工具卡片一张张滚过去，看不出是跑了十秒还是十分钟、花了多少。三个点只说「有事在发生」，这一行说是什么。
 * 有调用在跑时开头直接说在跑的那一次（几个并行就说它们一共在做什么，`useRunningFact`）：工具组收着时标题只说总数，
 * 此刻在跑哪个，这一行是唯一说出来的地方。没有调用在跑时说一句随意的闲话（`thinking-words.ts`）。
 *
 * 推理默认不画，模型想的那几十秒这一行就是唯一的动静，而思考球、换词、秒数都按钟点走，模型一个字不回也照样转。所以把
 * 「还没开口」「在写」「停住了」分开说（`Stage`），读数和心电图跟着字走：卡住时 tok/s 收起、心电图是平线、行尾直说几秒没有新输出。开头那句话不变。
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
	// 订阅界面语言：memo 挡住了上层的重画，换语言时这一块里经 `translate` 说的字（工具行、运行行）要跟着换。
	useI18n();
	const meter = liveTurnMeter(messages);
	const startedAt = meter?.startedAt ?? null;
	// 四分之一秒一拍，秒数看上去不会跳过一个。
	const now = useNow(startedAt !== null, 250);
	const doing = latestCall(messages, callStarts);
	const fact = useRunningFact(messages, callStarts, useTranscript().cwd);
	const writing = writingText(messages);
	const rate = useLiveRate(producedChars(messages), now, startedAt);
	const output = draftOutput(messages);
	// 有进展就重新计：多了一条消息（上一步收尾、工具出了结果）或者草稿长了。
	const { quiet, seen } = useQuietFor(`${messages.length}:${output}`, now);

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
	const busy = doing !== undefined && doing.finishedAt === undefined;
	// 刚跑完的工具在还没开口的那两秒里照旧算「工具」，同 `TOOL_HOLD_MS`。
	const stage: Stage = retrying
		? "retrying"
		: busy || (fresh && output === 0)
			? "tool"
			: output === 0
				? "awaiting"
				: quiet >= STALL_MS
					? "stalled"
					: "streaming";
	const mood = moodFor(fresh ? doing.name : undefined, fresh ? doing.summary : undefined, retrying, writing);
	// 重连时不说话：下面那条连接记录已经在数秒了，这里再说一句是同一件事说两遍。有调用在跑时说它，没有时说闲话。
	const idle = phraseFor(mood, Math.floor(elapsed / PHRASE_MS), elapsed);
	const phrase: Phrase | null = retrying ? null : (fact ?? { key: `mood:${idle}`, text: `${idle}…`, glide: false });
	const status = statusFor(stage, quiet);
	// 这一轮模型写出的 token：收尾的按服务商报的数，在写的那条按字数估。
	const written = (meter?.output ?? 0) + estimateTokens(output);
	return (
		// 8px 而不是正文里的 10px：这一行连上间距和回答底下那一行一样高，答完时两者同一帧一出一进，转录不抖。见 `RunningRow`。
		// 不换行：读数一段段开合，换行的话窄栏（侧边聊天）里这一行在一行、两行之间跳，转录跟着抖。放不下时只让开头那句闲话截短，读数都是事实，不截。
		<div
			data-plume-running=""
			data-plume-mood={mood}
			className="mt-2 flex min-w-0 max-w-full items-center overflow-hidden text-detail whitespace-nowrap text-ink-muted"
		>
			{/* 装饰，旁边那句话已经说了这是什么。用 20 而不是缩小的 64：两种尺寸是各自的设计，这一颗是画来放进一行字里的。 */}
			<ThinkingOrb state={mood} size={20} className="shrink-0" />
			{/* 换一句：两句叠着交叉淡入淡出，宽度缓过去，新句从左往右露出来、后面的读数被推着走（`SwapText`）。 */}
			{phrase && (
				<span className="ml-2 flex min-w-0">
					<SwapText swapKey={phrase.key} glide={phrase.glide}>
						{phrase.text}
					</SwapText>
				</span>
			)}
			{startedAt !== null && (
				<Readout open separated={phrase !== null}>
					<span className="tabular-nums text-ink-faint">{formatElapsed(elapsed)}</span>
				</Readout>
			)}
			<TurnTokens total={written} turn={startedAt} />
			{/* 只在字在来、或者工具在跑的时候报速度：还没开口没有速度可报，停住了它就是 0，留着最后那个数是在说还在写。 */}
			<LiveRate rate={rate} shown={stage === "streaming" || stage === "tool"} />
			{/*
			 * 只在字在来的时候挂出来，排在 tok/s 后面：两个一起出、一起收，进出推不动前面的读数。没字可画时不留一条空线，
			 * 那件事行尾那句状态已经说了；断流四秒最后一根柱子正好走出画面，同一刻那句「静候下文」接上。
			 */}
			{/* 挂上以后见过字来才出：切回一个在跑的会话时，挂上前到的字它没记，开着也是一截空线。 */}
			<Readout open={stage === "streaming" && seen}>
				<StreamTrace chars={output} />
			</Readout>
			<StageStatus status={status} />
		</div>
	);
});

interface Status {
	key: string;
	text: string;
	warn: boolean;
}

/**
 * 模型那一侧没在出字时，直说是哪一种没出：还没开口，还是写着写着停了。在写、在跑工具、在重连时没有。
 * 还没开口的等到 `SILENT_MS` 才说，一出来就是警示色：等第一个字本来就要些时候，思考球和秒数已经在走，之前再说一句只是把正常的等待报成一件事。
 */
function statusFor(stage: Stage, quiet: number): Status | null {
	if (stage === "awaiting") return quiet >= SILENT_MS ? { key: "silent", text: translate("running.modelSilent"), warn: true } : null;
	if (stage === "stalled") return { key: "stalled", text: translate("running.noNewOutput", { n: Math.floor(quiet / 1000) }), warn: quiet >= SILENT_MS };
	return null;
}

/**
 * 状态那段字上的扫光：等第一个字、没有新输出，那道光照样一直走——行上别的东西（思考球）也在动，字不动的话像没在等。
 *
 * 颜色分两档（`.plume-glide-status`；`warn` 是同一个类加 `.plume-glide-warn`，只换底色和亮处）：灰字走更浅的灰光，警示色的字走
 * 浅一档的黄光。不用现成的 `.plume-glide`：它的底色是工具行那一档灰，这里的字比它淡、黄字更不是它。扫光按拍推，不交给浏览器
 * 每帧重绘（和思考球、工具标题同一拍）。
 */
function GlideText({ warn, children }: { warn: boolean; children: ReactNode }) {
	const box = useRef<HTMLSpanElement>(null);
	useTickedAnimations(box, GLIDE);
	return (
		<span className={`inline-block tabular-nums plume-glide-status ${warn ? "plume-glide-warn" : ""}`} ref={box}>
			{children}
		</span>
	);
}

/**
 * 行尾的那句状态。开头那句话是程序的自言自语、按钟点换，事实另起一段放在最后：秒数每秒在变，放在行尾，它变宽变窄不推动别的读数。
 * `key` 换了才滚，停住时秒数在走只缓宽度；收起的那一阵留着最后一句，有东西可演，收完再卸掉。
 */
function StageStatus({ status }: { status: Status | null }) {
	const last = useRef(status);
	const [, forget] = useReducer((n: number) => n + 1, 0);
	if (status) last.current = status;
	const shown = status ?? last.current;
	return (
		<Readout
			open={status !== null}
			// 收完就卸掉：看不见的那段扫光不该每拍还被拨一次。
			onClosed={() => {
				last.current = null;
				forget();
			}}
		>
			{shown && (
				<RollWords rollKey={shown.key} text={shown.text}>
					<GlideText warn={shown.warn}>{shown.text}</GlideText>
				</RollWords>
			)}
		</Readout>
	);
}

/**
 * 离上一次进展（`progress` 变了）过了多久，和挂上以后见没见过进展（`seen`）。在渲染时现读：每拍 `now` 都会重画这一行，不另开计时器。
 * 换会话回来重新挂载时从头计，只少算一段，不会多报。
 */
function useQuietFor(progress: string, now: number): { quiet: number; seen: boolean } {
	const mark = useRef({ progress, at: Date.now(), seen: false });
	if (mark.current.progress !== progress) mark.current = { progress, at: Date.now(), seen: true };
	return { quiet: Math.max(0, now - mark.current.at), seen: mark.current.seen };
}

/**
 * 一段读数进出：宽度和透明度一起走，后面的读数被推过去而不是跳过去。关着时子树照样留着，收起的那一阵有东西可演；
 * 间距和分隔点画在它里面，关着时一起收成 0，不在行里留一道空。
 */
function Readout({ open, separated = true, onClosed, children }: { open: boolean; separated?: boolean; onClosed?: () => void; children: ReactNode }) {
	return (
		<span
			aria-hidden={!open || undefined}
			onTransitionEnd={(event) => {
				// 里面缓宽度的过渡也会冒上来，只认自己这层的透明度走完。
				if (!open && event.target === event.currentTarget && event.propertyName === "opacity") onClosed?.();
			}}
			className={`inline-grid shrink-0 transition-[grid-template-columns,opacity] duration-[var(--plume-t-slow)] ease-out ${open ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0"}`}
		>
			{/* 内边距放在里面那层：放在被压成 0 宽的这层上，宽压得掉、内边距压不掉，收着的读数各留下 8px 的空。 */}
			<span className="min-w-0 overflow-hidden">
				<span className="flex items-center gap-x-2 pl-2">
					{separated && <span className="text-ink-faint">·</span>}
					{children}
				</span>
			</span>
		</span>
	);
}

/**
 * 这一轮写出了多少 token：收尾了的按服务商报的数，还在写的那条按字数估。走过去，不跳过去：草稿 50ms 长一截，收尾时估数换成真数。
 */
function TurnTokens({ total, turn }: { total: number; turn: number | null }) {
	/*
	 * 一轮之内只往上走：一步收尾时按字数估的数换成服务商报的真数，英文常常小一成；不报用量的服务商真数是 0，
	 * 照搬的话读数会往回跳、甚至整段收起再展开。换了一轮（`turn` 是这一轮的开始时刻）才从头数。
	 */
	const peak = useRef({ turn, value: 0 });
	if (peak.current.turn !== turn) peak.current = { turn, value: 0 };
	peak.current.value = Math.max(peak.current.value, total);
	const counted = Math.round(useCountUp(peak.current.value));
	return (
		<Readout open={counted > 0}>
			{/* 走着的时候 `tabular-nums` 更要紧：字宽每帧在变，整行会跟着左右挪。 */}
			<span className="tabular-nums text-ink-faint">{translate("running.outputTokens", { n: formatTokens(counted) })}</span>
		</Readout>
	);
}

/** 速度双向地走：慢下来和快起来一样真实。走得比总数快一点，刚好接得上采样的节奏。 */
function LiveRate({ rate: reading, shown }: { rate: number; shown: boolean }) {
	const rate = useCountUp(reading, 240, { bidirectional: true });
	return (
		<Readout open={shown && rate >= 0.05}>
			<span className="tabular-nums text-ink-faint">{rate.toFixed(1)} tok/s</span>
		</Readout>
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

/**
 * 这一步的回复已经写出了多少字：推理、正文、工具参数都算。用来认「字还在不在来」和估这一轮写了多少 token；
 * 还没开写（请求刚发出去、上一步刚收尾）是 0。
 */
function draftOutput(messages: readonly Message[]): number {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return 0;
	let chars = 0;
	for (const block of last.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "thinking") chars += block.thinking.length;
		else if (block.type === "toolCall") chars += block.argumentsText?.length ?? 0;
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

/** 运行行开头那句话：`key` 换了才算换了一句。 */
interface Phrase {
	key: string;
	text: string;
	glide: boolean;
}

/** 闲话那一句挂着时 `useHeldKey` 记的 key；调用的 id 不会是它。 */
const IDLE = "idle";
/** 几次调用并行时那一句的 key：一起在跑的数在变，句子还是同一句，只缓宽度。 */
const PARALLEL = "parallel";

/**
 * 有调用在跑时，运行行开头说的那件事：一个在跑说它自己（和卡片里那一行同一个说法），几个并行说它们一共在做什么
 * （`describeRunning`）。没有在跑的返回 `undefined`，开头照旧说闲话。
 *
 * 每一句至少挂 650ms（`useHeldKey`）：几十毫秒就跑完的 read 不一闪而过；跑完了还没待满的照旧说它（按 key 记下的那句字），
 * 待满了才换下一句或换回闲话。
 */
function useRunningFact(messages: readonly Message[], callStarts: Readonly<Record<string, number>>, cwd: string | undefined): Phrase | undefined {
	const running = runningCalls(messages, callStarts);
	const first = running[0];
	const now = !first
		? undefined
		: running.length === 1
			? { key: first.id, text: labelText(callLabel(first, true, cwd)) }
			: { key: PARALLEL, text: describeRunning(running) };
	const held = useHeldKey(now?.key ?? IDLE);
	// 挂着的那句是哪些字：调用跑完了就不在 `running` 里，还没待满时要照它原来的说法说完。
	const said = useRef(new Map<string, string>());
	if (now) said.current.set(now.key, now.text);
	for (const key of said.current.keys()) if (key !== held && key !== now?.key) said.current.delete(key);
	const text = said.current.get(held);
	return held === IDLE || text === undefined ? undefined : { key: held, text, glide: true };
}

/** 这一轮此刻在跑的调用（开跑了、还没结果），按开跑的先后。排着还没轮到的、等批准的不算。 */
function runningCalls(messages: readonly Message[], startedAt: Readonly<Record<string, number>>): ToolCallBlock[] {
	const finished = new Set<string>();
	const running: ToolCallBlock[] = [];
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at]!;
		if (message.role === "user" && !message.synthetic && !message.steered) break;
		if (message.role === "toolResult") finished.add(message.toolCallId);
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall" && startedAt[block.id] !== undefined && !finished.has(block.id)) running.push(block);
	}
	return running.sort((a, b) => startedAt[a.id]! - startedAt[b.id]!);
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
		// 插话不开新的一轮：越过它，插话前刚跑完的那个照样算（`TOOL_HOLD_MS`）。
		if (message.role === "user" && !message.synthetic && !message.steered) break;
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
