/**
 * plume.spawn-session 的界面入口：`spawn_session` 在对话里画成的卡片和行，offer 弹在输入框上方的那张卡，以及环境卡片“产出”里已经真正开出的新会话；
 * 还有 `hand_off_to_session`、`dismiss_task`、`archive_session` 在转录里的说法。
 *
 * 建议卡站在调用的位置、自成一行（插件登记了卡片的工具不并进一段活）：一张等人点「开始」的卡片折进过程就没人点了。
 * 参数还在写时只是一行过程行（标题写到哪画到哪、扫光），写完整张卡片一次出现——写的时候就画卡片框，先冒出空标题和一颗按不动的
 * 「开始」，再一行行把框撑高，像坏了。
 *
 * 开始以后缩成一行过程行：行首是新会话的图标，在跑时摘要上扫光，点了过去。行尾不写「进行中」「已完成」——扫光已经说了在跑，
 * 只有没跑完要说，它改变人接下来做什么。它每结束一轮，这个对话里另有一行「来自关联会话」（本体画）。
 * offer 的卡由本体摆在输入框上方（`ui.requestCard`），人选完在调用的位置留一行「问过要不要另开会话 · 选了什么」；选了新会话、开出来以后同样缩成那一行。
 *
 * 环境卡片不列建议：建议只有真的开出了会话，才出现在「关联会话」里；直接开、offer、移交、计划交给新会话、侧边聊天开新会话、分叉开出的顶层会话也都列在这里，停止或结束后继续保留显示。待决定的建议仍留在它原本的工具卡片位置，不让环境卡片变成第二个决策入口。
 *
 * 开出来的会话「没跑完」「已完成」一直这么说，人看过以后也不清掉：插件读不到侧栏的已读状态。工作树开关从模型说的起步，没有「新会话默认开」的设置可跟。
 */

import type { ThinkingLevel } from "@plume/contract";
import type { EnvironmentSectionProps, Remote, RequestCardProps, SessionView, ToolCardProps, UiContext, UiPlugin } from "@plume/contract/ui";
import { proposal } from "@plume/styles";
import { ApprovalFrame, Button, EnvironmentRow, FlowRow, IconButton, Text, Toggle, useI18n, useNow, WorktreeToggle } from "@plume/ui";
import { Archive, BellOff, ChevronRight, Forward, MessageCircle, MessageSquarePlus, SquarePen, Undo2, X } from "@plume/ui/icons";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { SpawnSessionApi, SpawnSettings, StartedSuggestion } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { connect, dismiss, environmentStatus, refreshStarted, useDismissed, useStarted } from "./state.ts";
import spawnCss from "./spawn-session.css";
import {
	ARCHIVE_SESSION,
	DISMISS_TASK,
	HAND_OFF,
	inherited,
	isDismissed,
	isOffer,
	isStarted,
	isSuggestion,
	SESSION_OFFER,
	SPAWN_SESSION,
	type SessionSuggestion,
} from "./suggestion.ts";

const NAME = "plume.spawn-session";

let ui: UiContext;
let api: Remote<SpawnSessionApi>;

function mountStyles(): void {
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${NAME}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = NAME;
		document.head.append(style);
	}
	style.textContent = spawnCss;
}

function useText() {
	return MESSAGES[useI18n().resolvedLocale];
}

interface Suggestion {
	callId: string;
	details: SessionSuggestion;
}

/** 模型撤回了的建议（`dismiss_task`）。 */
function withdrawnIn(messages: SessionView["messages"]): Set<string> {
	return new Set(messages.flatMap((message) => (message.role === "toolResult" && isDismissed(message.details) ? [message.details.proposalId] : [])));
}

/** 从来处复制来的那几次调用，见 `inherited`。 */
function inheritedIn(messages: SessionView["messages"], createdAt: number): Set<string> {
	return new Set(messages.flatMap((message) => (message.role === "toolResult" && inherited(message, createdAt) ? [message.toolCallId] : [])));
}

/**
 * 写到一半的标题。写着的时候 `args` 还是空的，只有 `argumentsText` 在长，所以读原文：前面不是 `\` 的 `"title"` 只可能是键。
 * 末尾写了一半的转义先去掉，不然整句解析不了。
 */
