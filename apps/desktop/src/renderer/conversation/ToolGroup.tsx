/**
 * 一段连着做的活画成一组（怎么分段见 `turn-blocks.ts` 的 `Step`）：一行标题，点开是一张带框的卡片，卡片里一次调用一行，
 * 每一行再点开是它的详情（`ToolBody`）。
 *
 * - **标题**：只有一次调用时说那一次（跑着「正在查看 client.ts」、字上扫光，跑完「查看 client.ts」），点开直接是详情。
 *   几次调用合成的一组从头到尾说总的（「运行 3 个命令（1 个失败），查看 2 个文件 +12 −3」），跑着时数跟着长、字上扫光。
 *   不说正在做的那一次：一次发出几个调用时，一批里标题要换好几句（流进来的最后一个 → 开跑的第一个 → 跑完的最后一个），
 *   每句淡入淡出一次、箭头被推来推去；每一次在做什么，点开看卡片里的行。从一次长成几次时换一句，每一句至少挂 650ms（`useHeldKey`）。
 * - **换字**：原地交叉淡入淡出，宽度缓过去（`SwapText`），后面的箭头不跳。
 * - **一行**：跑着「正在修改 retry.ts」，跑完「修改 retry.ts +2 −1」；模型写了说明的命令说它的说明，失败的在后面标红「失败」。
 *   一组跑着时新来的行长出来（高度从 0 缓过去，同时淡入，见 `useGrowIn`）。
 * - **末尾的推理还在写**：标题后面接一句「正在思考 · 5s」，句子本身不动。推理和回来的后台命令结果在卡片里各占一行。
 *
 * - **图标**：每一行行首是那次调用的图标（`ToolIcon`），只有一次调用时标题就是那一次、也用它；几次调用合成的标题不画图标。
 *
 * 默认收着；点开过的按会话记住（`useTranscriptDisclosure`）。旧的那种点开挂在竖线上的画法是 `WorkStep`。
 */

import type { UnansweredDetails } from "@plume/contract";
import { Collapse, DURATION, motionReduced, translate, useHeldKey, useI18n } from "@plume/ui";
import { ChevronRight } from "@plume/ui/icons";
import { type AnimationEvent, memo, type ReactNode, type TransitionEvent, useEffect, useRef, useState } from "react";
import { hasToolCard, usePluginRegistrations } from "../plugins.tsx";
import { AnsweredBy } from "./AnsweredBy.tsx";
import { type CallLabel, callLabel, describePolls, diffOf, labelText, summarizeCalls } from "./call-words.ts";
import { type Call, type Run, runKey } from "./grouping.ts";
import { LiveThought } from "./LiveThought.tsx";
import { lineNote } from "./tool-lines.ts";
import { SwapText } from "./SwapText.tsx";
import { ToolBody } from "./ToolBody.tsx";
import { PluginToolCard, sameJob, SLOT_STATUS, writeDraft } from "./ToolCard.tsx";
import { ToolIcon } from "./tool-icons.tsx";
import { foldPolls, polledJob, sameStep, type Step, type StepMember, thinkingLive } from "./turn-blocks.ts";
import {
	type CallState,
	type CallStatus,
	callStatus,
	callStopped,
	callUnanswered,
	sameItems,
	unansweredMark,
	useCallLive,
	useCalls,
	useTranscript,
	useTranscriptDisclosure,
} from "./view-state.ts";

type MessageRun = Extract<Run, { kind: "message" }>;

/** 只在这一段自己变了时重画，见 `sameStep`；和 `WorkStep` 的比法一样。 */
export const ToolStep = memo(
	function ToolStep({ step, live, draw }: { step: Step; live: boolean; draw: (run: Run) => ReactNode }) {
		// 订阅界面语言：memo 挡住了上层的重画，换语言时这一块里经 `translate` 说的字（工具行、运行行）要跟着换。
		useI18n();
		usePluginRegistrations();
		const only = step.members.length === 1 ? step.calls[0] : undefined;
		const group = <ToolGroup id={step.key} calls={step.calls} members={step.members} live={live} draw={draw} category={step.category} />;
		// 插件登记了只补东西的卡片（`inline`）：卡片照它的样子画，这一组是它的通用卡片。
		if (only && hasToolCard(only.block.name)) return <PluginToolCard call={only} fallback={group} />;
		return group;
	},
	(a, b) => a.live === b.live && a.draw === b.draw && sameStep(a.step, b.step),
);

