import type { DeliveredReport, SessionView, UserMessage } from "@plume/contract";
import type { AgentDeliveryProps, ComposerAboveProps, PanelProps, Remote, ToolCardProps, TurnFooterProps, UiContext, UiPlugin } from "@plume/contract/ui";
import {
	AgentAvatar,
	AvatarPile,
	Collapse,
	Button,
	Card,
	Caret,
	FlowRow,
	IconButton,
	MenuBody,
	MenuItem,
	PanelEmpty,
	Popover,
	Text,
	useI18n,
	usePopover,
} from "@plume/ui";
import {
	Bot,
	Check,
	ChevronRight,
	CircleStop,
	Copy,
	CornerLeftUp,
	CornerRightDown,
	Play,
	RotateCcw,
	SquareArrowOutUpRight,
	TriangleAlert,
	UserX,
} from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import type { SubagentsApi } from "./api.ts";
import type { DeliveryDetails } from "./delivery.ts";
import { callCount, elapsed, ordered } from "./format.ts";
import { fill, MESSAGES } from "./messages.ts";
import { AgentsSection, connectSettings } from "./settings.tsx";
import { connectStructured, hasContent, StructuredOutput } from "./structured.tsx";
import { avatarOf, type Avatars, connect, choose, retryRoster, useAvatars, useChosen, useRoster } from "./ui-state.ts";
import { descriptionOf, dispatchFromProgress, isActive, isDispatch, reportProse, wayBack, type TaskRecord } from "./types.ts";
import css from "./subagents.css";

const PANEL = "agents";
const moods = { queued: "waiting", running: "working", done: "done", failed: "failed", stopped: "stopped" } as const;

function face(task: TaskRecord, avatars: Avatars) {
	return { key: task.id, avatar: avatarOf(avatars, task.agent), mood: moods[task.state], seed: task.agent };
}

/** 和设置页是同一张脸：按父会话目录下的名单排。 */
function Face({ task, size = 22 }: { task: TaskRecord; size?: number }) {
	const { key: _key, ...props } = face(task, useAvatars(task.parent));
	return <AgentAvatar {...props} size={size} host="[data-plume-avatar-host]" />;
}
let ui: UiContext;
let api: Remote<SubagentsApi>;

function reveal(task: Pick<TaskRecord, "parent" | "session">): void {
	choose(task.parent, task.session);
	ui.openPanel(PANEL, task.parent);
}

function useClock(running: boolean): void {
	const [, tick] = useState(0);
	useEffect(() => {
		if (!running) return;
		const timer = window.setInterval(() => tick((n) => n + 1), 1000);
		return () => window.clearInterval(timer);
	}, [running]);
}

function Status({ task, child }: { task: TaskRecord; child?: SessionView }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	useClock(task.state === "running");
	const waiting = task.state === "running" && child?.hiccups.some((hiccup) => hiccup.outcome === "waiting");
	const activity = child?.approval ? text.awaiting : waiting ? text.retrying : text[task.state];
	const clock = task.startedAt ? fill(task.state === "running" ? text.elapsed : text.ran, { time: elapsed(task) }) : undefined;
	return (
		<Text size="caption" tone={task.state === "failed" ? "danger" : child?.approval ? "accent" : "faint"} numeric>
			{[activity, clock, fill(text.calls, { n: callCount(child) })].filter(Boolean).join(" · ")}
		</Text>
	);
}

/**
 * 它此刻在做什么——「它是不是卡住了」就在这一行上回答。跑着却还没调过工具时不说：状态那一句已经写了「进行中」，再说一遍是重复。
 * `inline`：接在输入框上方那一行的描述后面，和描述同一个字号、用「·」隔开。
 */
function Activity({ task, inline = false }: { task: TaskRecord; inline?: boolean }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const child = ui.useSession(task.session);
	const retrying = child?.hiccups.some((hiccup) => hiccup.outcome === "waiting");
	const live = [...(child?.messages ?? []), ...(child?.draft ? [child.draft] : [])]
		.flatMap((message) => (message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : []))
		.findLast((call) => child?.startedAt[call.id] !== undefined);
	const doing = child?.approval
		? text.awaiting
		: retrying
			? text.retrying
			: live
				? descriptionOf(live.arguments) || live.name
				: task.state === "running"
					? undefined
					: text[task.state];
	if (!doing) return null;
	return (
		<Text size={inline ? "detail" : "caption"} tone={child?.approval ? "accent" : "faint"} className="subagents-truncate">
			{inline ? `· ${doing}` : doing}
		</Text>
	);
}

