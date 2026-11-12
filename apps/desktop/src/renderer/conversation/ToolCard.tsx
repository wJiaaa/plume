/**
 * 一次工具调用，画成一行（`FlowRow`），点开是参数和结果。
 *
 * 一轮里每次调用一张带框的卡，夹在几行话中间就是一摞盒子。跑着的说法和别的过程行一样——字上扫光；跑完是安静的状态，
 * 失败和停下各带一个记号。插件给工具登记了自己的卡片时，整张卡照原样画（`PluginToolCard`），这一行是它的通用卡片。
 */

import type { ImageContent, ToolOutput, ToolResultMessage } from "@plume/contract";
import type { ToolCardProps } from "@plume/contract/ui";
import { Collapse, FlowRow, RollWords, Scroller, translate, useI18n, useNow } from "@plume/ui";
import { Ban, CircleX } from "@plume/ui/icons";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { openFromEvent } from "../image/index.ts";
import { AnsweredBy } from "./AnsweredBy.tsx";
import { hasToolCard, queueTask, ToolCardSlot, usePluginRegistrations } from "../plugins.tsx";
import { describeOne, describePolls, diffOf } from "./call-words.ts";
import { CodeText } from "./detail/CodeText.tsx";
import type { DiffHunk } from "./detail/diff-highlight.ts";
import { DiffView } from "./detail/DiffView.tsx";
import { Section } from "./detail/Section.tsx";
import { DiffCount } from "./DiffCount.tsx";
import type { Call, ToolCallBlock } from "./grouping.ts";
import { formatElapsed } from "./running-line.ts";
import { streamedLines, streamedString } from "./streamed-arguments.ts";
import { ToolIcon } from "./tool-icons.tsx";
import { polledJob, pollOutput } from "./turn-blocks.ts";
import {
	type BackgroundJobInfo,
	type CallStatus,
	callStatus,
	sameItems,
	stoppedByUser,
	useCallLive,
	useCalls,
	useTranscript,
	useTranscriptDisclosure,
} from "./view-state.ts";

/** 「刚跑完」那一下：记号从半大弹到原样。 */
const POP = "animate-[plume-settle_var(--plume-t-base)_var(--plume-e-out)_both]";

/** 冒烟和插件看的状态：还没开跑的也算执行中。 */
const SLOT_STATUS: Record<CallStatus, ToolCardProps["status"]> = {
	pending: "running",
	approval: "approval",
	running: "running",
	done: "done",
	error: "failed",
};

/**
 * 还在写的文件：标题带上路径，行尾说写了几行。开跑之后交还给参数本身。
 */
export function writeDraft(block: ToolCallBlock, status: CallStatus): { block: ToolCallBlock; lines?: string } {
	const raw = status === "pending" && block.name === "write" ? block.argumentsText : undefined;
	if (!raw) return { block };
	const path = typeof block.arguments.path !== "string" ? streamedString(raw, "path") : undefined;
	const lines = streamedLines(raw, "content");
	return {
		block: path ? { ...block, arguments: { ...block.arguments, path } } : block,
		...(lines ? { lines: translate("toolCard.writtenLines", { n: lines }) } : {}),
	};
}

const usedCardEvents = new WeakSet<Event>();

/**
 * 一段活里的一次调用（单独一次的那一行、展开后竖线上的那一行）：插件给它登记了只补东西的卡片（`inline`）时由卡片画，
 * 否则是通用卡片。单独成行的那种卡片不会走到这里，见 `grouping.ts` 的 `own`。
 */
export function StepCall({ call, thinking, polls }: { call: Call; thinking?: ReactNode; polls?: Call[] }) {
	usePluginRegistrations();
	if (!polls && hasToolCard(call.block.name)) return <PluginToolCard call={call} {...(thinking ? { thinking } : {})} />;
	return <ToolCard call={call} {...(thinking ? { thinking } : {})} {...(polls ? { polls } : {})} />;
}