/** 单独一次调用：一句话中间夹着的调用、插件卡片画不出来时的通用卡片。 */
export function ToolCall({ call }: { call: Call }) {
	return <ToolGroup id={`tool-${call.block.id}`} calls={[call]} members={[{ kind: "call", call }]} live={false} />;
}

/** 标题说的是总的那一句，而不是某一次调用。调用的 id 不会是它。 */
const SUMMARY = "summary";

function liveStatus(status: CallStatus | undefined): boolean {
	return status === "pending" || status === "approval" || status === "running";
}

function ToolGroup({
	id,
	calls,
	members,
	live,
	draw,
	category,
}: {
	/** 记住开没开的 key。 */
	id: string;
	calls: Call[];
	members: StepMember[];
	/** 这一组是不是这一轮此刻正在做的那一段：一轮还在跑，而它后面什么都还没有。 */
	live: boolean;
	/** 推理、送回来的结果那一行怎么画，交给转录自己。 */
	draw?: (run: Run) => ReactNode;
	/** 一段活的归类，冒烟和插件看的 `data-plume-step`；单独一次调用没有。 */
	category?: string;
}) {
	const { cwd } = useTranscript();
	const [open, setOpen] = useTranscriptDisclosure(id);
	// 只订阅这一组自己的几次调用：别处来了结果，标题不重画。
	const statuses = useCalls((all) => calls.map((call) => callStatus(all, call.block.id, call.stopReason)), sameItems);
	const stops = useCalls((all) => calls.map(({ block }) => callStopped(all, block.id)), sameItems);
	const unanswered = useCalls((all) => calls.map(({ block }) => callUnanswered(all, block.id)), sameItems);
	const added = useCalls((all) => calls.reduce((sum, { block }) => sum + diffOf(all.results.get(block.id), "added"), 0));
	const removed = useCalls((all) => calls.reduce((sum, { block }) => sum + diffOf(all.results.get(block.id), "removed"), 0));
	const answeredBy = useCalls((all) => calls.flatMap(({ block }) => all.results.get(block.id)?.answeredBy ?? []), sameItems);
	const jobs = useCalls((all) => calls.map(({ block }) => jobDescription(all, block)), sameItems);
	const single = members.length === 1 && members[0]!.kind === "call";
	const only = single ? calls[0]! : undefined;
	const { startedAt } = useCallLive(only?.block.id ?? "");
	// 挂上时就在跑的一组（这一轮新做的）淡入；翻回来看历史时原样出现。
	const arrival = useArrival(live || liveStatus(statuses[0]));

	/*
	 * 只有一次调用时说它；跑着的这一段前面挂着推理（显示推理时）也还是说它。几次调用说总的，跑着也一样，见文件头。
	 */
	const one = calls.length === 1 ? calls[0]! : undefined;
	const want = one && (single || live) ? one.block.id : SUMMARY;
	const held = useHeldKey(want);
	const current = held === SUMMARY ? undefined : (calls.find(({ block }) => block.id === held) ?? calls[calls.length - 1]);
	const at = current ? calls.indexOf(current) : -1;
	const status = statuses[at];
	const details = useCalls((all) => (current ? all.results.get(current.block.id)?.details : undefined));

	// 后台命令回来时失败了也算：起它的那次 bash 早就以「已放到后台」跑完了。
	const failedLater = members.some(
		(member) => member.kind === "delivery" && member.run.message.role === "user" && member.run.message.delivery?.some((report) => report.status === "failed"),
	);

	let words: ReactNode;
	let text: string;
	let swapKey: string;
	let glide = false;
	let lines: string | undefined;
	if (current && status) {
		const callLive = liveStatus(status);
		const draft = writeDraft(current.block, status);
		lines = draft.lines;
		const label = callLabel(draft.block, callLive, cwd, jobs[at], details, status === "pending");
		const failed = status === "error" && !stops[at] && !unanswered[at];
		const marks = callLive ? null : (
			<Marks
				failed={failed || (single && failedLater)}
				stopped={status === "error" && stops[at] === true}
				unanswered={unanswered[at]}
				added={single ? added : 0}
				removed={single ? removed : 0}
			/>
		);
		words = (
			<>
				<LabelWords label={label} />
				{marks}
			</>
		);
		text = labelText(label);
		// 说明晚到（命令先写出来）也算换了一句：「正在运行 pnpm tsc」淡成「运行类型检查」。
		swapKey = `${current.block.id}:${callLive ? "now" : "done"}:${lineNote(draft.block.name, draft.block.arguments) ? "note" : ""}`;
		glide = callLive;
	} else {
		const failedIds = new Set(calls.flatMap(({ block }, index) => (statuses[index] === "error" && !stops[index] && !unanswered[index] ? [block.id] : [])));
		const thought = members.filter((member) => member.kind === "thinking").length;
		const writing = new Set(calls.flatMap(({ block }, index) => (statuses[index] === "pending" ? [block.id] : [])));
		const summary = summarizeCalls(calls, failedIds, thought, members[0]?.kind === "thinking", writing);
		words = (
			<>
				{summary}
				{/* 有一次没人答（提问卡被取消、到时没人答）也说出来：总的那句不点名是哪一次，记号不能跟着丢。 */}
				<Marks
					failed={failedLater || failedIds.size > 0}
					stopped={false}
					unanswered={unanswered.find((reason) => reason !== undefined)}
					added={added}
					removed={removed}
				/>
			</>
		);
		text = summary;
		swapKey = SUMMARY;
		// 跑着时总的那句也扫光：数在长，字不换。
		glide = live;
	}

	const tail = members[members.length - 1];
	const writing = live && tail?.kind === "thinking" && thinkingLive(tail.run) ? tail.run : null;
	// 只有一次调用、还没开跑（参数在写、排在后面）的没有可看的：不能点开。答完了、起的任务还在后台跑的有结果可看。
	const answered = useCalls((all) => (only ? all.results.has(only.block.id) : false));
	const expandable = !single || startedAt !== undefined || answered || !liveStatus(statuses[0]);
	const attrs = only
		? { "data-tool": only.block.name, "data-tool-call": only.block.id, "data-status": SLOT_STATUS[statuses[0] ?? "pending"] }
		: { "data-plume-run": live ? "running" : "done" };

	return (
		<div data-plume-step={category} {...attrs} {...arrival}>
			<button
				type="button"
				className="tool-group-head text-label"
				aria-expanded={expandable ? open : undefined}
				data-open={open && expandable ? "" : undefined}
				onClick={expandable ? () => setOpen((value) => !value) : undefined}
			>
				{only && <RowIcon name={only.block.name} failed={(statuses[0] === "error" && !stops[0] && !unanswered[0]) || failedLater} />}
				<SwapText swapKey={swapKey} glide={glide}>
					{words}
				</SwapText>
				{lines && <span className="shrink-0 text-caption tabular-nums">{lines}</span>}
				{writing && (
					<span className="shrink-0 text-caption">
						<LiveThought startedAt={thinkingStartedAt(writing)} />
					</span>
				)}
				<Chevron shown={expandable} />
			</button>
			{!open && <AnsweredBy plugins={answeredBy} />}
			{expandable && (
				<Collapse open={open} bodyClassName="pt-1.5">
					{only ? (
						<div className="tool-group-card">
							<div className="p-2">
								<ToolBody call={only} label={text} />
							</div>
						</div>
					) : (
						<CardRows members={members} draw={draw} />
					)}
				</Collapse>
			)}
		</div>
	);
}

