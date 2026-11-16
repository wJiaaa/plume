/**
 * 一个会话的转录：按回合分块，有过程的一轮交给 `TurnWork` 一行行摊开；只挂最近的 `WINDOW_TURNS` 轮，
 * 跟着底部走，离开了有「回到最新」。
 */

import type { BackgroundCallState, Message, SessionView, ToolResultMessage } from "@plume/contract";
import type { ConversationProps } from "@plume/contract/ui";
import { BackToLatest, Button, motionReduced, Scroller, tailSignature, translate, useFollowBottom, useI18n } from "@plume/ui";
import { ChevronDown, ChevronUp } from "@plume/ui/icons";
import { Fragment, memo, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Superseded } from "../markdown/useSmoothText.ts";
import { hasToolCard, ownsToolRow, TurnFooters, usePluginRegistrations, useQuoteActions } from "../plugins.tsx";
import { CompactionRow } from "./CompactionRows.tsx";
import { type Run, runKey } from "./grouping.ts";
import { HiccupRow } from "./HiccupRow.tsx";
import { intact } from "./intact.ts";
import { useTranscriptPrefs } from "./prefs.ts";
import { ResumeRow } from "./ResumeRow.tsx";
import { ModelSwitchRow } from "./ModelSwitchRow.tsx";
import { questionsIn, timeSeparators } from "./question-navigation.ts";
import { ConversationTime, QuestionNav } from "./QuestionNav.tsx";
import type { DraftQuote } from "./quote.ts";
import { QuoteMenu } from "./QuoteMenu.tsx";
import { type MessageEdits, MessageEditsContext } from "./message-edits.ts";
import { lastUserIndex } from "./revert-draft.ts";
import { flash, type RevealRequest, settleReveal, useRevealRequest } from "./reveal.ts";
import { MessageRow } from "./rows.tsx";
import { RunningRow } from "./RunningRow.tsx";
import { PluginToolCard } from "./ToolCard.tsx";
import { ToolCall, ToolStep } from "./ToolGroup.tsx";
import { LEGACY_TOOL_ROWS } from "./tool-view.ts";
import { RunsCache, TurnBlocksCache } from "./transcript-shape.ts";
import type { TurnBlock } from "./turn-blocks.ts";
import { latestFooterTimestamp } from "./turn-footer.ts";
import { CARRY_ON_PROMPTS, resumeOf } from "./turn-stop.ts";
import { type TurnEntry, TurnWork } from "./TurnWork.tsx";
import {
	type BackgroundJobInfo,
	type CallState,
	createCallLive,
	createCallState,
	expandInTranscript,
	Transcript as TranscriptContext,
	TranscriptCalls,
	TranscriptLive,
	type TranscriptState,
	useTranscriptWindow,
	WINDOW_TURNS,
} from "./view-state.ts";
import { WorkStep } from "./WorkStep.tsx";