/** 插件的卡片单独一行；发送始终绑定当前会话、调用和真实用户操作。 */
export function PluginToolCard({ call, thinking }: { call: Call; thinking?: ReactNode }) {
	const state = useTranscript();
	const { block } = call;
	const status = useCalls((calls) => callStatus(calls, block.id, call.stopReason));
	const result = useCalls((calls) => calls.results.get(block.id));
	const { progress } = useCallLive(block.id);
	const root = useRef<HTMLDivElement>(null);
	const identity = `${state.sessionId}:${block.id}`;
	const current = useRef({ identity, send: state.send, status });
	current.current = { identity, send: state.send, status };
	const mounted = useRef(true);
	const lastFrameSend = useRef(0);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const send: NonNullable<ToolCardProps["send"]> = async (text, event, displayText) => {
		const message = event instanceof MessageEvent;
		const source = message ? event : event.nativeEvent;
		const frame = document.activeElement;
		const userAction = message
			? frame instanceof HTMLIFrameElement &&
				root.current?.contains(frame) &&
				event.source === frame.contentWindow &&
				Date.now() - lastFrameSend.current >= 1500
			: ["click", "submit"].includes(source.type) && !!event.currentTarget && root.current?.contains(event.currentTarget as Node);
		if (
			!mounted.current ||
			current.current.identity !== identity ||
			!current.current.send ||
			current.current.status !== "done" ||
			!(source instanceof Event) ||
			!source.isTrusted ||
			!navigator.userActivation.isActive ||
			!userAction ||
			usedCardEvents.has(source)
		)
			throw new Error("Tool card submission requires a user action");
		if (typeof text !== "string" || !text.trim() || text.length > 32_000) throw new Error("Invalid tool card message");
		if (displayText !== undefined && (typeof displayText !== "string" || !displayText.trim() || displayText.length > 32_000))
			throw new Error("Invalid tool card display text");
		usedCardEvents.add(source);
		if (message) lastFrameSend.current = Date.now();
		await current.current.send(text, displayText);
	};

	// 交给插件的调用和结果只在它们自己变了时才换对象：插件拿它们当 effect 的依赖时，别的调用来了结果不该让它重跑。
	const slotCall = useMemo(() => ({ id: block.id, name: block.name, args: block.arguments }), [block.id, block.name, block.arguments]);
	const slotResult = useMemo(() => {
		if (!result) return undefined;
		// 还带着像素的小图照原样放进 `result.images`；挪进媒体目录的大图不给插件卡片，由通用卡片画。
		const inline = result.content.flatMap((part) =>
			part.type === "image" && part.data && MODEL_IMAGE.test(part.mimeType) ? [{ data: part.data, mimeType: part.mimeType as ModelImage["mimeType"] }] : [],
		);
		return {
			output: resultText(result.content),
			...(inline.length > 0 ? { images: inline } : {}),
			isError: result.isError,
			details: result.details,
		};
	}, [result]);
	const props: ToolCardProps = {
		call: slotCall,
		sessionId: state.sessionId,
		argumentsText: block.argumentsText,
		streaming: status === "pending",
		...(state.send && status === "done" ? { send } : {}),
		...(state.child ? { handToParent: (instruction: string) => queueTask(state.sessionId, instruction) } : {}),
		status: SLOT_STATUS[status],
		...(progress === undefined ? {} : { progress }),
		...(slotResult ? { result: slotResult } : {}),
		fallback: <ToolCard call={call} {...(thinking ? { thinking } : {})} />,
	};
	return (
		<div ref={root} data-tool={block.name} data-tool-call={block.id} data-status={props.status}>
			<ToolCardSlot {...props} />
			{result?.answeredBy && <AnsweredBy plugins={[result.answeredBy]} />}
		</div>
	);
}

/** 后台任务的说明和命令按内容比：每来一条消息这张表都重建一遍，里面的对象也是新的。 */
function sameJob(a: BackgroundJobInfo | undefined, b: BackgroundJobInfo | undefined): boolean {
	return a === b || (a?.description === b?.description && a?.command === b?.command);
}