/**
 * 对话里的一次派发，一张卡片：派出去的是一个会自己干一阵子活的「人」，行首是它的脸——表情跟着它此刻怎么样（颠着干活、
 * 眯眼排队、弯眼交差、叉眼出错），整张卡片上悬停时眼睛跟着指针。
 */
function TaskCard({ call, progress, result, fallback }: ToolCardProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const dispatch = isDispatch(result?.details) ? result.details : dispatchFromProgress(progress);
	const roster = useRoster(dispatch?.parent);
	const avatars = useAvatars(dispatch?.parent);
	const child = ui.useSession(dispatch?.session);
	if (!dispatch || (result && !isDispatch(result.details))) return <>{fallback}</>;
	const task = roster.tasks.find((entry) => entry.id === dispatch.id);
	return (
		<div data-plume-avatar-host="">
			<Card
				title={
					<span className="subagents-line">
						<AgentAvatar
							avatar={avatarOf(avatars, dispatch.agent)}
							size={18}
							mood={task ? moods[task.state] : "done"}
							seed={dispatch.agent}
							host="[data-plume-avatar-host]"
						/>
						<Text className="subagents-truncate">{task?.description || descriptionOf(call.args) || text.untitled}</Text>
					</span>
				}
				subtitle={`@${dispatch.agent}`}
				tone={task?.state === "failed" ? "error" : "default"}
				status={
					<span className="subagents-line">
						{task && <Status task={task} child={child} />}
						<IconButton
							size="sm"
							label={fill(text.reveal, { name: dispatch.agent })}
							icon={<SquareArrowOutUpRight size={12} />}
							onClick={() => reveal(dispatch)}
						/>
					</span>
				}
			/>
		</div>
	);
}

/** 一份回报是什么表情：和派发那一行、输入框上方那条用同一套。 */
function returnMood(report: DeliveredReport) {
	if (report.status === "failed") return "failed" as const;
	if (report.status === "aborted" || report.incomplete) return "stopped" as const;
	return "done" as const;
}

/**
 * 子智能体的结果到了：主智能体接下来那段话的题注——「消息来自 @谁」。和后台命令、来信同一个骨架，不是一颗按钮：
 * 一轮里回来三个就是三颗胶囊，比主智能体自己的话还显眼。回报本身在派发那一行和面板里都有，点一下翻到面板里它那一页。
 */
function AgentDelivery({ sessionId, reports }: AgentDeliveryProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const avatars = useAvatars(sessionId);
	const roster = useRoster(sessionId);
	if (reports.length === 0) return null;
	const agentOf = (report: DeliveredReport) => (report.details as DeliveryDetails | undefined)?.agent ?? "";
	const one = reports.length === 1 ? reports[0] : undefined;
	const failed = reports.filter((report) => report.status === "failed").length;
	const outcome = (report: DeliveredReport) => (report.status === "failed" ? text.returnFailed : report.incomplete ? text.returnPartial : text.returnDone);
	const tip = reports
		.map((report) => fill(text.returnTip, { name: report.title || agentOf(report), agent: agentOf(report), outcome: outcome(report) }))
		.join("\n");
	const first = roster.tasks.find((task) => task.id === reports[0]!.id);
	return (
		<div data-delivery-row="" data-delivery-kind="agent" data-plume-avatar-host="">
			<FlowRow
				icon={
					one ? (
						<AgentAvatar avatar={avatarOf(avatars, agentOf(one))} size={14} mood={returnMood(one)} seed={agentOf(one)} host="[data-plume-avatar-host]" />
					) : (
						<AvatarPile
							faces={reports.map((report) => ({ key: report.id, avatar: avatarOf(avatars, agentOf(report)), mood: returnMood(report), seed: agentOf(report) }))}
							size={14}
							max={4}
						/>
					)
				}
				// 装的是名字，和来信那一行一样不加粗。
				title={<span className="subagents-plain">{one ? fill(text.fromOne, { agent: agentOf(one) }) : fill(text.fromMany, { n: reports.length })}</span>}
				summary={one ? one.title : reports.map((report) => `@${agentOf(report)}`).join(" · ")}
				trailing={
					<>
						{failed > 0 && <Text tone="danger">{one ? text.returnFailed : fill(text.returnFailedCount, { n: failed })}</Text>}
						{/* 点开是去面板，不是就地展开：箭头自己画，`FlowRow` 那枚只给能展开的行。 */}
						<ChevronRight size={12} strokeWidth={2} aria-hidden />
					</>
				}
				onToggle={() => {
					if (first) reveal(first);
				}}
				label={tip}
				data-plume-tip={tip}
			/>
		</div>
	);
}