function writtenTitle(args: Record<string, unknown>, argumentsText: string | undefined): string {
	if (typeof args.title === "string") return args.title;
	const found = /(?<!\\)"title"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argumentsText ?? "");
	if (!found) return "";
	const raw = found[1]!.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
	try {
		return JSON.parse(`"${raw}"`) as string;
	} catch {
		return raw;
	}
}

/**
 * 开出来的会话在做什么：在跑、没跑完（出错、跑到上限、卡住）、做完了，或者只知道开始过。跑完、没跑完是侧栏行首那个记号，
 * 人打开看过就清掉，这里跟着退成「已开始」：结果看过了，卡片不再一直喊着「没跑完」。人按停的、看着跑完的本来就不留记号。
 */
type Status = "running" | "failed" | "done" | "started";
function useStatus(sessionId: string): Status {
	const session = ui.useSession(sessionId);
	const activity = ui.useSessionActivity(sessionId);
	if (session?.summary.running) return "running";
	return activity === "done" || activity === "failed" ? activity : "started";
}

/** 提建议的对话能不能让新会话进工作树（在项目里、是 git 仓库）。不能、还没问到时不给开关。 */
function useOffersWorktree(parentId: string): boolean {
	const [offers, setOffers] = useState(false);
	useEffect(() => {
		let live = true;
		void api.offersWorktree(parentId).then(
			(answer) => live && setOffers(answer),
			() => {},
		);
		return () => {
			live = false;
		};
	}, [parentId]);
	return offers;
}

/**
 * 「开始」那一排，照主输入框那一排排：工作树开关在左；模型、思考档位和「开始」在右，「开始」在最后，像发送键——先定新会话怎么跑，最后再开始。
 * 放不下时右边那组整组换到下一行，「开始」跟着模型走，不和它们分开。
 * 工作树开关从模型说的（`use_worktree`）起步。模型和档位从默认的起步，没动过就不交，开出来的会话用默认的。
 */
function Start({ parentId, suggestion }: { parentId: string; suggestion: Suggestion }) {
	const text = useText();
	const offersWorktree = useOffersWorktree(parentId);
	const [worktree, setWorktree] = useState(suggestion.details.worktree === true);
	const [model, setModel] = useState("");
	const [thinking, setThinking] = useState<ThinkingLevel>();
	const [starting, setStarting] = useState(false);
	const start = async () => {
		if (starting) return;
		setStarting(true);
		try {
			await api.start(parentId, suggestion.callId, { worktree, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) });
			await refreshStarted(parentId);
		} catch (error) {
			ui.notify(text.startFailed(error instanceof Error ? error.message : String(error)), "error");
		} finally {
			setStarting(false);
		}
	};
	return (
		<div className={proposal.actions}>
			{offersWorktree && <WorktreeToggle size="sm" iconOnly on={worktree} onChange={setWorktree} />}
			<div className="plume-spawn-run">
				<ui.ModelControls model={model} {...(thinking ? { thinking } : {})} onModelChange={setModel} onThinkingChange={setThinking} disabled={starting} />
				<Button size="sm" variant="primary" loading={starting} label={text.startTip} onClick={() => void start()} data-spawn-action="start">
					{text.start}
				</Button>
			</div>
		</div>
	);
}

function Writing({ title, callId }: { title: string; callId: string }) {
	const text = useText();
	return (
		<div data-spawn-suggestion="writing" data-spawn-call={callId}>
			<FlowRow
				icon={<SquarePen size={13} strokeWidth={1.8} />}
				title={<span className="plume-spawn-plain">{text.suggesting}</span>}
				summary={title || undefined}
				running
			/>
		</div>
	);
}

/** 开始以后那一行：点了到那个会话。 */
function Started({ callId, title, startedId, verb }: { callId: string; title: string; startedId: string; verb?: string }) {
	const text = useText();
	const status = useStatus(startedId);
	const running = status === "running";
	const failed = status === "failed";
	return (
		<div data-spawn-suggestion="started" data-spawn-call={callId} className="plume-spawn-started">
			<FlowRow
				icon={<SquarePen size={13} strokeWidth={1.8} />}
				title={<span className="plume-spawn-plain">{verb ?? text.newSession}</span>}
				summary={title}
				running={running}
				trailing={
					<>
						{failed && <span className="plume-spawn-failed">{text.failed}</span>}
						{/* 点了是去那个会话，不是就地展开：箭头自己画，和汇报那一行一样。 */}
						<ChevronRight size={12} strokeWidth={2} aria-hidden />
					</>
				}
				onToggle={() => void ui.openSession(startedId)}
				label={failed ? `${title} · ${text.failed}` : title}
				data-spawn-action="open"
			/>
		</div>
	);
}

