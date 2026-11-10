/**
 * 一段连着做的活，画成一行（怎么分段见 `turn-blocks.ts` 的 `Step`）。
 *
 * - **一次调用**：这一行就是那次调用自己（`ToolCard`）。
 * - **几次调用，或者调用前想过**：跑着时这一行说的是正在跑的那一次调用，换一次滚一下，每一句至少挂 650ms（`useHeldKey`）；
 *   这一段不再长了（后面接上了回答或别的活），再滚成总的「思考 2 次 · 读取文件 12 个、搜索内容 5 个」。点开是挂在一条竖线上的
 *   每一次调用和每一段推理。
 *
 * 跑着时行首是这一段第一次调用的图标，从一次长到两次换的只有字；收成总的那一句时换成叠层图标：一句里有读、有跑、有改，
 * 哪一种的图标都只说对了一样。
 * - **末尾的推理还在写**：句尾接一句「正在思考 · 5s」，句子本身不动。推理不另起一行，不会有一行冒出来、几秒后又被收走。
 * - **回来的后台命令结果**挂在竖线上，失败的给这一行挂失败记号；连着查同一个后台任务的几次是一行（`foldPolls`）。
 */

import { Collapse, FlowRow, RollWords, translate, useHeldKey } from "@plume/ui";
import { CircleX, Layers } from "@plume/ui/icons";
import { Fragment, memo, type ReactNode, useRef } from "react";
import { describeCalls, describeOne, diffOf } from "./call-words.ts";
import { DiffCount } from "./DiffCount.tsx";
import type { Run } from "./grouping.ts";
import { LiveThought } from "./LiveThought.tsx";
import { StepCall, writeDraft } from "./ToolCard.tsx";
import { ToolIcon } from "./tool-icons.tsx";
import { foldPolls, polledJob, sameStep, type Step, thinkingLive } from "./turn-blocks.ts";
import { callStatus, useTranscript, useTranscriptDisclosure } from "./view-state.ts";

type MessageRun = Extract<Run, { kind: "message" }>;

/**
 * 只在这一段自己变了时重画，见 `sameStep`。`draw` 只在它画出来的东西会变时才换引用（见 `Conversation`）。
 * 漏比 `live`，扫光会一直留在当过「正在做」的每一段上。转录状态（结果、输出）经上下文进来，变了照样重画。
 */
export const WorkStep = memo(WorkStepRow, (a, b) => a.live === b.live && a.draw === b.draw && sameStep(a.step, b.step));

function WorkStepRow({
	step,
	live,
	draw,
}: {
	step: Step;
	/** 这一段是不是这一轮此刻正在做的那一段：一轮还在跑，而它后面什么都还没有。 */
	live: boolean;
	/** 推理那一行怎么画，交给转录自己（`MessageRow`），这里不另做一份。 */
	draw: (run: Run) => ReactNode;
}) {
	const tail = step.members[step.members.length - 1];
	const writing = live && tail?.kind === "thinking" && thinkingLive(tail.run) ? tail.run : null;
	const thinking = writing ? <LiveThought startedAt={startedAt(writing)} /> : undefined;
	const thought = step.members.filter((member) => member.kind === "thinking").length;

	/*
	 * 一次调用的那一行后面接上一段推理，这一段就从工具行换成合在一起的那一行：是换了一个元素。新的那一行从旧那一行此刻的
	 * 字宽和行尾宽缓过去，不然箭头在换的那一帧往右跳一截，句子也不像是往后长，而是整句换了。
	 * 在换的那一次渲染里读，读的是屏幕上还挂着的旧那一行。
	 */
	const box = useRef<HTMLDivElement>(null);
	const single = step.members.length === 1;
	const wasSingle = useRef(single);
	const from = useRef<{ words: number; trail: number } | null>(null);
	if (wasSingle.current && !single) {
		const row = box.current?.querySelector(".plume-flow-row");
		const words = row?.querySelector(".plume-roll-words");
		const trail = row?.querySelector(".plume-flow-trail");
		from.current = words && trail ? { words: words.getBoundingClientRect().width, trail: trail.getBoundingClientRect().width } : null;
	}
	wasSingle.current = single;

	if (single) {
		return (
			<div ref={box} data-plume-step={step.category}>
				<StepCall call={step.calls[0]!} {...(thinking ? { thinking } : {})} />
			</div>
		);
	}
	return (
		<div ref={box}>
			<StepGroup step={step} thought={thought} live={live} thinking={thinking} from={from.current} draw={draw} />
		</div>
	);
}

/** 这一行说的是总的那一句，而不是某一次调用。调用的 id 不会是它。 */
const STEP = "step";

