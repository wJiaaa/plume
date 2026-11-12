/**
 * 侧边聊天交给主会话的那几件事走到了哪（`ConversationProps.tasks`）：转录和输入框之间一件一行，是回执，不是记录
 * （做了什么在主会话的转录里）。状态是宿主给的（`ChildTask`），这里只管怎么画、留几件、摆哪些按钮。
 *
 * 面板只有两三百像素宽：不加底色、边框、展开；一行截断，整句和状态在悬停提示里。按钮悬停才出来，只给用得上的那几样。
 * 收了场的只留最近三件值得知道的：做完的、失败的、随主会话停下的；人自己收回的不留，点的时候就知道了。
 */

import type { ChildTask, Locale } from "@plume/contract";
import type { ChildTasksProps } from "@plume/contract/ui";
import { IconButton, StatusSpinner, Text, useI18n } from "@plume/ui";
import { Ban, Check, Clock, OctagonPause, Play, RotateCcw, TriangleAlert, X } from "@plume/ui/icons";
import { MESSAGES } from "./messages.ts";

const ICON = { queued: Clock, done: Check, failed: TriangleAlert, cancelled: Ban } as const;

/** 收了场以后还留几件：刚做完的不至于一眨眼就没了。 */
const RECENT_KEPT = 3;

/** 悬停提示里放多少指令：交过去的常是几十行的计划，整段放进去，最后的状态行就被挤出窗口了。 */
const TIP_LINES = 6;
const TIP_CHARS = 160;

function worthKeeping(task: ChildTask): boolean {
	return task.status === "done" || task.status === "failed" || (task.status === "cancelled" && task.cancelledBy === "stop");
}

/** 失败的、随主会话停下的能重新排进去；规则在宿主（`AgentService.retryTask`），这里只决定摆不摆按钮。 */
function resumable(task: ChildTask): boolean {
	return task.status === "failed" || (task.status === "cancelled" && task.cancelledBy === "stop");
}

function statusOf(task: ChildTask, locale: Locale): string {
	const text = MESSAGES[locale];
	switch (task.status) {
		case "queued":
			return text.taskQueued;
		case "running":
			return text.taskMainBusy;
		case "done":
			return text.taskDone;
		case "failed":
			if (task.unfinished) return task.unfinished === "stalled" ? text.taskStalled : text.taskMaxTurns;
			return task.error ? text.taskFailedWith(task.error) : text.taskFailed;
		case "cancelled":
			return task.cancelledBy === "stop" ? text.taskInterrupted : text.taskWithdrawn;
	}
}

function tipOf(task: ChildTask, locale: Locale): string {
	const lines = task.text.split("\n").filter((line) => line.trim());
	const full = lines.join("\n");
	// 按字符截，不把一个 emoji 劈成两半。
	const kept = Array.from(lines.slice(0, TIP_LINES).join("\n")).slice(0, TIP_CHARS).join("");
	return `${kept === full ? kept : `${kept.trimEnd()}…`}\n\n${statusOf(task, locale)}`;
}

export function TaskStrip(props: ChildTasksProps) {
	const active = props.tasks.filter((task) => task.status === "queued" || task.status === "running");
	const shown = [...props.tasks.filter(worthKeeping).slice(-RECENT_KEPT), ...active];
	if (shown.length === 0) return null;
	return (
		<div className="plume-side-tasks" data-task-strip="">
			<div className="plume-side-tasks-list">
				{shown.map((task) => (
					<TaskRow key={task.id} task={task} {...props} />
				))}
			</div>
		</div>
	);
}

function TaskRow({ task, runNow, withdraw, retry, dismiss }: ChildTasksProps & { task: ChildTask }) {
	const locale = useI18n().resolvedLocale;
	const text = MESSAGES[locale];
	const over = task.status !== "queued" && task.status !== "running";
	const Icon = task.status === "cancelled" && task.cancelledBy === "stop" ? OctagonPause : task.status === "running" ? undefined : ICON[task.status];
	return (
		<div className="plume-side-task" data-task={task.status} data-plume-tip={tipOf(task, locale)}>
			{Icon ? (
				<Icon size={12} strokeWidth={1.9} aria-hidden className="plume-side-task-icon" data-tone={task.status} />
			) : (
				<StatusSpinner size={12} className="plume-side-task-spinner" />
			)}
			<Text size="detail" tone="muted" className="plume-side-task-text">
				{task.text}
			</Text>
			{/* 只在悬停或键盘落在这一行时出来：点过以后焦点还留着，用 focus-within 的话指针走了按钮也不收。 */}
			<div className="plume-side-task-actions">
				{task.status === "queued" && (
					<>
						<IconButton
							size="xs"
							data-task-run-now=""
							label={text.taskRunNow}
							onClick={() => runNow(task.id)}
							icon={<Play size={11} strokeWidth={2} aria-hidden />}
						/>
						{withdraw && (
							<IconButton
								size="xs"
								data-task-withdraw=""
								label={text.taskWithdraw}
								ariaLabel={text.taskWithdrawOne}
								onClick={() => withdraw(task.id)}
								icon={<RotateCcw size={11} strokeWidth={2} aria-hidden />}
							/>
						)}
					</>
				)}
				{resumable(task) && (
					<IconButton
						size="xs"
						data-task-retry=""
						label={task.status === "failed" ? text.taskRetryOne : text.taskResumeOne}
						onClick={() => retry(task.id)}
						icon={<Play size={11} strokeWidth={2} aria-hidden />}
					/>
				)}
				{over && (
					<IconButton
						size="xs"
						tone="danger"
						data-task-dismiss=""
						label={text.taskRemove}
						ariaLabel={text.taskRemoveOne}
						onClick={() => dismiss(task.id)}
						icon={<X size={11} strokeWidth={2} aria-hidden />}
					/>
				)}
			</div>
		</div>
	);
}