/** 一句记录：收起了、撤回了、过期了、选了在这里做。不再催人。 */
function Noted({ callId, state, verb, title, trailing }: { callId: string; state: string; verb: string; title: string; trailing: string }) {
	return (
		<div data-spawn-suggestion={state} data-spawn-call={callId}>
			<FlowRow icon={<SquarePen size={13} strokeWidth={1.8} />} title={<span className="plume-spawn-plain">{verb}</span>} summary={title} trailing={trailing} />
		</div>
	);
}

function Suggested({ parentId, suggestion }: { parentId: string; suggestion: Suggestion }) {
	const text = useText();
	const { callId, details } = suggestion;
	const started = useStarted(parentId).find((one) => one.callId === callId);
	const dismissed = useDismissed().includes(callId);
	if (started) return <Started callId={callId} title={details.title} startedId={started.sessionId} />;
	const withdrawn = <Noted callId={callId} state="withdrawn" verb={text.noted} title={details.title} trailing={text.withdrawnLine} />;
	const copied = <Noted callId={callId} state="inherited" verb={text.noted} title={details.title} trailing={text.inheritedLine} />;
	const live =
		details.expiresAt <= Date.now() ? (
			<Noted callId={callId} state="expired" verb={text.noted} title={details.title} trailing={text.expiredLine} />
		) : dismissed ? (
			// 收起只是一句记录：建议还在记录里，这里不再催人。
			<Noted callId={callId} state="dismissed" verb={text.noted} title={details.title} trailing={text.dismissed} />
		) : (
			<section data-spawn-suggestion="suggested" data-spawn-call={callId} aria-label={details.title} className={`${proposal.frame} plume-spawn-card`}>
				<p className={`${proposal.head} plume-spawn-head`}>
					<SquarePen size={14} strokeWidth={1.7} aria-hidden className={proposal.icon} />
					<Text size="label" weight="medium" data-spawn-title>
						{details.title}
					</Text>
				</p>
				{details.summary && (
					<Text as="p" size="caption" tone="muted" className={proposal.summary} data-spawn-summary>
						{details.summary}
					</Text>
				)}
				<Start parentId={parentId} suggestion={suggestion} />
				<span className="plume-spawn-dismiss">
					<IconButton size="xs" label={text.dismiss} icon={<X size={12} strokeWidth={1.9} />} onClick={() => dismiss(callId)} data-spawn-dismiss />
				</span>
			</section>
		);
	return (
		<UnlessClosed parentId={parentId} callId={callId} withdrawn={withdrawn} inherited={copied}>
			{live}
		</UnlessClosed>
	);
}

/**
 * 撤回、从来处复制来（`inherited`）要读这个对话的整段记录，而会话视图每出一个字都换一份：只让这一层跟着它重渲染，
 * 卡片作为 children 原样交回，元素没变 React 就不往下渲（卡片里还有模型选择）。
 */
function UnlessClosed({
	parentId,
	callId,
	withdrawn,
	inherited: copied,
	children,
}: {
	parentId: string;
	callId: string;
	withdrawn: ReactNode;
	inherited: ReactNode;
	children: ReactNode;
}) {
	const view = ui.useSession(parentId);
	const messages = view?.messages;
	const createdAt = view?.summary.createdAt;
	const closed = useMemo(
		() => ({
			withdrawn: withdrawnIn(messages ?? []),
			inherited: messages && createdAt !== undefined ? inheritedIn(messages, createdAt) : new Set<string>(),
		}),
		[messages, createdAt],
	);
	if (closed.inherited.has(callId)) return <>{copied}</>;
	return <>{closed.withdrawn.has(callId) ? withdrawn : children}</>;
}