const NO_READS: readonly (ToolResultMessage | undefined)[] = [];

export function ToolCard({
	call,
	thinking,
	extra,
	polls,
}: {
	call: Call;
	/** 这一行代表连着查同一个后台任务的几次 `bash_output`，第一个就是 `call`。见 `foldPolls`。 */
	polls?: Call[];
	/** 跟在这次调用后面、还在写的那段推理：接在句尾说「正在思考」，句子本身不动。见 `WorkStep`。 */
	thinking?: ReactNode;
	/** 展开之后、调用详情下面的东西：跟在这次调用后面的推理。 */
	extra?: ReactNode;
}) {
	const { t } = useI18n();
	const state = useTranscript();
	/*
	 * 查后台任务输出：这一行说的是哪个任务，展开是那条命令和这几次读到的全部输出。状态跟最后一次走——前几次早答完了，
	 * 还在等的只会是最后那一次。
	 */
	const job = polledJob(call.block);
	const latest = job && polls ? polls[polls.length - 1]! : call;
	const status = useCalls((calls) => callStatus(calls, latest.block.id, latest.stopReason));
	const [open, setOpen] = useTranscriptDisclosure(`tool-${call.block.id}`);
	const draft = writeDraft(call.block, status);
	const { block } = draft;
	const result = useCalls((calls) => calls.results.get(latest.block.id));
	const started = useCalls((calls) => (job ? calls.jobs.get(job) : undefined), sameJob);
	// 这几次查输出各自读到的：展开时拼成一段输出。
	const reads = useCalls((calls) => (job ? (polls ?? [call]).map((one) => calls.results.get(one.block.id)) : NO_READS), sameItems);
	const hunks = hunksOf(result);
	const running = status === "running" || status === "approval";
	// 参数还在写的也在「跑」：字上扫光，只是还没开始、不计时。
	const live = running || status === "pending";
	/*
	 * 跑着的命令有个在走的秒数，才看得出它还在跑。从执行记录上的开始时刻算，不从这一行挂上的时候算：滚走再回来、
	 * 列表重排都会让挂载重来，跑了七分钟的命令会说「2s」。排着还没轮到的调用没有开始时刻，不计时。
	 */
	const { progress, startedAt } = useCallLive(latest.block.id);
	const now = useNow(running && startedAt !== undefined, 250);
	const elapsed = startedAt === undefined ? 0 : now - startedAt;
	// 停下不是失败：中性的说法，不用红色。
	const stopped = status === "error" && stoppedByUser(result);
	const failed = status === "error" && !stopped;
	const summary = job ? describePolls(started?.description, polls?.length ?? 1) : describeOne(block, state.cwd, started?.description);
	/*
	 * 还没开跑的调用没有可看的：不能展开。参数还在写的、写完了排在前面的调用后面等着的，都没有开始时刻；从前点开是
	 * 「等待输出…」，一条排了十二秒、只跑了几十毫秒的命令看上去是跑卡住了。
	 */
	const expandable = startedAt !== undefined || !live;
	// 「刚跑完」才弹一下：挂上时就已经结束的（历史、第一次展开的一段）不弹，否则每次展开 +N -M 都跳一下。
	const pop = useRef(live).current ? `${POP} ` : "";

	const notes = [
		thinking ? <span key="thinking">{thinking}</span> : null,
		draft.lines ? (
			<span key="lines" className="tabular-nums text-caption">
				{draft.lines}
			</span>
		) : null,
		running && startedAt !== undefined && elapsed >= 1000 ? (
			<span key="elapsed" className="tabular-nums text-caption">
				{formatElapsed(elapsed)}
			</span>
		) : null,
		failed ? <CircleX key="failed" size={13} strokeWidth={1.9} className={`${pop}text-danger/85`} /> : null,
		stopped ? (
			<span key="stopped" data-plume-tip={t("toolCard.stopped")} aria-label={t("toolCard.stopped")} className={`${pop}flex`}>
				<Ban size={13} strokeWidth={1.9} aria-hidden />
			</span>
		) : null,
		hunks ? (
			<span key="diff" className={`${pop}flex`}>
				<DiffCount added={diffOf(result, "added")} removed={diffOf(result, "removed")} />
			</span>
		) : null,
	].filter(Boolean);

	return (
		<div data-tool={block.name} data-tool-call={call.block.id} data-status={SLOT_STATUS[status]}>
			<FlowRow
				icon={<ToolIcon name={block.name} />}
				// 参数流进来时字往后长（「修改文件」→「修改文件 one.ts」），宽度缓过去，行尾的箭头不跳。
				summary={
					<RollWords rollKey="call" text={summary} glide={live}>
						{summary}
					</RollWords>
				}
				trailing={notes.length > 0 ? <span className="flex items-center gap-2">{notes}</span> : undefined}
				open={expandable ? open : undefined}
				onToggle={expandable ? () => setOpen((value) => !value) : undefined}
			/>
			{result?.answeredBy && <AnsweredBy plugins={[result.answeredBy]} />}
			{expandable && (
				<Collapse open={open} bodyClassName="flex flex-col gap-2.5 pt-1.5 pl-[22px]">
					<div className="overflow-hidden rounded-lg border border-line-soft bg-card/45">
						{/* 只在点开时才挂上：参数的 JSON、拼起来的输出都在这里面算，收着的卡每次重画都不白算一遍。 */}
						<ToolCardBody
							block={block}
							job={job}
							command={job ? (started?.command ?? (result?.details as { command?: unknown } | undefined)?.command) : undefined}
							result={result}
							reads={reads}
							progress={progress}
							hunks={hunks}
							running={running}
							stopped={stopped}
							failed={failed}
							summary={summary}
						/>
					</div>
					{extra}
				</Collapse>
			)}
		</div>
	);
}