/** 卡片里的那几行。挂上以后才来的（一组还在跑时新做的那一次）长出来（`useGrowIn`），点开时已经在的原样出现。 */
function CardRows({ members, draw }: { members: StepMember[]; draw: ((run: Run) => ReactNode) | undefined }) {
	usePluginRegistrations();
	const seen = useRef<Set<string> | null>(null);
	const lines = foldPolls(members);
	const keyOf = (line: (typeof lines)[number]) =>
		line.kind === "call" ? line.call.block.id : line.kind === "polls" ? line.calls[0]!.block.id : runKey(line.run);
	const initial = (seen.current ??= new Set(lines.map(keyOf)));
	return (
		<div className="tool-group-card">
			{lines.map((line) => {
				const key = keyOf(line);
				const enter = !initial.has(key);
				if (line.kind === "call" || line.kind === "polls") {
					const call = line.kind === "call" ? line.call : line.calls[0]!;
					const polls = line.kind === "polls" ? line.calls : undefined;
					// 插件画的那一行在外面这层长出来：插件画它自己的卡片时不经过 `ToolRow`。
					if (!polls && hasToolCard(call.block.name))
						return (
							<PluginRow key={key} enter={enter}>
								<PluginToolCard call={call} fallback={<ToolRow call={call} enter={false} />} />
							</PluginRow>
						);
					return <ToolRow key={key} call={call} polls={polls} enter={enter} />;
				}
				return (
					<ExtraRow key={key} enter={enter}>
						{draw?.(line.run)}
					</ExtraRow>
				);
			})}
		</div>
	);
}