function RosterRow({ task, current, pick }: { task: TaskRecord; current?: string; pick: () => void }) {
	const child = ui.useSession(task.session);
	return (
		<MenuItem
			selected={current === task.session}
			onClick={pick}
			icon={<Face task={task} size={20} />}
			detail={
				<span className="subagents-meta">
					<Text size="caption" tone="faint">
						@{task.agent}
					</Text>
					<Status task={task} child={child} />
				</span>
			}
		>
			{task.description}
		</MenuItem>
	);
}

function RosterMenu({ tasks, current, onPick }: { tasks: TaskRecord[]; current?: string; onPick: (task: TaskRecord) => void }) {
	return (
		<MenuBody className="subagents-menu">
			{ordered(tasks).map((task) => (
				<RosterRow key={task.id} task={task} current={current} pick={() => onPick(task)} />
			))}
		</MenuBody>
	);
}

function Header({ task, tasks, child }: { task: TaskRecord; tasks: TaskRecord[]; child?: SessionView }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const menu = usePopover();
	const host = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(348);
	const many = tasks.length > 1;
	const avatars = useAvatars(task.parent);
	const title = (
		<>
			{many ? <AvatarPile faces={ordered(tasks).map((entry) => face(entry, avatars))} focus={task.id} size={26} max={3} /> : <Face task={task} />}
			<span className="subagents-title">
				<span className="subagents-line">
					<Text className="subagents-truncate">{task.description}</Text>
					{many && <Caret open={menu.open} />}
				</span>
				<span className="subagents-meta">
					<Text size="caption" tone="faint" mono>
						@{task.agent}
					</Text>
					<Status task={task} child={child} />
					{task.state === "running" && !child?.approval && !child?.hiccups.some((hiccup) => hiccup.outcome === "waiting") && <Activity task={task} />}
				</span>
			</span>
		</>
	);
	return (
		<header ref={host} className="subagents-header" data-sub-header="" data-plume-avatar-host="">
			{many ? (
				<button
					type="button"
					className="subagents-switch"
					aria-haspopup="menu"
					aria-expanded={menu.open}
					aria-label={text.pick}
					data-sub-switch=""
					onClick={(event) => {
						setWidth(Math.min(348, Math.max(240, (host.current?.clientWidth ?? 348) - 8)));
						menu.toggle(event);
					}}
				>
					{title}
				</button>
			) : (
				<div className="subagents-switch">{title}</div>
			)}
			{many && menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="start" width={width} label={text.panelTitle}>
					<RosterMenu
						tasks={tasks}
						current={task.session}
						onPick={(next) => {
							choose(task.parent, next.session);
							menu.close();
						}}
					/>
				</Popover>
			)}
			{isActive(task) && (
				<IconButton
					tone="danger"
					label={text.stop}
					icon={<CircleStop size={14} />}
					onClick={() => {
						void api.stop(task.session).catch((error: unknown) => ui.notify(String(error), "error"));
					}}
				/>
			)}
		</header>
	);
}