function hunksOf(result: ToolResultMessage | undefined): DiffHunk[] | undefined {
	const hunks = (result?.details as { hunks?: unknown } | undefined)?.hunks;
	return Array.isArray(hunks) && hunks.length > 0 ? (hunks as DiffHunk[]) : undefined;
}

/** 点开以后的内容：diff，或者命令、参数、输出。 */
function ToolCardBody({
	block,
	job,
	command: jobCommand,
	result,
	reads,
	progress,
	hunks,
	running,
	stopped,
	failed,
	summary,
}: {
	block: ToolCallBlock;
	/** 查的是哪个后台任务；不是查输出的调用没有。 */
	job: string | undefined;
	/** 查输出时摆的那条命令：任务 id 是一串 uuid，人读不出东西。 */
	command: unknown;
	result: ToolResultMessage | undefined;
	reads: readonly (ToolResultMessage | undefined)[];
	progress: string | undefined;
	hunks: DiffHunk[] | undefined;
	running: boolean;
	stopped: boolean;
	failed: boolean;
	summary: string;
}) {
	const { t } = useI18n();
	if (hunks) {
		const path = (result?.details as { path?: unknown } | undefined)?.path;
		return <DiffView hunks={hunks} path={typeof path === "string" ? path : undefined} showPath />;
	}
	const output = job ? pollOutput(reads.flatMap((read) => (read ? [resultText(read.content)] : []))) : result ? resultText(result.content) : (progress ?? "");
	const { command, ...rest } = job ? { command: jobCommand } : (block.arguments as Record<string, unknown>);
	return (
		<>
			{/* 命令照命令的样子摆：出了问题最先要查的就是跑了什么，夹在一串 JSON 里得绕着语法找。 */}
			{typeof command === "string" && (
				<Section title={t("commands.title")} mono tone="ink">
					<span className="mr-2 select-none text-ink-faint">$</span>
					<CodeText text={command} kind="shell" />
				</Section>
			)}
			{Object.keys(rest).length > 0 && (
				<Section title={t("toolCard.args")} mono>
					<CodeText text={JSON.stringify(rest, null, 2)} kind="json" />
				</Section>
			)}
			{/* 没输出也是一种状态：装依赖时几分钟一个字不打，没有输出那一节的卡片看上去像把输出弄丢了。 */}
			{!result && !output && running && (
				<Section title={t("toolCard.outputRunning")} mono>
					<span className="text-ink-faint">{t("toolCard.waiting")}</span>
				</Section>
			)}
			{/* 有结果就有这一节，哪怕没有一个字：只回了图、或者什么都没回，也要说出它跑完了、结果是什么样。 */}
			{(result || output !== "") && (
				<Section
					title={stopped ? t("toolCard.stopped") : failed ? t("common.error") : running ? t("toolCard.outputRunning") : t("common.result")}
					mono={output !== ""}
					tone={failed ? "danger" : "muted"}
				>
					{output !== "" && (
						<Scroller className="max-h-[420px]" overscroll="auto">
							{output}
						</Scroller>
					)}
					{result && <ResultImages result={result} summary={summary} spaced={output !== ""} />}
				</Section>
			)}
		</>
	);
}