/** 卡片里的一行：一次调用，或连着查同一个后台任务的几次（`polls`，第一个就是 `call`）。 */
function ToolRow({ call, polls, enter }: { call: Call; polls?: Call[] | undefined; enter: boolean }) {
	const { cwd } = useTranscript();
	const job = polledJob(call.block);
	const latest = job && polls ? polls[polls.length - 1]! : call;
	const status = useCalls((calls) => callStatus(calls, latest.block.id, latest.stopReason));
	const result = useCalls((calls) => calls.results.get(latest.block.id));
	const started = useCalls((calls) => (job ? calls.jobs.get(job) : undefined), sameJob);
	const [open, setOpen] = useTranscriptDisclosure(`tool-${call.block.id}`);
	const { startedAt } = useCallLive(latest.block.id);
	const live = liveStatus(status);
	const draft = writeDraft(call.block, status);
	const stopped = useCalls((calls) => status === "error" && callStopped(calls, latest.block.id));
	const unanswered = useCalls((calls) => callUnanswered(calls, latest.block.id));
	const failed = status === "error" && !stopped && unanswered === undefined;
	const added = diffOf(result, "added");
	const removed = diffOf(result, "removed");
	const label: CallLabel =
		job && polls
			? { verb: describePolls(started?.description, polls.length) }
			: callLabel(draft.block, live, cwd, started?.description, result?.details, status === "pending");
	const text = labelText(label);
	// 答完了、起的任务还在后台跑的（照跑着画）有结果可看。
	const expandable = startedAt !== undefined || result !== undefined || !live;
	const grow = useGrowIn(enter);

	return (
		<div data-tool-row="" data-tool={call.block.name} data-tool-call={call.block.id} data-status={SLOT_STATUS[status]} {...grow}>
			<button
				type="button"
				className="tool-row-head text-label"
				aria-expanded={expandable ? open : undefined}
				data-open={open && expandable ? "" : undefined}
				onClick={expandable ? () => setOpen((value) => !value) : undefined}
			>
				<RowIcon name={call.block.name} failed={failed} />
				<SwapText swapKey={`${live ? "now" : "done"}:${lineNote(draft.block.name, draft.block.arguments) ? "note" : ""}`} glide={live}>
					<LabelWords label={label} />
					{!live && <Marks failed={failed} stopped={stopped} unanswered={unanswered} added={added} removed={removed} />}
				</SwapText>
				{draft.lines && <span className="shrink-0 text-caption tabular-nums">{draft.lines}</span>}
				<Chevron shown={expandable} />
			</button>
			{result?.answeredBy && <AnsweredBy plugins={[result.answeredBy]} />}
			{expandable && (
				<Collapse open={open} bodyClassName="px-2 pb-2">
					<ToolBody call={call} polls={polls} label={text} />
				</Collapse>
			)}
		</div>
	);
}

/** 卡片里的推理、回来的后台命令结果。 */
function ExtraRow({ enter, children }: { enter: boolean; children: ReactNode }) {
	const grow = useGrowIn(enter);
	return (
		<div data-tool-extra="" {...grow}>
			{children}
		</div>
	);
}

/** 卡片里插件登记了卡片的那一次调用。 */
function PluginRow({ enter, children }: { enter: boolean; children: ReactNode }) {
	const grow = useGrowIn(enter);
	return (
		<div {...grow} className={`tool-row-plugin ${grow.className ?? ""}`.trim()}>
			{children}
		</div>
	);
}

