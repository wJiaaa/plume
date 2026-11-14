/**
 * 一段连着做的活画成一组（怎么分段见 `turn-blocks.ts` 的 `Step`）：一行标题，点开是一张带框的卡片，卡片里一次调用一行，
 * 每一行再点开是它的详情（`ToolBody`）。
 *
 * - **标题**：这一段还在做时说正在做的那一次（「正在查看 client.ts」，字上扫光），每一句至少挂 650ms（`useHeldKey`）；
 *   做完了说总的（「运行 3 个命令（1 个失败），查看 2 个文件 +12 −3」）。只有一次调用时标题就是那一次，点开直接是详情。
 * - **换字**：原地交叉淡入淡出，宽度缓过去（`SwapText`），后面的箭头不跳。
 * - **一行**：跑着「正在修改 retry.ts」，跑完「修改 retry.ts +2 −1」；模型写了说明的命令说它的说明，失败的在后面标红「失败」。
 *   一组跑着时新来的行淡入。
 * - **末尾的推理还在写**：标题后面接一句「正在思考 · 5s」，句子本身不动。推理和回来的后台命令结果在卡片里各占一行。
 *
 * 默认收着；点开过的按会话记住（`useTranscriptDisclosure`）。旧的那种一行一个图标、点开挂在竖线上的画法是 `WorkStep`。
 */

import { Collapse, translate, useHeldKey } from "@plume/ui";
import { ChevronRight } from "@plume/ui/icons";
import { type AnimationEvent, Fragment, memo, type ReactNode, useRef, useState } from "react";
import { hasToolCard, usePluginRegistrations } from "../plugins.tsx";
import { AnsweredBy } from "./AnsweredBy.tsx";
import { type CallLabel, callLabel, describePolls, diffOf, labelText, summarizeCalls } from "./call-words.ts";
import { type Call, type Run, runKey } from "./grouping.ts";
import { LiveThought } from "./LiveThought.tsx";
import { lineNote } from "./tool-lines.ts";
import { SwapText } from "./SwapText.tsx";
import { ToolBody } from "./ToolBody.tsx";
import { PluginToolCard, sameJob, SLOT_STATUS, writeDraft } from "./ToolCard.tsx";
import { foldPolls, polledJob, sameStep, type Step, type StepMember, thinkingLive } from "./turn-blocks.ts";
import {
	type CallState,
	type CallStatus,
	callStatus,
	sameItems,
	stoppedByUser,
	useCallLive,
	useCalls,
	useTranscript,
	useTranscriptDisclosure,
} from "./view-state.ts";

type MessageRun = Extract<Run, { kind: "message" }>;

/** 只在这一段自己变了时重画，见 `sameStep`；和 `WorkStep` 的比法一样。 */
export const ToolStep = memo(
	function ToolStep({ step, live, draw }: { step: Step; live: boolean; draw: (run: Run) => ReactNode }) {
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
	const stops = useCalls((all) => calls.map(({ block }) => stoppedByUser(all.results.get(block.id))), sameItems);
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
	 * 跑着时说的那一次：第一个还在跑的调用，不是最后发出的那个——一次发出几个调用时它们各跑各的。一个都没在跑（两批之间）
	 * 就说最后那个。只有一次调用时说的总是它。
	 */
	const runningAt = statuses.findIndex((status) => status === "running" || status === "approval");
	const want = single || live ? calls[runningAt >= 0 ? runningAt : calls.length - 1]!.block.id : SUMMARY;
	const held = useHeldKey(want);
	const current = held === SUMMARY ? undefined : (calls.find(({ block }) => block.id === held) ?? calls[calls.length - 1]);
	const at = current ? calls.indexOf(current) : -1;
	const status = statuses[at];

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
		const label = callLabel(draft.block, callLive, cwd, jobs[at]);
		const failed = status === "error" && !stops[at];
		const marks = callLive ? null : (
			<Marks
				failed={failed || (single && failedLater)}
				stopped={status === "error" && stops[at] === true}
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
		const failedIds = new Set(calls.flatMap(({ block }, index) => (statuses[index] === "error" && !stops[index] ? [block.id] : [])));
		const thought = members.filter((member) => member.kind === "thinking").length;
		const summary = summarizeCalls(calls, failedIds, thought, members[0]?.kind === "thinking");
		words = (
			<>
				{summary}
				<Marks failed={failedLater && failedIds.size === 0} stopped={false} added={added} removed={removed} />
			</>
		);
		text = summary;
		swapKey = SUMMARY;
	}

	const tail = members[members.length - 1];
	const writing = live && tail?.kind === "thinking" && thinkingLive(tail.run) ? tail.run : null;
	// 只有一次调用、还没开跑（参数在写、排在后面）的没有可看的：不能点开。
	const expandable = !single || startedAt !== undefined || !liveStatus(statuses[0]);
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

/** 卡片里的那几行。挂上以后才来的（一组还在跑时新做的那一次）淡入，点开时已经在的原样出现。 */
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
					const row = <ToolRow call={call} polls={polls} enter={enter} />;
					if (!polls && hasToolCard(call.block.name))
						return (
							<div key={key} className="tool-row-plugin">
								<PluginToolCard call={call} fallback={row} />
							</div>
						);
					return <Fragment key={key}>{row}</Fragment>;
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
	const stopped = status === "error" && stoppedByUser(result);
	const failed = status === "error" && !stopped;
	const added = diffOf(result, "added");
	const removed = diffOf(result, "removed");
	const label: CallLabel = job && polls ? { verb: describePolls(started?.description, polls.length) } : callLabel(draft.block, live, cwd, started?.description);
	const text = labelText(label);
	const expandable = startedAt !== undefined || !live;
	const arrival = useArrival(enter);

	return (
		<div data-tool-row="" data-tool={call.block.name} data-tool-call={call.block.id} data-status={SLOT_STATUS[status]} {...arrival}>
			<button
				type="button"
				className="tool-row-head text-label"
				aria-expanded={expandable ? open : undefined}
				data-open={open && expandable ? "" : undefined}
				onClick={expandable ? () => setOpen((value) => !value) : undefined}
			>
				<SwapText swapKey={`${live ? "now" : "done"}:${lineNote(draft.block.name, draft.block.arguments) ? "note" : ""}`} glide={live}>
					<LabelWords label={label} />
					{!live && <Marks failed={failed} stopped={stopped} added={added} removed={removed} />}
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
	const arrival = useArrival(enter);
	return (
		<div data-tool-extra="" {...arrival}>
			{children}
		</div>
	);
}

/**
 * 新出现的东西淡入一次（`.tool-fade-in`）；淡完摘掉类名：藏起来的页面（`Activity`）再显出来时动画会重演，摘掉了就不会。
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

/** 句尾的记号：失败（红字）、人按的停（中性）、改了几行。 */
function Marks({ failed, stopped, added, removed }: { failed: boolean; stopped: boolean; added: number; removed: number }) {
	return (
		<>
			{failed && <span className="tool-mark text-danger">{translate("toolRow.failed")}</span>}
			{stopped && <span className="tool-mark text-ink-faint">{translate("toolCard.stopped")}</span>}
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
