/**
 * plume.spawn-session 的界面入口：`spawn_session` 在对话里画成的卡片和行，offer 弹在输入框上方的那张卡，环境卡片里「建议的新会话」那一节，
 * 和收着的环境开关上「N 条建议的新会话等你决定」的圆点；还有 `hand_off_to_session`、`dismiss_task`、`archive_session` 在转录里的说法。
 *
 * 建议卡站在调用的位置、自成一行（插件登记了卡片的工具不并进一段活）：一张等人点「开始」的卡片折进过程就没人点了。
 * 参数还在写时只是一行过程行（标题写到哪画到哪、扫光），写完整张卡片一次出现——写的时候就画卡片框，先冒出空标题和一颗按不动的
 * 「开始」，再一行行把框撑高，像坏了。
 *
 * 开始以后缩成一行过程行：行首是新会话的图标，在跑时摘要上扫光，点了过去。行尾不写「进行中」「已完成」——扫光已经说了在跑，
 * 只有没跑完要说，它改变人接下来做什么。它每结束一轮，这个对话里另有一行「来自关联会话」（本体画）。
 * offer 的卡由本体摆在输入框上方（`ui.requestCard`），人选完在调用的位置留一行「问过要不要另开会话 · 选了什么」；选了新会话、开出来以后同样缩成那一行。
 *
 * 环境卡片那一节只列出来：提完建议模型接着干活，卡片被顶到几屏之上时，还没处理的由开关上的圆点提醒，点一条滚回对话里那张卡片。
 * 选模型、开始只在卡片上——300px 那一列挤不下一排控件，两处都能开始也要多想一下该在哪点。两处读同一份状态（`state.ts`）。
 *
 * 开出来的会话「没跑完」「已完成」一直这么说，人看过以后也不清掉：插件读不到侧栏的已读状态。工作树开关从模型说的起步，没有「新会话默认开」的设置可跟。
 */