/**
 * 卡片里新来的一行长出来（`.tool-row-enter`）：高度从 0 缓到它自己的高，同时淡入。
 *
 * 一下子撑开的话，卡片点开着、贴着底部时，每来一行上面整块就被顶上去一行高；一次发出六个调用，一秒里跳六下。
 * 用高度过渡，贴底跟随每一帧按长出来的那一截跟着挪（`useFollowBottom` 的 `growing`），上面的字平平地往上走，底下的不动。
 *
 * 长完摘掉类名：长着时裁着（`overflow: clip`），之后不该再裁；`@starting-style` 也只该用一次，藏起来的页面（`Activity`）
 * 再显出来时不重演。被打断（`transitioncancel`，比如长到一半藏了起来）也算长完。减少动态效果时直接出现。
 * 挂上时就藏着（`Activity` 里的面板、侧边聊天）过渡根本不跑，两个事件都不来：过了动画的时长照样摘掉，不然一直裁着，显出来时整批再长一遍。
 */
function useGrowIn(initial: boolean): {
	className?: string;
	onTransitionEnd?: (event: TransitionEvent<HTMLElement>) => void;
	onTransitionCancel?: (event: TransitionEvent<HTMLElement>) => void;
} {
	const [fresh, setFresh] = useState(() => initial && !motionReduced());
	useEffect(() => {
		if (!fresh) return;
		const timer = setTimeout(() => setFresh(false), DURATION.slow * 2);
		return () => clearTimeout(timer);
	}, [fresh]);
	if (!fresh) return {};
	const done = (event: TransitionEvent<HTMLElement>) => {
		if (event.target === event.currentTarget && event.propertyName === "height") setFresh(false);
	};
	return { className: "tool-row-enter", onTransitionEnd: done, onTransitionCancel: done };
}

/**
 * 新出现的一组淡入一次（`.tool-fade-in`）；淡完摘掉类名：藏起来的页面（`Activity`）再显出来时动画会重演，摘掉了就不会。
 */
function useArrival(initial: boolean): { className?: string; onAnimationEnd?: (event: AnimationEvent<HTMLElement>) => void } {
	const [fresh, setFresh] = useState(initial);
	if (!fresh) return {};
	return {
		className: "tool-fade-in",
		onAnimationEnd: (event) => {
			if (event.target === event.currentTarget) setFresh(false);
		},
	};
}

/** 一次调用的图标：比字淡一档，失败的标红。 */
function RowIcon({ name, failed }: { name: string; failed: boolean }) {
	return (
		<span className="tool-icon" data-failed={failed ? "" : undefined}>
			<ToolIcon name={name} />
		</span>
	);
}

/** 展开箭头：能点开时才出现，打开时转 90°。 */
function Chevron({ shown }: { shown: boolean }) {
	return <ChevronRight size={12} strokeWidth={2} className="tool-chevron" data-shown={shown ? "" : undefined} aria-hidden />;
}

/** 一行字：动作，点名的对象深一档，附注（读了哪几行）淡一档。 */
function LabelWords({ label }: { label: CallLabel }) {
	return (
		<>
			{label.verb}
			{label.subject && <span className="tool-label-subject"> {label.subject}</span>}
			{label.note && <span className="tool-label-note"> {label.note}</span>}
		</>
	);
}

/** 句尾的记号：失败（红字）、人按的停、人没答（中性）、改了几行。 */
function Marks({
	failed,
	stopped,
	unanswered,
	added,
	removed,
}: {
	failed: boolean;
	stopped: boolean;
	unanswered: UnansweredDetails["unanswered"] | undefined;
	added: number;
	removed: number;
}) {
	return (
		<>
			{failed && <span className="tool-mark text-danger">{translate("toolRow.failed")}</span>}
			{stopped && <span className="tool-mark text-ink-faint">{translate("toolCard.stopped")}</span>}
			{unanswered && <span className="tool-mark text-ink-faint">{translate(unansweredMark(unanswered))}</span>}
			{added > 0 && <span className="tool-mark tool-count text-ok">+{added}</span>}
			{removed > 0 && <span className={`tool-count text-danger ${added > 0 ? "ml-1" : "tool-mark"}`}>−{removed}</span>}
		</>
	);
}

function jobDescription(calls: CallState, block: Call["block"]): string | undefined {
	const job = polledJob(block);
	return job ? calls.jobs.get(job)?.description : undefined;
}

function thinkingStartedAt(run: MessageRun): number | undefined {
	if (run.message.role !== "assistant") return undefined;
	for (let at = run.upTo - 1; at >= (run.from ?? 0); at--) {
		const block = run.message.content[at];
		if (block?.type === "thinking") return block.startedAt;
	}
	return undefined;
}