/** offer 答完以后在调用的位置留的那一行；选了新会话、开出来了就是那个会话的一行。 */
function Offered({ parentId, callId, title, choice }: { parentId: string; callId: string; title: string; choice: "new" | "here" }) {
	const text = useText();
	const started = useStarted(parentId).find((one) => one.callId === callId);
	if (started) return <Started callId={callId} title={title} startedId={started.sessionId} />;
	return <Noted callId={callId} state={`offer-${choice}`} verb={text.offered} title={title} trailing={choice === "new" ? text.offeredNew : text.offeredHere} />;
}

/** 对话里 `spawn_session` 的那一处。没有可画的（参数被退回、这一轮在写完之前停了）就交回通用的工具行。 */
function SpawnCard({ sessionId, call, argumentsText, streaming, status, result, fallback }: ToolCardProps) {
	const details = status === "done" && !result?.isError ? result?.details : undefined;
	// 模型带 proposal_id 开的：那张建议卡、offer 那一行、环境卡片读的「开始了哪几条」得再问一遍，不然要等重挂才变。
	const startedProposal = isStarted(details) ? details.proposalId : undefined;
	useEffect(() => {
		if (startedProposal) void refreshStarted(sessionId);
	}, [sessionId, startedProposal]);
	if (isSuggestion(details)) return <Suggested parentId={sessionId} suggestion={{ callId: call.id, details }} />;
	if (isOffer(details)) return <Offered parentId={sessionId} callId={call.id} title={details.title} choice={details.choice} />;
	if (isStarted(details)) return <Started callId={call.id} title={details.title} startedId={details.sessionId} />;
	if (streaming || status === "running") return <Writing title={writtenTitle(call.args, argumentsText)} callId={call.id} />;
	return <>{fallback}</>;
}

/** 对话里 `hand_off_to_session` 的那一处：移交出去以后是那个会话的一行。 */
function HandOffCard({ call, status, result, fallback }: ToolCardProps) {
	const text = useText();
	const details = status === "done" && !result?.isError ? result?.details : undefined;
	if (isStarted(details)) return <Started callId={call.id} title={details.title} startedId={details.sessionId} verb={text.handedOff} />;
	return <>{fallback}</>;
}

/**
 * offer 的卡：压在输入框上方，外框和审批卡同一个（`ApprovalFrame`），按钮也照审批卡排：默认高度、带图标，主按钮「开新会话」在最后
 * （人提了一件新事，模型才会问）；「以后不再问」一直生效，推到最左和另两颗隔开，和审批卡把「拒绝」推到最左一个道理。
 * 模型和思考档位紧挨在「开新会话」左边，和建议卡的「开始」一个排法：先定新会话怎么跑，最后点开新会话。从默认的起步，没动过就不交。
 */
function OfferCard({ request, queued, answer, fallback }: RequestCardProps) {
	const text = useText();
	const [busy, setBusy] = useState(false);
	const [model, setModel] = useState("");
	const [thinking, setThinking] = useState<ThinkingLevel>();
	const payload = request.payload as { title?: unknown } | undefined;
	if (typeof payload?.title !== "string") return <>{fallback}</>;
	const choose = async (choice: "new" | "here" | "never") => {
		if (busy) return;
		setBusy(true);
		try {
			await answer(choice === "new" ? { choice, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) } : { choice });
		} catch (error) {
			ui.notify(String(error), "error");
		} finally {
			setBusy(false);
		}
	};
	return (
		<ApprovalFrame
			requestId={request.toolCallId}
			icon={<SquarePen size={15} strokeWidth={1.8} className="plume-spawn-offer-icon" />}
			title={text.offerTitle}
			expiresAt={request.expiresAt}
			queued={queued}
		>
			<div data-spawn-offer={request.toolCallId}>
				<Text as="p" size="label" className="plume-spawn-offer-text" data-spawn-title>
					{payload.title}
				</Text>
				<div className="plume-spawn-offer-actions">
					<Button
						variant="subtle"
						disabled={busy}
						label={text.offerNeverTip}
						icon={<BellOff size={14} />}
						className="plume-spawn-offer-never"
						onClick={() => void choose("never")}
						data-spawn-offer-choice="never"
					>
						{text.offerNever}
					</Button>
					<Button variant="subtle" disabled={busy} icon={<MessageCircle size={14} />} onClick={() => void choose("here")} data-spawn-offer-choice="here">
						{text.offerHere}
					</Button>
					<div className="plume-spawn-offer-run">
						<ui.ModelControls model={model} {...(thinking ? { thinking } : {})} onModelChange={setModel} onThinkingChange={setThinking} disabled={busy} />
						<Button
							variant="primary"
							disabled={busy}
							label={text.offerNewTip}
							icon={<SquarePen size={14} />}
							onClick={() => void choose("new")}
							data-spawn-offer-choice="new"
						>
							{text.offerNew}
						</Button>
					</div>
				</div>
			</div>
		</ApprovalFrame>
	);
}