/** 只在本屏挂上以后新派出的一批打开一次，更新进度、换会话和重挂都不抢走面板。 */
function AgentsBar({ session }: ComposerAboveProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const parent = session.summary.id;
	const roster = useRoster(parent);
	const tasks = ordered(roster.tasks.filter(isActive));
	const menu = usePopover();
	const picked = useChosen(parent);
	const avatars = useAvatars(parent);
	const [enter, setEnter] = useState(false);
	const observed = useRef<{ parent: string; ready: boolean; active: boolean }>({ parent, ready: false, active: false });
	useClock(tasks.some((task) => task.state === "running"));
	useEffect(() => {
		if (!roster.ready) return;
		const before = observed.current;
		if (before.parent === parent && before.ready && !before.active && tasks.length > 0) {
			setEnter(true);
			ui.openPanel(PANEL, parent);
		}
		observed.current = { parent, ready: true, active: tasks.length > 0 };
	}, [parent, roster.ready, tasks.length]);
	useEffect(() => {
		if (tasks.length < 2) menu.close();
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 只在任务数变了时收起菜单，menu 每次渲染都是新的
	}, [tasks.length]);
	// 退场时保留最后一份文字和头像，直到 Collapse 合上，避免先变成一块空白。
	const retained = useRef(tasks);
	if (tasks.length) retained.current = tasks;
	const shown = tasks.length ? tasks : retained.current;
	const lead = shown.find((task) => task.state === "running") ?? shown[0];
	const running = shown.filter((task) => task.state === "running").length;
	const queued = shown.length - running;
	const headline = !lead
		? ""
		: shown.length === 1
			? lead.description
			: running === 1
				? lead.description
				: running > 1
					? fill(text.nRunning, { n: running })
					: text.starting;
	return (
		<Collapse open={tasks.length > 0 || menu.open}>
			{lead && (
				<div
					className="subagents-bar"
					data-subagent-bar=""
					data-plume-avatar-host=""
					data-enter={enter || undefined}
					onAnimationEnd={(event) => {
						if (event.target === event.currentTarget) setEnter(false);
					}}
				>
					<button
						type="button"
						className="subagents-switch"
						aria-label={headline}
						aria-haspopup={shown.length > 1 ? "menu" : undefined}
						aria-expanded={shown.length > 1 ? menu.open : undefined}
						onClick={shown.length === 1 ? () => reveal(lead) : menu.toggle}
					>
						{shown.length === 1 ? <Face task={lead} size={18} /> : <AvatarPile faces={shown.map((task) => face(task, avatars))} size={22} max={4} />}
						<Text size="detail" tone="muted" className="subagents-truncate subagents-bar-headline">
							{headline}
						</Text>
						{shown.length === 1 && <Activity task={lead} inline />}
						{queued > 0 && shown.length > 1 && (
							<Text size="caption" tone="faint">
								{fill(text.nQueued, { n: queued })}
							</Text>
						)}
						<span className="subagents-spacer" />
						{running > 0 && (
							<Text size="caption" tone="faint" numeric>
								{elapsed(lead)}
							</Text>
						)}
						{shown.length > 1 && <Caret open={menu.open} />}
					</button>
					{shown.length > 1 && menu.open && (
						<Popover anchor={menu.anchor} onClose={menu.close} placement="top" align="start" width={348} label={text.panelTitle}>
							<RosterMenu
								tasks={shown}
								current={picked}
								onPick={(task) => {
									menu.close();
									reveal(task);
								}}
							/>
						</Popover>
					)}
				</div>
			)}
		</Collapse>
	);
}

function TaskBrief({ message, sessionId }: { message: UserMessage; sessionId: string }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [open, setOpen] = useState(false);
	const body = message.displayText ?? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const long = body.length > 420 || body.split("\n").length > 8;
	return (
		<section className="subagents-brief" data-sub-brief="">
			<header className="subagents-brief-head">
				<CornerRightDown size={13} aria-hidden />
				<Text size="caption" tone="faint">
					{text.brief}
				</Text>
			</header>
			<div className="subagents-brief-body" data-collapsed={long && !open}>
				<ui.Markdown text={body} sessionId={sessionId} />
			</div>
			{long && (
				<Button size="xs" variant="subtle" expanded={open} onClick={() => setOpen((was) => !was)}>
					{open ? text.collapse : text.more}
				</Button>
			)}
		</section>
	);
}