function StepGroup({
	step,
	thought,
	live,
	thinking,
	from,
	draw,
}: {
	step: Step;
	/** 这一段里的推理有几次：「思考 N 次」。 */
	thought: number;
	live: boolean;
	thinking: ReactNode | undefined;
	/** 原地被它接替的那一行画出来的宽度；没有就是这一段刚出现。 */
	from: { words: number; trail: number } | null;
	draw: (run: Run) => ReactNode;
}) {
	const state = useTranscript();
	const [open, setOpen] = useTranscriptDisclosure(step.key);
	const { calls } = step;
	const statuses = calls.map((call) => callStatus(state, call.block.id, call.stopReason));
	const added = calls.reduce((sum, { block }) => sum + diffOf(state.results.get(block.id), "added"), 0);
	const removed = calls.reduce((sum, { block }) => sum + diffOf(state.results.get(block.id), "removed"), 0);
	// 后台命令回来时失败了也算：启动它的那次 bash 早就以「已放到后台」跑完了，记录上不会是错。
	const failed =
		statuses.includes("error") ||
		step.members.some(
			(member) => member.kind === "job" && member.run.message.role === "user" && member.run.message.delivery?.some((report) => report.status === "failed"),
		);

	/*
	 * 跑着时说的那一次：第一个还在跑的调用，不是最后发出的那个。一次发出几个调用时它们各跑各的，最后那个可能早跑完了、
	 * 前面那个还在跑。一个都没在跑（两批之间、下一个还没开跑）就说最后那个。
	 */
	const runningAt = statuses.findIndex((status) => status === "running" || status === "approval");
	const want = live ? calls[runningAt >= 0 ? runningAt : calls.length - 1]!.block.id : STEP;
	// 每一句至少挂一会儿：一两百毫秒来一次的 read、grep 不再来一次滚一次，字读完了才换。从跑着换成总的也一样等。
	const held = useHeldKey(want);
	// 挂着的那一次不在这一段里了（段被重新切过）就说最后那一次，和跑着时没有在跑的调用说的是同一个。
	const current = held === STEP ? undefined : (calls.find(({ block }) => block.id === held) ?? calls[calls.length - 1]);
	// 这一段默认收着：还在写的文件，路径和写了几行要在这一行上就看得到。
	const draft = current ? writeDraft(current.block, callStatus(state, current.block.id, current.stopReason)) : undefined;
	const said = draft?.block;

	// 哪样先来哪样在前：先有的那半句不能被后来的「思考 N 次」从前面挤开。
	const parts = [describeCalls(calls)];
	if (thought > 0) parts[step.members[0]?.kind === "thinking" ? "unshift" : "push"](translate("step.thinking", { n: thought }));
	const job = said ? polledJob(said) : undefined;
	const words = said ? describeOne(said, state.cwd, job ? state.jobs.get(job)?.description : undefined) : parts.join(translate("step.separator"));
	// 换一次调用、或者从跑着换成总的，就是换了一句话，滚一下；同一次调用的参数还在流进来，只缓宽度。
	const rollKey = said ? `call-${said.id}` : STEP;
	// 一次调用的那一行后面只接上了推理：句子还是原地那一句，从旧宽度缓过来就够，不滚。
	const sameWords = from !== null && calls.length === 1;
	const lines = draft?.lines;

	return (
		<div data-plume-step={step.category} data-plume-run={live ? "running" : "done"}>
			<FlowRow
				icon={said ? <ToolIcon name={calls[0]!.block.name} /> : <Layers size={13} strokeWidth={1.8} className="shrink-0" />}
				summary={
					<RollWords rollKey={rollKey} text={words} {...(from ? { from: from.words } : {})} glide={live && !thinking} enter={live && !sameWords}>
						{words}
					</RollWords>
				}
				trailFrom={from?.trail}
				trailing={
					thinking || failed || added + removed > 0 || lines ? (
						<span className="flex items-center gap-2">
							{lines && <span className="tabular-nums text-caption">{lines}</span>}
							{thinking}
							{failed && <CircleX size={13} strokeWidth={1.9} className="text-danger/85" />}
							{added + removed > 0 && <DiffCount added={added} removed={removed} />}
						</span>
					) : undefined
				}
				open={open}
				onToggle={() => setOpen((value) => !value)}
				label={translate("tools.run")}
			/>
			{/* 竖线在行首图标的正下方，挂在上面的每一行读起来都属于这一行。 */}
			<Collapse open={open} bodyClassName="pt-2.5">
				<div data-plume-step-rail="" className="ml-[7px] flex flex-col gap-2.5 border-l border-line-soft pl-[14px]">
					{foldPolls(step.members).map((line) =>
						line.kind === "call" ? (
							<Fragment key={line.call.block.id}>
								<StepCall call={line.call} />
							</Fragment>
						) : line.kind === "polls" ? (
							// 再查一次，这一行不卸掉重挂：key 跟第一次走。
							<Fragment key={line.calls[0]!.block.id}>
								<StepCall call={line.calls[0]!} polls={line.calls} />
							</Fragment>
						) : (
							draw(line.run)
						),
					)}
				</div>
			</Collapse>
		</div>
	);
}

function startedAt(run: MessageRun): number | undefined {
	if (run.message.role !== "assistant") return undefined;
	for (let at = run.upTo - 1; at >= (run.from ?? 0); at--) {
		const block = run.message.content[at];
		if (block?.type === "thinking") return block.startedAt;
	}
	return undefined;
}