/** 结果缩略图的高度。按两倍高度取图，停在那里的缩略图在高分屏上也清楚；点开是原图。 */
const RESULT_THUMB_HEIGHT = 160;

/**
 * 结果里的图：先是交给模型的，再是只给人看的（`shownImages`）。模型手上的和人眼前的可以不是同一份：MCP 返回的大图不塞进请求，
 * 模型拿到的是一句说明和路径，人照样要看到那张图。
 */
function resultImages(result: ToolResultMessage): { src: string; mimeType: string }[] {
	const blocks = [...result.content, ...(result.shownImages ?? [])];
	return blocks.flatMap((block: unknown) => {
		const image = block as Partial<ImageContent> | null;
		if (image?.type !== "image" || typeof image.mimeType !== "string") return [];
		const src = imageSrc(image as ImageContent);
		return src ? [{ src, mimeType: image.mimeType }] : [];
	});
}

/**
 * 工具回了图就画图：读一张 PNG、插件的截图，模型看到的是像素，卡片上从前只写着它的名字——那正是点开卡片想看的东西。
 * 点一下在看图器里打开原图。
 */
function ResultImages({ result, summary, spaced }: { result: ToolResultMessage; summary: string; spaced: boolean }) {
	const sources = resultImages(result).map((image) => image.src);
	if (sources.length === 0) return null;
	const gallery = sources.map((src, index) => ({ src, alt: translate("toolCard.image", { summary, n: index + 1 }) }));
	return (
		<div className={`flex flex-wrap gap-2 ${spaced ? "mt-2" : ""}`}>
			{gallery.map((image, index) => (
				<button key={index} type="button" className="block cursor-zoom-in" onClick={(event) => openFromEvent(event, gallery, index)}>
					<img
						alt={image.alt}
						src={image.src}
						style={{ maxHeight: RESULT_THUMB_HEIGHT }}
						className="max-w-full rounded-lg border border-line-soft object-contain"
					/>
				</button>
			))}
		</div>
	);
}

/** 图的地址：大图写进会话时挪进了 session-media，消息里只留名字；小图的像素还在消息里。 */
function imageSrc(block: ImageContent): string | undefined {
	if (typeof block.media === "string" && block.media) return `plume-media://m/${encodeURIComponent(block.media)}`;
	if (typeof block.data === "string" && block.data) return `data:${block.mimeType};base64,${block.data}`;
	return undefined;
}

type ModelImage = NonNullable<ToolOutput["images"]>[number];
/** `ToolOutput.images` 收的四种。 */
const MODEL_IMAGE = /^image\/(png|jpeg|webp|gif)$/;

function resultText(content: readonly { type: string; text?: string }[]): string {
	return content
		.flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
		.join("\n")
		.slice(0, 20000);
}