export function Transcript({
	view,
	onCarryOn,
	onOpenSettings,
	onQuote,
	onSend,
	edits,
	renderUserMessage,
	replyText,
}: Pick<ConversationProps, "renderUserMessage" | "replyText"> & {
	view: SessionView;
	/**
	 * 以界面的名义说一句「继续」。要稳定的引用：`draw` 跟着它换，`WorkStep` 的 memo 拿 `draw` 判断。
	 * 不给就没有「继续」的入口（插件的子会话：那里的一轮只有插件能发起）。
	 */
	onCarryOn?: (prompt: string) => void;
	onSend?: (text: string, displayText?: string) => Promise<void>;
	onOpenSettings: () => void;
	/** 划下的一段引用到输入框。要稳定的引用：划词菜单按它 memo。 */
	onQuote: (quote: DraftQuote) => void;
	/** 撤回、编辑、分叉。不给就没有（插件的子会话）。 */
	edits?: MessageEdits;
}) {
	const id = view.summary.id;
	const quoteActions = useQuoteActions();
	const running = view.summary.running;
	const { showThinking } = useTranscriptPrefs();
	// 插件登记的卡片变了，哪些调用单独成行跟着变：修订号进分组的依赖。
	const plugins = usePluginRegistrations();
	/*
	 * 读不出来的记录换成一行说明，放在原位：一条坏记录不该让整个转录白掉，见 `intact`。下面凡是读落了盘的消息的都读这一份。
	 * 落了盘的那段单独查：草稿每一拍都换，跟着从头查的话，一条坏记录每拍都报一遍错，换上的那一行每拍又是新对象，分行接不上检查点。
	 */
	const settledMessages = useMemo(() => intact(view.messages), [view.messages]);
	// 正在写的那条回复接在落了盘的后面：它的位置就是它写完后的位置，换过来时行不卸掉重挂。
	const messages = useMemo<readonly Message[]>(
		() => (view.draft ? [...settledMessages, ...intact([view.draft])] : settledMessages),
		[settledMessages, view.draft],
	);
	// 派出去的后台运行没回来也不算答完：派完那一轮就收了尾，交付卡片这时挂出来，回来接着跑时又收掉。
	const footerTimestamp = latestFooterTimestamp(settledMessages, running || view.summary.background === true);
	const lastUser = useMemo(() => lastUserIndex(settledMessages), [settledMessages]);
	const { results, jobs } = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		// 放到后台的命令：启动它的那次调用写的说明，查它输出的那几行要说是哪个任务。
		const described = new Map<string, string>();
		const started = new Map<string, BackgroundJobInfo>();
		for (const message of settledMessages) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const description = (block.arguments as { description?: unknown } | undefined)?.description;
					if (typeof description === "string" && description.trim()) described.set(block.id, description.trim());
				}
			}
			if (message.role !== "toolResult") continue;
			map.set(message.toolCallId, message);
			// 在后台起了任务的调用，插件在结果里声明（`BackgroundJobDetails`），不认是哪个工具。
			const job = (message.details as { job?: { id?: unknown; command?: unknown } } | undefined)?.job;
			if (job && typeof job.id === "string") {
				const description = described.get(message.toolCallId);
				started.set(job.id, {
					...(description ? { description } : {}),
					...(typeof job.command === "string" ? { command: job.command } : {}),
				});
			}
		}
		return { results: map, jobs: started };
	}, [settledMessages]);
	const state = useMemo<TranscriptState>(
		() => ({
			sessionId: id,
			cwd: view.summary.cwd,
			...(view.summary.parentId ? { child: true } : {}),
			...(onSend ? { send: onSend } : {}),
		}),
		[id, view.summary.cwd, view.summary.parentId, onSend],
	);
	const approval = view.approval?.toolCallId;
	const background = view.backgroundCalls ?? NO_BACKGROUND;
	const calls = useMemo<CallState>(
		() => ({ running, results, jobs, background, ...(approval ? { approval } : {}) }),
		[running, results, jobs, background, approval],
	);
	/*
	 * 调用的结果和执行中的输出各一个仓：只有那几次调用的卡重画，见 `CallState`、`CallLive`。没跟着重画的卡在布局阶段收到通知，
	 * 在这一帧画出来之前就跟上；调用的结果在画子行之前先换上，见 `CallStateStore`。
	 */
	const [callState] = useState(() => createCallState(calls));
	callState.stage(calls);
	useLayoutEffect(() => callState.flush(), [callState, calls]);
	const [live] = useState(() => createCallLive({ progress: view.progress, startedAt: view.startedAt }));
	useLayoutEffect(() => live.set({ progress: view.progress, startedAt: view.startedAt }), [live, view.progress, view.startedAt]);

	// 每拍只重算最后一轮，结果和从头算逐项相同，见 `transcript-shape.ts`。换会话时整个换掉：检查点是这个会话的。
	const shape = useMemo(() => ({ id, runs: new RunsCache(), blocks: new TurnBlocksCache() }), [id]);
	// 推理默认不画，见 `withoutThinking`。插件登记的卡片变了，哪些调用单独成行跟着变：修订号交给缓存，变了就从头算。
	const allRuns = useMemo(
		() =>
			shape.runs.runs(
				messages,
				{ settledCount: view.messages.length, hiccups: view.hiccups, compactionRuns: view.compactionRuns, ownCard: ownsToolRow },
				showThinking,
				plugins,
			),
		[shape, messages, view.messages.length, view.hiccups, view.compactionRuns, showThinking, plugins],
	);
	// 先分块，再开窗：窗口按轮走，翻一次必然多出整轮。跑着的那一轮从发出就按有过程分，见 `turnBlocks` 的 `live`。
	const allBlocks = useMemo(() => shape.blocks.turnBlocks(allRuns, running), [shape, allRuns, running]);
	const range = useTranscriptWindow(id, WINDOW_TURNS, allBlocks.length);
	const blocks = useMemo(() => allBlocks.slice(range.start, range.end), [allBlocks, range.start, range.end]);
	const hidden = range.start;
	const more = Math.min(WINDOW_TURNS, allBlocks.length - range.end);

	// 结果落地、开始等确认、压缩那一行换了说法，页面变了而消息没变：算进「最后一行变了」。
	const follow = useFollowBottom({
		surfaceId: id,
		namespace: "transcript",
		live: running,
		count: messages.length,
		tail: tailSignature(messages, `${results.size}:${view.approval?.toolCallId ?? ""}:${compactionTail(view.compactionRuns)}`),
	});

	/*
	 * 人发了一句话就回到底部，不管翻到了哪儿：回答在末尾，留在原处就是盯着一块什么都不发生的屏幕。
	 * 按最后一句人说的话认：换会话时它也变，但那时 `useFollowBottom` 自己会恢复位置，所以只认同一个会话里的变化。
	 *
	 * 插话（`steered`）不按落进转录的那一刻认：模型做完手上这一步才读到它，那时人可能早翻上去在读别的了。按它上了排队条的那一刻
	 * （人刚按下回车）认，而且只在人离开了底部时才回去：本来就贴着底部的，跟着跳一次会在转录末尾闪一帧。
	 */
	const lastAsk = messages.findLast((message) => message.role === "user" && !message.synthetic && !message.steered)?.timestamp;
	const lastSteer = view.queue.findLast((entry) => entry.steered)?.id;
	const asked = useRef({ id, lastAsk, lastSteer });
	const away = useRef(follow.away);
	away.current = follow.away;
	const { returnToBottom } = follow;
	useLayoutEffect(() => {
		const before = asked.current;
		asked.current = { id, lastAsk, lastSteer };
		if (before.id !== id) return;
		const steered = lastSteer !== undefined && before.lastSteer !== lastSteer && away.current;
		if (before.lastAsk === lastAsk && !steered) return;
		range.latest();
		returnToBottom(true);
		// `range` 每次渲染都是新的，不进依赖：这里只认那一句话。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, [id, lastAsk, lastSteer, returnToBottom]);

	/*
	 * 时间线和问题导航只看落了盘的消息：它们问的是人说过的话，正在写的那条回复每拍都换，跟着重算是白算。按内容记住时间线，
	 * 不按数组：它进了 `draw` 的依赖，身份一换 `WorkStep` 的 memo 就形同虚设。
	 */
	const separatorKey = useMemo(() => [...timeSeparators(settledMessages)].join(","), [settledMessages]);
	const separators = useMemo(() => new Set(separatorKey ? separatorKey.split(",").map(Number) : []), [separatorKey]);
	const questions = useMemo(() => questionsIn(settledMessages, translate("questionNav.imageMessage")), [settledMessages]);

	/*
	 * 跳到第几问。窗口按块走，所以要的是「这一问在哪一块里」：先把那一块挂上，挂上以后的那次布局里再滚过去。
	 * 目标挂着、它下面挂着的东西却不够把它顶到顶上时，先把窗口往后放一截，下一次再滚：否则问题停在屏幕半中间。
	 */
	const [jump, setJump] = useState<{ index: number; block: number } | null>(null);
	const { scrollTo, detach } = follow;
	const jumpToQuestion = (index: number) => {
		const block = allBlocks.findIndex((candidate) => candidate.runs.some((run) => run.kind === "message" && run.index === index));
		if (block < 0) return;
		detach();
		range.reveal(block);
		setJump({ index, block });
	};
	useLayoutEffect(() => {
		const element = follow.scrollRef.current;
		if (!jump || !element) return;
		const target = element.querySelector<HTMLElement>(`[data-question-index="${jump.index}"]`);
		if (!target) {
			if (jump.block >= range.start && jump.block < range.end) setJump(null);
			return;
		}
		const top = element.scrollTop + target.getBoundingClientRect().top - element.getBoundingClientRect().top - 40;
		if (top > element.scrollHeight - element.clientHeight + 1 && range.end < allBlocks.length) {
			range.later();
			return;
		}
		scrollTo(top);
		setJump(null);
		// `range.later` 每次渲染都是新的；这里只认跳转请求和窗口的两头。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, [jump, range.start, range.end, allBlocks.length, scrollTo]);

	/*
	 * 插件请这个会话把某次调用的卡片摆到中间（`ui.revealToolCall`）：和跳到第几问同一个办法，先把那一块挂上，
	 * 挂上以后的那次布局里滚过去、闪一下。会话还没读完时找不到那一块，等读完了再取。
	 */
	const reveal = useRevealRequest(id);
	const [revealing, setRevealing] = useState<(RevealRequest & { block: number }) | null>(null);
	// 转录换了会话而不重挂：上一个会话没找完的那次作废。
	if (revealing && revealing.sessionId !== id) setRevealing(null);
	useLayoutEffect(() => {
		if (!reveal) return;
		const block = allBlocks.findIndex((candidate) =>
			candidate.runs.some((run) => run.kind === "tools" && run.calls.some((call) => call.block.id === reveal.toolCallId)),
		);
		if (block < 0) return;
		settleReveal(reveal.nonce);
		// 合成一段活的几次调用收在点开以后（`Collapse` 收着时不挂里面的行），先替人点开那一段。
		const step = allBlocks[block]!.items.find(
			(item) =>
				item.kind === "step" && (!LEGACY_TOOL_ROWS || item.step.members.length > 1) && item.step.calls.some((call) => call.block.id === reveal.toolCallId),
		);
		if (step) expandInTranscript(id, step.key);
		detach();
		range.reveal(block);
		setRevealing({ ...reveal, block });
		// `range` 每次渲染都是新的；这里只认请求和分好的块。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, [reveal, allBlocks, detach]);
	useLayoutEffect(() => {
		const element = follow.scrollRef.current;
		if (!revealing || !element) return;
		const target = element.querySelector<HTMLElement>(`[data-tool-call="${CSS.escape(revealing.toolCallId)}"]`);
		if (!target) {
			// 那一块已经挂上了还找不到（这次调用没画成一张卡，比如并进同一行的再查一次）：放下这次，不一直等着。
			if (revealing.block >= range.start && revealing.block < range.end) setRevealing(null);
			return;
		}
		const box = target.getBoundingClientRect();
		const top = element.scrollTop + box.top - element.getBoundingClientRect().top - Math.max(40, (element.clientHeight - box.height) / 2);
		scrollTo(Math.max(0, top));
		flash(target, motionReduced());
		setRevealing(null);
		// 只认请求和窗口的两头：挂上那一块以后再找一次。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, [revealing, range.start, range.end, scrollTo]);

	const retrying = view.hiccups.some((hiccup) => hiccup.outcome === "waiting");
	const resume = onCarryOn ? resumeOf(view) : null;

	/*
	 * 一个 Run 画成哪一行。依赖齐了它才换，`ToolStep`、`ProcessBlock` 的 memo 拿它的引用判断画出来的行会不会变。
	 *
	 * 会话跑没跑、最后一句人话是哪句、哪句上面画时间，三样只有个别行要看，经 ref 读、不进依赖：进了的话每发一句、每收一轮
	 * `draw` 都换引用，窗口里每一轮的过程块和工具组整片重画，发送那一下卡一拍。要看它们的行照样跟着变：`continued` 只给最后
	 * 一轮，那一块的 `live` 随会话跑没跑一起变；时间线只画在开一轮的人话上，那些行不在过程块里、每次都重画；过程块里的人话
	 * （插话）是不是最后一句，由 `ProcessBlock` 的 `lastUser` 告诉它。
	 */
	const rows = useRef({ running, lastUser, separators });
	rows.current = { running, lastUser, separators };
	const draw = useCallback(
		(run: Run): ReactNode => {
			const { running, lastUser, separators } = rows.current;
			const key = runKey(run);
			if (run.kind === "hiccup")
				return (
					<HiccupRow
						key={key}
						hiccup={run.hiccup}
						{...(onCarryOn ? { onCarryOn: () => onCarryOn(CARRY_ON_PROMPTS[1]) } : {})}
						onOpenSettings={onOpenSettings}
					/>
				);
			if (run.kind === "compaction") return <CompactionRow key={key} run={run.compaction} />;
			if (run.kind === "model") return <ModelSwitchRow key={key} from={run.from} to={run.to} />;
			// 走到这里的工具段只有插件自己画卡片的那种：其余的都在 `turnBlocks` 里收成了 `WorkStep`。
			if (run.kind === "tools")
				return (
					<Fragment key={key}>
						{run.calls.map((call) => (
							<PluginToolCard key={call.block.id} call={call} {...(LEGACY_TOOL_ROWS ? {} : { fallback: <ToolCall call={call} /> })} />
						))}
					</Fragment>
				);
			const row = (
				<MessageRow
					key={key}
					viewKey={key}
					message={run.message}
					index={run.index}
					last={run.index === lastUser}
					upTo={run.upTo}
					from={run.from}
					// 页脚只给一轮的最后一句；还在跑的那一轮谁是最后一句还没定，见 `Run.newest`。
					continued={!run.closes || (running && run.newest === true)}
					pauses={run.pauses}
					trailer={run.trailer}
					// 和分组一起算的：它的身份只在转录变了时才换，见 `grouping.ts` 的 `Run`。
					turnStats={run.turnStats}
					showThinking={showThinking}
					ownCard={hasToolCard}
					{...(renderUserMessage ? { renderUserMessage } : {})}
					{...(replyText ? { replyText } : {})}
				/>
			);
			if (run.message.role !== "user" || run.message.synthetic) return row;
			// 人问的一句：问题导航按 `data-question-index` 认读到了第几问、跳到哪；隔了一阵再说的，上面画一条时间。
			// 插话不是一问（`questionsIn` 不收它），不标：标了的话读过它，导航找不到这一问，跳回第一问。
			return (
				<Fragment key={key}>
					{separators.has(run.index) && <ConversationTime timestamp={run.message.timestamp} />}
					<div data-question-index={run.message.steered ? undefined : run.index}>{row}</div>
				</Fragment>
			);
		},
		// `plugins`：登记的卡片变了，画出来的也跟着变。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
		[onCarryOn, onOpenSettings, showThinking, plugins, renderUserMessage, replyText],
	);

	/*
	 * 读者停在底部时，把往上翻时多挂出来的那几轮收回去：不收的话它们一直挂着、按会话记着，往回翻过几次的会话每次布局都按几倍的量算。
	 * 回到末尾那一下（`latest`）不收，见那里；这里只在真的停在底部、要收的整轮都在视口上方一屏以外时收，按轮的边界收。
	 * 收掉的在视口上方，浏览器的滚动锚定和跟随底部（`pin`）都把眼前的留在原处。
	 * 还得是离开过底部一屏以上又回来的：转录短到一屏装得下时，停在底部点「显示更早」，挂出来的那几轮不能当场又被收回去。
	 */
	const rowsRef = useRef<HTMLDivElement>(null);
	const trimFacts = useRef({ blocks, end: range.end, total: allBlocks.length, keepLast: range.keepLast });
	trimFacts.current = { blocks, end: range.end, total: allBlocks.length, keepLast: range.keepLast };
	const leftBottom = useRef(false);
	useLayoutEffect(() => {
		leftBottom.current = false;
	}, [id]);
	const followScroll = follow.onScroll;
	const onScroll = useCallback(
		(el: HTMLDivElement) => {
			followScroll(el);
			const { blocks: mounted, end, total, keepLast } = trimFacts.current;
			const rows = rowsRef.current;
			const fromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
			if (fromBottom > el.clientHeight) leftBottom.current = true;
			if (!rows || !leftBottom.current || end !== total || mounted.length <= WINDOW_TURNS || fromBottom > 2) return;
			const frames = rows.querySelectorAll(":scope > [data-plume-turn]");
			const above = el.getBoundingClientRect().top - el.clientHeight;
			const turns = turnsOf(mounted);
			let cut = 0;
			for (const [index, next] of turns.slice(1).entries()) {
				// 第 `index` 轮整个在上面那一屏以外：下一轮的顶边还在那条线上方。
				if (mounted.length - next.from < WINDOW_TURNS || !(frames[index + 1]!.getBoundingClientRect().top <= above)) break;
				cut = next.from;
			}
			if (cut === 0) return;
			leftBottom.current = false;
			keepLast(mounted.length - cut);
		},
		[followScroll],
	);

	return (
		<TranscriptContext.Provider value={state}>
			{/* 没给的转录清成 null：嵌在主对话卡片里的子转录不能借到主对话的这三样。 */}
			<MessageEditsContext.Provider value={edits ?? null}>
				<TranscriptCalls.Provider value={callState}>
					<TranscriptLive.Provider value={live}>
						{/* `@container`：栏太窄时问题导航贴到最边上、左右内衬对称，按这一栏量，不按窗口量。 */}
						<div className="@container relative flex min-h-0 flex-1 flex-col">
							<Scroller
								className="flex-1"
								// 底下留出「回到最新」的高度，它不压在最新那条消息上。见 `scroll.css` 的 `--plume-bottom-inset`。
								// 左边让出问题导航那一条；栏窄于 520 时导航贴边，两边一样宽，正文不显得被推向右边。
								contentClassName="px-7 pt-5 pb-[var(--plume-bottom-inset)] @min-[520px]:pr-6 @min-[520px]:pl-12"
								fadeTop={32}
								/*
								 * 跟着底部走的时候底下不渐隐：输出时内容每长一截就离底几像素、追上又贴底，渐隐跟着一开一合，每一次都是遮罩深度
								 * 变一下、整块转录重画一遍。读者滚开了才是「下面还有」，那时再淡。
								 */
								bottom={follow.away ? "fade" : "none"}
								scrollRef={follow.scrollRef}
								onScroll={onScroll}
								onResize={follow.onResize}
								onUserScroll={follow.onUserScroll}
								onHold={follow.hold}
							>
								{/* 一个会话一棵树：换会话时整棵重挂，运行行的停留、展开过的连接记录这些行里的状态不带到另一个会话。 */}
								<div key={id} className="mx-auto flex w-full max-w-[var(--plume-content)] flex-col" data-plume-session={id}>
									{/* 只挂最近的几轮：一天的会话上千条消息，全挂上每次重绘都要走整棵树。其余的点一下才挂。 */}
									{hidden > 0 && (
										<div className="mb-4 flex items-center justify-center">
											<Button size="sm" icon={<ChevronUp size={14} />} onClick={range.earlier} data-plume-show-earlier="">
												{/* 「共 N 轮」只在它确实是另一个数字时才出现。 */}
												{hidden > WINDOW_TURNS
													? translate("conversation.showEarlier", { n: WINDOW_TURNS, total: hidden })
													: translate("conversation.showEarlierRest", { n: hidden })}
											</Button>
										</div>
									)}
									<div ref={rowsRef} className="flex flex-col gap-2.5" data-plume-transcript-rows="">
										{turnsOf(blocks).map(({ turn, from, count }) => (
											<TurnFrame key={`turn:${turn}`} settled={turn !== allBlocks[allBlocks.length - 1]?.turn}>
												{blocks.slice(from, from + count).map((block, offset) => {
													const at = from + offset;
													// 后面已经开了下一轮：这一轮里还在演的字一次补齐，见 `Superseded`。不按有没有下一轮决定套不套：套上、拿掉会让整块重挂。
													const superseded = block.turn !== allBlocks[allBlocks.length - 1]?.turn;
													if (block.kind === "plain") {
														const run = block.runs[0];
														return run ? (
															<Superseded.Provider key={runKey(run)} value={superseded}>
																{draw(run)}
															</Superseded.Provider>
														) : null;
													}
													/*
													 * 按开这一轮的那句话起名，不按第一行：跑着的那一轮刚发出时下面是空的，第一行等它开口才有。
													 * 按第一行起名，开口那一下整块就卸掉重建。没有开口那句的（会话的第 0 轮）才退回第一行。
													 */
													const opener = allBlocks[range.start + at - 1];
													const head = (opener?.turn === block.turn ? opener : block).runs[0];
													const key = `process:${head ? runKey(head) : block.turn}`;
													// 按回合算，不按块的位置：正文一开始流式输出，过程就不再排在末尾。和全部的最后一轮比，不和窗口里的：往回翻过页，窗口末尾不是在跑的那一轮。
													const live = running && block.turn === allBlocks[allBlocks.length - 1]?.turn;
													return (
														<Superseded.Provider key={key} value={superseded}>
															<ProcessBlock block={block} live={live} draw={draw} lastUser={holds(block, lastUser) ? lastUser : undefined} />
														</Superseded.Provider>
													);
												})}
											</TurnFrame>
										))}
										{range.end === allBlocks.length && footerTimestamp !== null && <TurnFooters session={view} timestamp={footerTimestamp} />}
									</div>
									{more > 0 && (
										<div className="my-3 flex items-center justify-center">
											<Button size="sm" icon={<ChevronDown size={14} />} label={translate("conversation.showLaterN", { n: more })} onClick={range.later} />
										</div>
									)}
									{range.end === allBlocks.length && (
										<>
											{/* 一整轮都在，不随每次工具调用来去；结论在来的时候这一行只是看不见、高度不变。见 `RunningRow`。 */}
											<RunningRow
												running={running}
												compacting={view.compacting}
												messages={messages}
												startedAt={view.startedAt}
												waiting={view.approval === undefined ? undefined : view.approval.type === "request" ? "answer" : "approval"}
												waitingText={view.approval?.type === "request" ? view.approval.waiting : undefined}
												retrying={retrying}
												handedOff={resume !== null}
											/>
											{onCarryOn && resume && <ResumeRow view={view} resume={resume} onCarryOn={onCarryOn} />}
											{/* 转录的末尾，作为一个元素：它进了视口，就是读者跟上了。零高度，不改变它报告的布局。 */}
											<div ref={follow.tailRef} aria-hidden className="h-px w-full shrink-0" />
										</>
									)}
								</div>
								{/* 贴底收起后留在底下的那块空，见 `FollowBottom.slackRef`。在会话那一栏外面：它不是转录的内容。 */}
								<div ref={follow.slackRef} aria-hidden className="w-full shrink-0" />
							</Scroller>
							<BackToLatest
								show={follow.away || range.end < allBlocks.length}
								unread={follow.unread}
								onClick={() => {
									range.latest();
									follow.returnToBottom();
								}}
							/>
							{view.summary.kind === "top" && <QuoteMenu scrollRef={follow.scrollRef} onQuote={onQuote} sessionId={id} actions={quoteActions} />}
							{questions.length > 1 && <QuestionNav key={id} questions={questions} viewport={follow.scrollRef} onSelect={jumpToQuestion} />}
						</div>
					</TranscriptLive.Provider>
				</TranscriptCalls.Provider>
			</MessageEditsContext.Provider>
		</TranscriptContext.Provider>
	);
}

/** 没有调用在后台留着事时的那一份：身份不变，调用仓不因此换一份。 */
const NO_BACKGROUND: Readonly<Record<string, BackgroundCallState>> = {};

/**
 * 有过程的一轮。按块 memo：前面那几轮的块在流式时原样沿用（见 `TurnBlocksCache`），每一拍只有在写的那一轮重新摊开。
 * `live`：这一轮还在跑。
 */
const ProcessBlock = memo(function ProcessBlock({
	block,
	live,
	draw,
}: {
	block: TurnBlock;
	live: boolean;
	draw: (run: Run) => ReactNode;
	/** 最后一句人话在这一块里时是它的位置（插进这一轮的话）：换了最后一句，前后那两块跟着重画，`draw` 经 ref 读到新的。 */
	lastUser: number | undefined;
}) {
	// 订阅界面语言：memo 挡住了上层的重画，换语言时这一块里经 `translate` 说的字（工具行、运行行）要跟着换。
	useI18n();
	const tail = block.items[block.items.length - 1];
	const entries: TurnEntry[] = block.items.map((item) => ({
		key: item.key,
		// 正在做的那一段是这一轮的最后一行：后面有了别的（下一段活、一句话），它就做完了。
		node:
			item.kind !== "step" ? (
				draw(item.run)
			) : LEGACY_TOOL_ROWS ? (
				<WorkStep step={item.step} live={live && item === tail} draw={draw} />
			) : (
				<ToolStep step={item.step} live={live && item === tail} draw={draw} />
			),
	}));
	return <TurnWork entries={entries} />;
});

/** 窗口里的块按轮分段：连着的同一轮是一段，`from` 是它在窗口里的第一块。 */
function turnsOf(blocks: readonly TurnBlock[]): { turn: number; from: number; count: number }[] {
	const out: { turn: number; from: number; count: number }[] = [];
	for (const [at, block] of blocks.entries()) {
		const last = out[out.length - 1];
		if (last && last.turn === block.turn) last.count++;
		else out.push({ turn: block.turn, from: at, count: 1 });
	}
	return out;
}

/**
 * 一轮的外框。后面又开了一轮（`settled`）以后，它在屏幕外时不布局也不画（`content-visibility`，见 conversation.css）。
 *
 * 不这样的话，屏幕外挂着的每一轮在宽度一变时都要整段重新断行：拖侧栏、面板区的分隔线，拖窗口，长对话每一帧都是一次全量布局，
 * 点过「显示更早」的会话更重。最后一轮不跳：它在写，跳过的话屏幕外长高不算进滚动高度，跟随底部和「回到最新」都量不准。
 *
 * 开跳之前先把这一刻的真高度写进 `contain-intrinsic-block-size`：一块从没画过就跳过时，浏览器按这个值给它占位，
 * 不写的话占位是零，换会话回来按 `scrollTop` 放回读的位置就落到别处。之后的 `auto` 让浏览器记住它每次画出来的高度。
 * 宽度变了、它在屏幕外时高度停在上一次画出来的那样，滚到它那里才重新断行，那时它在视口上方，浏览器的滚动锚定补得上。
 */
function TurnFrame({ settled, children }: { settled: boolean; children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element || !settled) return;
		element.style.containIntrinsicBlockSize = `auto ${element.getBoundingClientRect().height}px`;
		element.setAttribute("data-plume-turn-skip", "");
		return () => {
			element.removeAttribute("data-plume-turn-skip");
			element.style.containIntrinsicBlockSize = "";
		};
	}, [settled]);
	return (
		<div ref={ref} data-plume-turn="" className="flex flex-col gap-2.5">
			{children}
		</div>
	);
}

/** 这一块里有没有第 `index` 条消息画成的那一行。 */
function holds(block: TurnBlock, index: number): boolean {
	return block.runs.some((run) => run.kind === "message" && run.index === index);
}

/** 最后那一行压缩此刻的样子：它换了说法（写摘要 → 等重试 → 压完），转录底部跟着变。 */
function compactionTail(runs: SessionView["compactionRuns"]): string {
	const last = runs.at(-1);
	return last ? `${last.id}:${last.status}:${last.phase}:${last.retries}` : "";
}