import type { ThinkingLevel } from "@plume/contract";
import type { EnvironmentSectionProps, Remote, RequestCardProps, SessionView, ToolCardProps, UiContext, UiPlugin } from "@plume/contract/ui";
import { ApprovalFrame, Button, FlowRow, IconButton, Text, Toggle, useI18n, WorktreeToggle } from "@plume/ui";
import { Archive, ChevronRight, Forward, SquarePen, Undo2, X } from "@plume/ui/icons";
import { useEffect, useMemo, useState } from "react";
import type { SpawnSessionApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { connect, dismiss, refreshStarted, useDismissed, useStarted } from "./state.ts";
import spawnCss from "./spawn-session.css";
import {
	ARCHIVE_SESSION,
	DISMISS_TASK,
	HAND_OFF,
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

/** 这个对话里提过的建议，按先后。参数被退回、还没返回的不算：工具那一行自己说了哪里不对。 */
function suggestionsIn(messages: SessionView["messages"]): Suggestion[] {
	return messages.flatMap((message) =>
		message.role === "toolResult" && !message.isError && isSuggestion(message.details) ? [{ callId: message.toolCallId, details: message.details }] : [],
	);
}

/** 模型撤回了的建议（`dismiss_task`）。 */
function withdrawnIn(messages: SessionView["messages"]): Set<string> {
	return new Set(messages.flatMap((message) => (message.role === "toolResult" && isDismissed(message.details) ? [message.details.proposalId] : [])));
}

/** 还能点「开始」：没过期、没被模型撤回。 */
function open(suggestion: Suggestion, withdrawn: Set<string>, now: number): boolean {
	return suggestion.details.expiresAt > now && !withdrawn.has(suggestion.callId);
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
		<div className="plume-spawn-actions">
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
	const messages = ui.useSession(parentId)?.messages;
	const withdrawn = useMemo(() => withdrawnIn(messages ?? []), [messages]);
	if (started) return <Started callId={callId} title={details.title} startedId={started.sessionId} />;
	if (withdrawn.has(callId)) return <Noted callId={callId} state="withdrawn" verb={text.noted} title={details.title} trailing={text.withdrawnLine} />;
	if (details.expiresAt <= Date.now()) return <Noted callId={callId} state="expired" verb={text.noted} title={details.title} trailing={text.expiredLine} />;
	// 收起只是一句记录：建议还在记录里，这里不再催人。
	if (dismissed) return <Noted callId={callId} state="dismissed" verb={text.noted} title={details.title} trailing={text.dismissed} />;
	return (
		<section data-spawn-suggestion="suggested" data-spawn-call={callId} aria-label={details.title} className="plume-spawn-card">
			<SquarePen size={15} strokeWidth={1.7} aria-hidden className="plume-spawn-card-icon" />
			<div className="plume-spawn-card-body">
				<Text as="p" size="label" weight="medium" className="plume-spawn-title" data-spawn-title>
					{details.title}
				</Text>
				{details.summary && (
					<Text as="p" size="caption" tone="muted" className="plume-spawn-summary" data-spawn-summary>
						{details.summary}
					</Text>
				)}
				<Start parentId={parentId} suggestion={suggestion} />
			</div>
			<span className="plume-spawn-dismiss">
				<IconButton size="xs" label={text.dismiss} icon={<X size={12} strokeWidth={1.9} />} onClick={() => dismiss(callId)} data-spawn-dismiss />
			</span>
		</section>
	);
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
 * offer 的卡：压在输入框上方，外框和审批卡同一个（`ApprovalFrame`）。标题下面是模型起的那件事，下面三颗：
 * 「新会话」是主按钮（人提了一件新事，模型才会问），「就在这里做」，「以后不再问」最轻。
 */
function OfferCard({ request, queued, answer, fallback }: RequestCardProps) {
	const text = useText();
	const [busy, setBusy] = useState(false);
	const payload = request.payload as { title?: unknown } | undefined;
	if (typeof payload?.title !== "string") return <>{fallback}</>;
	const choose = async (choice: "new" | "here" | "never") => {
		if (busy) return;
		setBusy(true);
		try {
			await answer(choice);
		} catch (error) {
			ui.notify(String(error), "error");
		} finally {
			setBusy(false);
		}
	};
	return (
		<ApprovalFrame
			requestId={request.toolCallId}
			icon={<SquarePen size={15} strokeWidth={1.8} className="plume-spawn-card-icon" />}
			title={text.offerTitle}
			expiresAt={request.expiresAt}
			queued={queued}
		>
			<div className="plume-spawn-offer" data-spawn-offer={request.toolCallId}>
				<Text as="p" size="label" data-spawn-title>
					{payload.title}
				</Text>
				<div className="plume-spawn-offer-actions">
					<Button size="sm" variant="ghost" disabled={busy} label={text.offerNeverTip} onClick={() => void choose("never")} data-spawn-offer-choice="never">
						{text.offerNever}
					</Button>
					<Button size="sm" variant="subtle" disabled={busy} onClick={() => void choose("here")} data-spawn-offer-choice="here">
						{text.offerHere}
					</Button>
					<Button size="sm" variant="primary" disabled={busy} label={text.offerNewTip} onClick={() => void choose("new")} data-spawn-offer-choice="new">
						{text.offerNew}
					</Button>
				</div>
			</div>
		</ApprovalFrame>
	);
}

/** 这个会话里的全部建议，按消息记住：输出时视图每一拍都换，消息没变，不用每拍把整段转录再翻一遍。 */
function useSuggestions(session: SessionView): { all: Suggestion[]; withdrawn: Set<string> } {
	return useMemo(() => ({ all: suggestionsIn(session.messages), withdrawn: withdrawnIn(session.messages) }), [session.messages]);
}

/** 还在等人决定的几条：没开始、没收起、没撤回、没过期。 */
function usePending(session: SessionView): Suggestion[] {
	const started = useStarted(session.summary.id);
	const dismissed = useDismissed();
	const { all, withdrawn } = useSuggestions(session);
	const now = Date.now();
	return all.filter((one) => open(one, withdrawn, now) && !dismissed.includes(one.callId) && !started.some((done) => done.callId === one.callId));
}

/** 环境开关上的那句话：有等人决定的建议才说。 */
function useAttention(session: SessionView): string | undefined {
	const text = useText();
	const pending = usePending(session).length;
	return pending > 0 ? text.pending(pending) : undefined;
}

/**
 * 环境卡片里「建议的新会话」：等人决定的排在前面，只有标题和理由，点了滚回对话里那张卡片去选模型、开始；
 * 开始以后缩成一行，说那个会话在做什么，点了过去。收起、撤回、过期的不再列出。
 */
function SuggestionsSection({ session }: EnvironmentSectionProps) {
	const text = useText();
	const parentId = session.summary.id;
	const started = useStarted(parentId);
	const pending = usePending(session);
	const { all } = useSuggestions(session);
	const begun = all.flatMap((one) => {
		const found = started.find((done) => done.callId === one.callId);
		return found ? [{ ...one, startedId: found.sessionId }] : [];
	});
	if (pending.length === 0 && begun.length === 0) return null;
	return (
		<div data-spawn-section="">
			<div className="plume-spawn-section-label">
				<Text size="caption" tone="faint">
					{text.suggested}
				</Text>
			</div>
			{pending.map((one) => (
				<PendingEntry key={one.callId} parentId={parentId} suggestion={one} />
			))}
			{begun.map((one) => (
				<StartedEntry key={one.callId} callId={one.callId} title={one.details.title} startedId={one.startedId} />
			))}
		</div>
	);
}

function PendingEntry({ parentId, suggestion }: { parentId: string; suggestion: Suggestion }) {
	const reveal = () => void ui.revealToolCall(parentId, suggestion.callId).catch((error: unknown) => ui.notify(String(error), "error"));
	return (
		<button type="button" data-spawn-environment={suggestion.callId} data-state="suggested" className="plume-spawn-row plume-spawn-pending" onClick={reveal}>
			<SquarePen size={14} strokeWidth={1.8} aria-hidden className="plume-spawn-card-icon" />
			<span className="plume-spawn-card-body">
				<Text size="label" className="plume-spawn-line" data-spawn-title>
					{suggestion.details.title}
				</Text>
				{suggestion.details.summary && (
					<Text size="caption" tone="muted" className="plume-spawn-summary">
						{suggestion.details.summary}
					</Text>
				)}
			</span>
			<ChevronRight size={12} strokeWidth={2} aria-hidden className="plume-spawn-card-icon" />
		</button>
	);
}

function StartedEntry({ callId, title, startedId }: { callId: string; title: string; startedId: string }) {
	const text = useText();
	const status = useStatus(startedId);
	return (
		<button type="button" data-spawn-environment={callId} data-state="started" className="plume-spawn-row" onClick={() => void ui.openSession(startedId)}>
			{/* 一眼读到状态，不用看右边的字：在跑是强调色，跑完是绿点，没跑完是红点。 */}
			<span aria-hidden className="plume-spawn-dot" data-status={status} />
			<Text size="label" className="plume-spawn-grow">
				{title}
			</Text>
			<Text size="caption" tone={status === "failed" ? "danger" : "faint"} data-spawn-status>
				{text[status]}
			</Text>
		</button>
	);
}

/** 设置 › 常规里的开关：offer 卡上点过「以后不再问」后，在这里打开回来。 */
function OffersSetting() {
	const text = useText();
	const [on, setOn] = useState<boolean | undefined>(undefined);
	useEffect(() => {
		let alive = true;
		void api.offers().then(
			(value) => alive && setOn(value),
			(error: unknown) => ui.notify(String(error), "error"),
		);
		return () => {
			alive = false;
		};
	}, []);
	return (
		<Toggle
			checked={on ?? true}
			disabled={on === undefined}
			ariaLabel={text.offersTitle}
			onChange={(next) => {
				setOn(next);
				void api.setOffers(next).catch((error: unknown) => {
					setOn(!next);
					ui.notify(String(error), "error");
				});
			}}
		/>
	);
}

export default {
	name: NAME,
	apply(context) {
		ui = context;
		api = context.remote<SpawnSessionApi>();
		connect(api);
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
		// 40：环境卡片里排在计划之后。
		context.environmentSection("suggestions", SuggestionsSection, { label: (locale) => MESSAGES[locale].suggested, order: 40, attention: useAttention });
	},
} satisfies UiPlugin;