/** 运行中的新会话用经过时间，和环境卡片里别的后台运行同一套机器事实。 */
function environmentElapsed(at: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * 环境卡片「关联会话」节：列从当前对话派生出来的全部顶层关联会话（建议卡开出的、直接开、offer、移交、计划交给新会话、
 * 侧边聊天开新会话、分叉）。待决定、收起、撤回和过期的建议不出现；已经开出的会话无论运行中、已停止、已完成、没跑完还是已归档都一直保留显示。
 */
function StartedSessionsSection({ session }: EnvironmentSectionProps) {
	const parentId = session.summary.id;
	const started = useStarted(parentId);
	if (started.length === 0) return null;
	return (
		<div data-spawn-section="">
			{started.map((entry) => (
				<StartedEntry key={entry.sessionId} entry={entry} />
			))}
		</div>
	);
}

function StartedEntry({ entry }: { entry: StartedSuggestion }) {
	const text = useText();
	const activity = ui.useSessionActivity(entry.sessionId);
	const status = environmentStatus(entry, activity);
	const running = status === "running";
	const now = useNow(running, 1000);
	const fact =
		status === "running" ? `${text.running} · ${environmentElapsed(entry.createdAt, now)}` : status === "archived" ? text.archivedStatus : text[status];
	return (
		<EnvironmentRow
			icon={<MessageSquarePlus size={14} strokeWidth={1.8} />}
			title={entry.title || text.newSession}
			fact={fact}
			running={running}
			onClick={() => void ui.openSession(entry.sessionId)}
			data-spawn-environment={entry.callId ?? entry.sessionId}
			data-spawn-session={entry.sessionId}
			data-state="started"
			data-spawn-status={status}
		/>
	);
}

/** 设置 › 常规里的开关：offer 卡上点过「以后不再问」后，在这里打开回来。 */
function OffersSetting() {
	const text = useText();
	const [settings, set] = ui.useSettings<SpawnSettings>();
	return (
		<Toggle
			checked={settings?.offers ?? true}
			disabled={settings === undefined}
			ariaLabel={text.offersTitle}
			onChange={(next) => void set({ offers: next }).catch((error: unknown) => ui.notify(String(error), "error"))}
		/>
	);
}

export default {
	name: NAME,
	apply(context) {
		ui = context;
		api = context.remote<SpawnSessionApi>();
		connect(api, context);
		mountStyles();
		context.toolCard(SPAWN_SESSION, SpawnCard);
		context.toolCard(HAND_OFF, HandOffCard);
		context.requestCard(SESSION_OFFER, OfferCard);
		context.toolLine(SPAWN_SESSION, {
			verb: (locale) => MESSAGES[locale].suggesting,
			subject: (args) => (typeof args.title === "string" ? args.title : undefined),
			icon: SquarePen,
		});
		context.toolLine(HAND_OFF, {
			verb: (locale) => MESSAGES[locale].handedOff,
			subject: (args) => (typeof args.title === "string" ? args.title : undefined),
			icon: Forward,
		});
		context.toolLine(DISMISS_TASK, { verb: (locale) => MESSAGES[locale].dismissing, icon: Undo2 });
		// 和侧栏上归档用的是同一枚，这一行和它作用的地方对得上。
		context.toolLine(ARCHIVE_SESSION, { verb: (locale) => MESSAGES[locale].archived, icon: Archive });
		context.settingsSection("offers", OffersSetting, {
			title: (locale) => MESSAGES[locale].offersTitle,
			detail: (locale) => MESSAGES[locale].offersDetail,
			page: "general",
		});
		context.environmentSection("started-sessions", StartedSessionsSection, {
			label: (locale) => MESSAGES[locale].relatedSessions,
			place: "output",
			order: 40,
			count: false,
		});
	},
} satisfies UiPlugin;
