/**
 * 子会话（侧边聊天）交给父会话的那几件事走到了哪：转录和输入框之间一件一行，是回执，不是记录（做了什么在父会话的转录里）。
 *
 * 面板只有两三百像素宽：不加底色、边框、展开；一行截断，整句和状态在悬停提示里。按钮悬停才出来，只给用得上的那几样。
 * 收了场的只留最近三件值得知道的：做完的、失败的、随父会话停下的；人自己收回的不留，点的时候就知道了。
 */

import type { HandedTask } from "@plume/contract";
import { IconButton, StatusSpinner, translate, useI18n } from "@plume/ui";
import { Ban, Check, Clock, OctagonPause, Play, RotateCcw, TriangleAlert, X } from "@plume/ui/icons";

/** 回执条上的几样操作，由宿主接到 agent 上。`withdraw` 交回收回的那句话，已经发出去了就是 undefined。 */
export interface TaskActions {
	runNow(parentId: string, taskId: string): void;
	withdraw(parentId: string, taskId: string): Promise<string | undefined>;
	retry(sideId: string, taskId: string): void;
	dismiss(sideId: string, taskId: string): void;
}

const ICON = { queued: Clock, done: Check, failed: TriangleAlert, cancelled: Ban } as const;

/** 收了场以后还留几件：刚做完的不至于一眨眼就没了。 */
const RECENT_KEPT = 3;

/** 悬停提示里放多少指令：交过去的常是几十行的计划，整段放进去，最后的状态行就被挤出窗口了。 */
const TIP_LINES = 6;
const TIP_CHARS = 160;

function worthKeeping(task: HandedTask): boolean {
	return task.status === "done" || task.status === "failed" || (task.status === "cancelled" && task.cancelledBy === "stop");
}

/** 失败的、随父会话停下的能重新排进去；规则在宿主（`HandedTasks.takeResumable`），这里只决定摆不摆按钮。 */
function resumable(task: HandedTask): boolean {
	return task.status === "failed" || (task.status === "cancelled" && task.cancelledBy === "stop");
}

function statusOf(task: HandedTask): string {
	switch (task.status) {
		case "queued":
			return translate("taskStrip.queued");
		case "running":
			return translate("taskStrip.mainBusy");
		case "done":
			return translate("taskStrip.done");
		case "failed":
			if (task.unfinished) return translate(task.unfinished === "stalled" ? "taskStrip.stalled" : "taskStrip.maxTurns");
			return task.error ? translate("taskStrip.failedWith", { error: task.error }) : translate("taskStrip.failed");
		case "cancelled":
			return translate(task.cancelledBy === "stop" ? "taskStrip.interrupted" : "taskStrip.withdrawn");
	}
}

function tipOf(task: HandedTask): string {
	const lines = task.text.split("\n").filter((line) => line.trim());
	const full = lines.join("\n");
	// 按字符截，不把一个 emoji 劈成两半。
	const kept = Array.from(lines.slice(0, TIP_LINES).join("\n")).slice(0, TIP_CHARS).join("");
	return `${kept === full ? kept : `${kept.trimEnd()}…`}\n\n${statusOf(task)}`;
}

export function TaskStrip({
	tasks,
	sideId,
	parentId,
	actions,
	onWithdrawn,
}: {
	tasks: readonly HandedTask[];
	sideId: string;
	parentId: string;
	actions: TaskActions;
	/** 收回的那句话放回这个子会话的输入框；没有输入框可放时不给，也就不摆「撤回」。 */
	onWithdrawn?: (text: string) => void;
}) {
	const active = tasks.filter((task) => task.status === "queued" || task.status === "running");
	const shown = [...tasks.filter(worthKeeping).slice(-RECENT_KEPT), ...active];
	if (shown.length === 0) return null;
	return (
		<div className="shrink-0" data-task-strip="">
			<div className="mx-auto flex w-full max-w-[var(--plume-content)] flex-col gap-px px-2 pb-1">
				{shown.map((task) => (
					<TaskRow key={task.id} task={task} sideId={sideId} parentId={parentId} actions={actions} {...(onWithdrawn ? { onWithdrawn } : {})} />
				))}
			</div>
		</div>
	);
}

function TaskRow({
	task,
	sideId,
	parentId,
	actions,
	onWithdrawn,
}: {
	task: HandedTask;
	sideId: string;
	parentId: string;
	actions: TaskActions;
	onWithdrawn?: (text: string) => void;
}) {
	const { t } = useI18n();
	const over = task.status !== "queued" && task.status !== "running";
	const Icon = task.status === "cancelled" && task.cancelledBy === "stop" ? OctagonPause : task.status === "running" ? undefined : ICON[task.status];
	return (
		<div
			className="group/task flex items-center gap-2 rounded-md px-1.5 py-1 text-detail transition-colors hover:bg-card-hover"
			data-task={task.status}
			data-plume-tip={tipOf(task)}
		>
			{Icon ? (
				<Icon
					size={12}
					strokeWidth={1.9}
					aria-hidden
					className={`shrink-0 ${task.status === "failed" ? "text-danger" : task.status === "done" ? "text-ok" : "text-ink-faint"}`}
				/>
			) : (
				<StatusSpinner size={12} className="text-ink-muted" />
			)}
			<span className="min-w-0 flex-1 truncate text-ink-muted">{task.text}</span>
			{/* 只在悬停或键盘落在这一行时出来：点过以后焦点还留着，用 focus-within 的话指针走了按钮也不收。 */}
			<div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-[var(--plume-t-quick)] group-hover/task:opacity-100 group-has-[:focus-visible]/task:opacity-100">
				{task.status === "queued" && (
					<>
						<IconButton
							size="xs"
							data-task-run-now=""
							label={t("taskStrip.runNow")}
							onClick={() => actions.runNow(parentId, task.id)}
							icon={<Play size={11} strokeWidth={2} aria-hidden />}
						/>
						{onWithdrawn && (
							<IconButton
								size="xs"
								data-task-withdraw=""
								label={t("taskStrip.withdraw")}
								ariaLabel={t("taskStrip.withdrawOne")}
								onClick={() =>
									void actions.withdraw(parentId, task.id).then((text) => {
										if (text !== undefined) onWithdrawn(text);
									})
								}
								icon={<RotateCcw size={11} strokeWidth={2} aria-hidden />}
							/>
						)}
					</>
				)}
				{resumable(task) && (
					<IconButton
						size="xs"
						data-task-retry=""
						label={t(task.status === "failed" ? "taskStrip.retryOne" : "taskStrip.resumeOne")}
						onClick={() => actions.retry(sideId, task.id)}
						icon={<Play size={11} strokeWidth={2} aria-hidden />}
					/>
				)}
				{over && (
					<IconButton
						size="xs"
						tone="danger"
						data-task-dismiss=""
						label={t("taskStrip.remove")}
						ariaLabel={t("taskStrip.removeOne")}
						onClick={() => actions.dismiss(sideId, task.id)}
						icon={<X size={11} strokeWidth={2} aria-hidden />}
					/>
				)}
			</div>
		</div>
	);
}
