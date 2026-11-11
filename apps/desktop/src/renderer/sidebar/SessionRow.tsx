/**
 * 侧栏里的一段会话：状态点、标题、最后活动距今多久。
 *
 * 悬停的底色挂在外层的行上，不挂在按钮上：标题读不全时 `ScrollText` 靠行上的悬停滚动，两者要认同一个东西。
 * 置顶和归档按钮是盖在按钮右端的兄弟节点，不放进按钮里：指针停在它上面时还在行里，底色和字色不会掉。
 */

import type { ProjectEntry, SessionStats, SessionSummary } from "@plume/contract";
import { ActionSpinner, BreatheLoader, HoverRow, HoverRowReveal, hoverSlot, IconButton, ScrollText, TimeAgo, useI18n, usePopover } from "@plume/ui";
import { Archive, ChevronRight, Pin, PinOff } from "@plume/ui/icons";
import { SessionCard, useSessionCard } from "./SessionCard.tsx";
import { DropLineIndicator } from "./DropIndicator.tsx";
import { useSidebarReorderContext, useReorderState } from "./reorder-context.ts";
import { memo } from "react";
import { SessionMarks } from "../plugins.tsx";
import { notify } from "../toast/index.ts";
import { type SessionActivity, useSessionActivity, waitingWords, waitOf } from "./activity.ts";
import { SessionMenu, type SessionMenuActions } from "./SessionMenu.tsx";

export const SessionRow = memo(function SessionRow({
	session,
	active,
	compact,
	onOpen,
	projects,
	actions,
	childRunning = false,
	nested = false,
	followUps,
	folded,
	onFold,
	loadStats,
}: {
	session: SessionSummary;
	nested?: boolean;
	followUps?: readonly SessionSummary[];
	folded?: boolean;
	onFold?: () => void;
	loadStats: (id: string) => Promise<SessionStats>;
	active: boolean;
	/** 它的子会话（侧边聊天、子 Agent）有在跑的：发起它们的那一轮可能早结束了，这一行也还在动。 */
	childRunning?: boolean;
	compact: boolean;
	onOpen: (sessionId: string) => void;
	projects: readonly ProjectEntry[];
	actions: SessionMenuActions;
}) {
	const { t } = useI18n();
	const title = session.title || t("sessionOps.newSession");
	const menu = usePopover();
	const hover = useSessionCard();
	const context = useSidebarReorderContext();
	const reorder = nested ? null : context;
	const dragging = useReorderState((state) => state.dragging?.kind === "session" && state.dragging.id === session.id);
	const placement = useReorderState((state) =>
		state.dropTarget?.kind === "session" && state.dropTarget.id === session.id ? state.dropTarget.placement : null,
	);
	return (
		<HoverRow
			data-plume-row={session.id}
			data-plume-row-nested={nested || undefined}
			{...hover.bind}
			onPointerMove={(event) => reorder?.registerTarget("session", session.id, event.currentTarget.getBoundingClientRect(), event.clientY, session.project)}
			onPointerLeave={() => reorder?.clearTarget(session.id)}
			controls={hoverSlot(2)}
			className={`rounded-field active:bg-elevated ${dragging ? "opacity-40" : ""} ${active ? "bg-card-hover" : "hover:bg-card-hover"}`}
			onContextMenu={(event) => {
				// 浮层经 portal 画在行外，里面输入框的右键仍交给输入框。
				if (!event.currentTarget.contains(event.target as Node)) return;
				event.preventDefault();
				hover.dismiss();
				menu.openAtPoint(event);
			}}
		>
			{placement && !nested && <DropLineIndicator placement={placement} />}
			{hover.anchor && !dragging && (
				<SessionCard
					session={session}
					load={loadStats}
					anchor={hover.anchor}
					leaving={hover.leaving}
					project={session.pinned ? projects.find((entry) => entry.id === session.project)?.name : undefined}
				/>
			)}
			{menu.open && <SessionMenu anchor={menu.anchor} session={session} onClose={menu.close} projects={projects} actions={actions} />}
			<button
				type="button"
				onClick={() => onOpen(session.id)}
				onPointerDown={(event) => {
					hover.dismiss();
					reorder?.startDrag({ kind: "session", id: session.id, project: session.project, title }, event);
				}}
				onKeyDown={(event) => {
					if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
					event.preventDefault();
					menu.openAt(event.currentTarget);
				}}
				// 打开的是哪一段，除了底色也说出来：读屏看不见底色。
				aria-current={active ? "page" : undefined}
				className={`flex w-full min-w-0 items-center gap-2 rounded-field pr-1.5 pl-2.5 text-left text-label text-ink ${compact ? "h-[34px]" : "h-[32px]"}`}
			>
				{nested && (
					<span aria-hidden data-plume-row-branch className="relative ml-[5px] w-3.5 shrink-0 self-stretch">
						<span className="absolute top-[5px] right-[-1px] bottom-1/2 left-[6px] rounded-bl-item border-b border-l border-ink-faint" />
					</span>
				)}
				<span className={followUps ? "flex shrink-0 transition-opacity group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0" : "flex shrink-0"}>
					<SessionStatus session={session} running={session.running || childRunning} />
				</span>
				<ScrollText text={title} className="plume-fade-tail min-w-0 flex-1" />
				{/* 不管列表按什么排，这里都是最后活动的时间：扫一眼要回答的是「这条多久没动了」。悬停按钮出来时它让位，两者不同时出现。 */}
				{followUps && folded && (
					<span
						data-plume-row-folded={followUps.length}
						// 有在跑的就只剩转圈、不带底，和项目折起来时标题上的转圈一个样子；灰底胶囊只给条数用。
						className={`flex h-4 shrink-0 items-center justify-center text-caption text-ink-muted tabular-nums transition-opacity group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0 ${
							followUps.some((child) => child.running) ? "w-3.5" : "min-w-[18px] rounded-full bg-ink/10 px-1.5"
						}`}
					>
						{followUps.some((child) => child.running) ? <ActionSpinner size={14} className="text-accent" /> : followUps.length}
					</span>
				)}
				<TimeAgo
					iso={new Date(session.updatedAt).toISOString()}
					className="shrink-0 text-caption text-ink-muted transition-opacity group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0"
				/>
			</button>
			{followUps && onFold && (
				<span className="absolute top-1/2 left-[7px] flex -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 has-[:focus-visible]:opacity-100">
					<IconButton
						size="xs"
						label={t(folded ? "sessionRow.expandFollowUps" : "sessionRow.collapseFollowUps")}
						ariaLabel={t(folded ? "sessionRow.expandFollowUpsOne" : "sessionRow.collapseFollowUpsOne", { title })}
						expanded={!folded}
						onClick={onFold}
						data-plume-row-fold=""
						icon={<ChevronRight size={12} strokeWidth={2.2} className={`transition-transform ${folded ? "" : "rotate-90"}`} />}
					/>
				</span>
			)}
			<HoverRowReveal className="rounded-r-field">
				<IconButton
					size="sm"
					label={t(session.pinned ? "sessionRow.unpin" : "sessionRow.pin")}
					onClick={() =>
						void actions.pin(session.id, !session.pinned).catch((cause: unknown) => notify(cause instanceof Error ? cause.message : String(cause), "error"))
					}
					className="pointer-events-auto"
					icon={session.pinned ? <PinOff size={12.5} strokeWidth={1.8} /> : <Pin size={12.5} strokeWidth={1.8} />}
				/>
				<IconButton
					size="sm"
					label={t("sessionRow.archive")}
					ariaLabel={t("sessionRow.fileOne", { what: t("sessionRow.archive"), title })}
					onClick={() => actions.archive(session.id)}
					className="pointer-events-auto"
					icon={<Archive size={12.5} strokeWidth={1.8} />}
				/>
			</HoverRowReveal>
		</HoverRow>
	);
});