function Report({ task }: { task: TaskRecord }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1600);
		return () => window.clearTimeout(timer);
	}, [copied]);
	// 没跑完的标出来：正文第一句已经说了，但读的人是扫一眼，那一句会被当成正文略过。
	const partial = task.incomplete === true || task.state === "failed";
	const answer = task.answer ?? "";
	// 交了对象的画对象，不再把同一份写成字的 `answer` 叠在下面；对象里什么都没写时才退回那段字。
	const structured = task.output && hasContent(task.output) ? task.output : undefined;
	// 只画对象时，开头那句「为什么没跑完」会跟着 `answer` 一起不见，单独留一行。
	const note = task.incomplete && structured ? answer.split(/\n{2,}/)[0]!.replace(/^⚠\s*/, "") : undefined;
	return (
		<section className="subagents-report" data-sub-report="" data-partial={partial}>
			<header className="subagents-report-head">
				{partial ? <TriangleAlert size={13} aria-hidden /> : <CornerLeftUp size={13} aria-hidden />}
				<Text size="caption" tone={partial ? "danger" : "faint"}>
					{partial ? text.partialReport : task.reported ? text.report : text.notReported}
				</Text>
				<span className="subagents-spacer" />
				<IconButton
					size="sm"
					className="subagents-report-copy"
					label={copied ? text.copied : text.copy}
					icon={copied ? <Check size={13} /> : <Copy size={13} />}
					onClick={() => {
						void navigator.clipboard.writeText(answer).then(
							() => setCopied(true),
							(error: unknown) => ui.notify(String(error), "error"),
						);
					}}
				/>
			</header>
			{note && (
				<Text as="p" size="detail" tone="muted" className="subagents-report-note" data-sub-report-note="">
					{note}
				</Text>
			)}
			{structured ? (
				<StructuredOutput output={structured} warnings={task.warnings} sessionId={task.session} />
			) : (
				<ui.Markdown text={answer} sessionId={task.session} className="subagents-report-body" />
			)}
		</section>
	);
}

function WayBack({ task }: { task: TaskRecord }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [asked, setAsked] = useState(false);
	const way = wayBack(task);
	if (!way) return null;
	const resume = way === "resume";
	return (
		<div className="subagents-way-back" data-sub-resume={resume || undefined} data-sub-redispatch={!resume || undefined}>
			<Button
				size="sm"
				variant="subtle"
				disabled={asked}
				label={text.draftTip}
				icon={asked ? <Check size={13} /> : resume ? <Play size={13} /> : <RotateCcw size={13} />}
				onClick={() => {
					void ui.draftInSession(undefined, {
						text: fill(resume ? text.resumeDraft : text.redispatchDraft, { id: task.id, name: task.description, agent: task.agent, prompt: task.prompt }),
						replace: true,
					});
					setAsked(true);
				}}
			>
				{asked ? text.drafted : resume ? text.resume : text.redispatch}
			</Button>
		</div>
	);
}

function AgentTurnFooter({ session, timestamp }: TurnFooterProps) {
	const parent = session.summary.owner === "plume.subagents" ? session.summary.parentId : undefined;
	const roster = useRoster(parent);
	const task = roster.tasks.find((entry) => entry.session === session.summary.id);
	if (!task || isActive(task)) return null;
	if (task.answer && task.answerTimestamp !== timestamp) return null;
	return (
		<>
			{task.answer && <Report task={task} />}
			{!task.answer && task.error && (
				<Text size="detail" tone="danger">
					{task.error}
				</Text>
			)}
			<WayBack key={`${task.id}:${task.attempt}`} task={task} />
		</>
	);
}