const ACTIVITY_LABEL = { waiting: "sessionStatus.waiting", done: "sessionStatus.done", failed: "sessionStatus.failed" } as const;

/**
 * 行首 14px 的状态槽。在跑的是一个比槽小一圈的呼吸点，不用转圈：一列里可能好几行同时在跑，
 * 并排几个各自在转，读标题时旁边总有东西在动。等人批准、人没看着时跑完或出错，各是一个同样大小的实心点：
 * 换状态只换颜色，行不跳。空闲是一个空心圈，描边用 `line-float`，深色侧栏上也看得见。
 * 等批准排最前：那是一个会一直等下去、却没人知道它在等的会话，子会话在等也标在这一行上。手动标的未读只占空闲那一档，
 * 跑完、出错本身就是未读。只有空闲那一档让给插件（`ui.sessionMark`，如工作树的 ⑂），插件不说话时还是空心圈。
 */
export function SessionStatus({ session, running }: { session: SessionSummary; running: boolean }) {
	const { t } = useI18n();
	const activity: SessionActivity | undefined = useSessionActivity(session.id);
	const unread = session.unread ?? false;
	const shown = activity === "waiting" ? activity : running ? "running" : activity;
	const label =
		shown === "running"
			? t("sessionStatus.running")
			: shown === "waiting"
				? waitingWords(waitOf(session.id), t)
				: shown
					? t(ACTIVITY_LABEL[shown])
					: unread
						? t("sessionStatus.unread")
						: undefined;
	return (
		<span
			className="relative flex size-3.5 shrink-0 items-center justify-center overflow-visible"
			data-plume-tip={label}
			data-plume-tip-side="right"
			aria-label={label}
			role={label ? "img" : undefined}
		>
			{shown === "running" ? (
				<span data-plume-status-mark="running">
					<BreatheLoader size={12} />
				</span>
			) : shown || unread ? (
				<span
					data-plume-status-mark={shown ?? "unread"}
					className={`box-border block size-[7px] rounded-full transition-colors ${
						shown === "waiting" ? "bg-warning" : shown === "done" ? "bg-ok" : shown === "failed" ? "bg-danger" : "bg-accent"
					}`}
				/>
			) : (
				<SessionMarks
					session={session}
					fallback={<span data-plume-status-mark="idle" className="box-border block size-[7px] rounded-full border border-line-float transition-colors" />}
				/>
			)}
		</span>
	);
}