function AgentsPanel({ session }: PanelProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const parent = session?.summary.id;
	const roster = useRoster(parent);
	const selected = useChosen(parent);
	const tasks = ordered(roster.tasks);
	const task = tasks.find((entry) => entry.session === selected) ?? tasks[0];
	const child = ui.useSession(task?.resumable ? task.session : undefined);
	if (!parent)
		return (
			<PanelEmpty icon={Bot} title={text.panelTitle}>
				{text.noSession}
			</PanelEmpty>
		);
	if (roster.error)
		return (
			<div className="subagents-error">
				<Text tone="danger">{text.failedLoad}</Text>
				<Button onClick={() => retryRoster(parent)}>{text.retry}</Button>
			</div>
		);
	if (!task)
		return (
			<div className="subagents-panel">
				<ui.Conversation
					empty={
						<PanelEmpty icon={Bot} title={text.none}>
							{text.noneDetail}
						</PanelEmpty>
					}
					composer={{ send() {}, disabled: true, mode: "steer", placeholder: text.none }}
				/>
			</div>
		);
	const running = task.state === "running" && Boolean(task.runId);
	const noReply = !child?.messages.some((message) => message.role === "assistant");
	const send = async (message: Parameters<SubagentsApi["steer"]>[1]) => {
		try {
			await api.steer(task.session, message);
		} catch (error) {
			ui.notify(error instanceof Error ? error.message : text.gone, "error");
			throw error;
		}
	};
	return (
		<div className="subagents-panel">
			<Header task={task} tasks={tasks} child={child} />
			<div className="subagents-conversation">
				<ui.Conversation
					sessionId={task.resumable ? task.session : undefined}
					empty={
						task.pending ? (
							<TaskBrief message={{ role: "user", ...task.pending, timestamp: task.createdAt }} sessionId={task.session} />
						) : (
							<PanelEmpty icon={Bot} title={text.noOutput} />
						)
					}
					renderUserMessage={(message, fallback) => (message.origin === "parent" ? <TaskBrief message={message} sessionId={task.session} /> : fallback)}
					replyText={(body, message) => reportProse(task, body, message.timestamp)}
					composer={{
						mode: "steer",
						disabled: !running,
						placeholder: running ? text.steerPlaceholder : text.finishedSteer,
						send: (body) => send({ content: [{ type: "text", text: body }] }),
						sendMessage: send,
						model: "show",
						modelTip: (locale) => MESSAGES[locale].modelTip,
						footer: (!task.resumable || noReply) && <WayBack key={`${task.id}:${task.attempt}`} task={task} />,
					}}
				/>
			</div>
		</div>
	);
}

export default {
	name: "plume.subagents",
	apply(context) {
		ui = context;
		api = context.remote<SubagentsApi>();
		context.mentions(async ({ cwd }) => {
			const catalog = await api.catalog(cwd ?? null);
			return catalog.records
				.filter((record) => !catalog.disabled.includes(record.definition.name))
				.map(({ id, definition }) => ({
					id,
					title: definition.name,
					description: definition.description,
					kind: "subagent" as const,
					token: `@${definition.name}`,
					avatar: definition.avatar,
				}));
		});
		connect(api);
		connectSettings(context, api);
		connectStructured(context);
		let style = document.querySelector<HTMLStyleElement>('style[data-plugin-style="plume.subagents"]');
		if (!style) {
			style = document.createElement("style");
			style.dataset.pluginStyle = "plume.subagents";
			document.head.append(style);
		}
		style.textContent = css;
		context.toolCard("task", TaskCard);
		context.toolLine("stop_subagent", { verb: (locale) => MESSAGES[locale].stopVerb, icon: UserX });
		context.agentDelivery(AgentDelivery);
		// i18n-exempt：`yield` 那一行在两种界面语言下都写这句英文，和它交给模型的工具说明是同一种说法。
		context.toolLine("yield", { verb: "Submitting result", callOnly: true });
		context.composerAbove("agents", AgentsBar);
		context.turnFooter("report", AgentTurnFooter);
		context.panel(PANEL, AgentsPanel, {
			title: (locale) => MESSAGES[locale].panelTitle,
			description: (locale) => MESSAGES[locale].panelDescription,
			icon: Bot,
			/*
			 * U 而不是 A：Windows 上 Ctrl+Alt+A 是 QQ、TIM 的截图键，它们开着时系统把这个键交给它们，面板打不开。
			 * G 是编辑器的跳到行；U 哪儿都没人用。
			 */
			shortcut: "Alt+CommandOrControl+U",
			available: ({ session }) => session,
		});
		context.settingsSection("agents", AgentsSection, { title: (locale) => MESSAGES[locale].settings, icon: Bot, page: "agents" });
	},
} satisfies UiPlugin;
