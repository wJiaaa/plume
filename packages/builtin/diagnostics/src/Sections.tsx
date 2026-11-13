/**
 * 本插件经 `ui.environmentSection` 往环境卡片里放的三节：在跑的后台任务（10）、待触发的定时唤醒（50）、压缩记录（85）。
 * 卡片是别的插件画的，这里只管节的内容；没东西时返回 null，卡片不留空位。数据都来自本插件自己的逻辑入口（`state.useSnapshot`），
 * 点了去的是本插件的任务面板、调用轨迹。
 *
 * 后台任务、定时唤醒两节带 `attention`：卡片收着时，会自己叫醒这个会话的东西让开关挂圆点——在跑的监视命令（`wakes`，有输出就开一轮）、
 * 待触发的唤醒（过一会儿自己开一轮）。普通后台命令不算：开着一个开发服务器是常态，算进去圆点就一直亮着。
 *
 * 两节合起来有不止一项时，显示着的、排在前面的那一节标题行上有「全部停止」（`StopAll`），一次停掉这个会话这两节里的全部：
 * 后台任务一节显示着、有在跑的任务时放在它上面，否则放在定时唤醒一节上；两节都被藏起来就不出。
 * 会话闲着时输入框上没有停止键，挂着的服务、监视、唤醒只能在这里停；入口不另放到输入框上：开关上的圆点和计数已经指到这里。
 */

import type { SessionView, SessionWakeup } from "@plume/contract";
import type { EnvironmentSectionProps } from "@plume/contract/ui";
import { Button, IconButton, ScrollText, Text, useConfirmer, useI18n } from "@plume/ui";
import { AlarmClock, History, Square, X } from "@plume/ui/icons";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { MESSAGES } from "./messages.ts";
import type { Runtime } from "./state.tsx";

function Label({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<div className="plume-diagnostics-section-label">
			<Text size="caption" tone="faint" className="plume-diagnostics-grow">
				{children}
			</Text>
			{action}
		</div>
	);
}

/** 今天的只写时刻，别的日子带上日期。 */
function when(at: number, locale: string): string {
	const sameDay = new Date(at).toDateString() === new Date().toDateString();
	return new Intl.DateTimeFormat(
		locale,
		sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
	).format(at);
}

/** 和对话里送达那一行同一句：唤醒写了理由用理由，否则是 prompt 的第一行。 */
function wakeupLabel(wakeup: SessionWakeup): string {
	return wakeup.reason?.trim() || (wakeup.prompt.split("\n").find((line) => line.trim()) ?? "").trim();
}

export function environmentSections(runtime: Runtime) {
	/**
	 * 哪些会话的后台任务一节此刻画着（按会话数挂着的个数）。卡片的「显示哪些内容」藏掉的节根本不挂上，这里不读卡片的偏好，
	 * 只看挂没挂：定时唤醒一节据此知道「全部停止」该不该落到自己身上。
	 */
	const jobsShown = new Map<string, number>();
	const jobsListeners = new Set<() => void>();
	const subscribeJobs = (listener: () => void) => {
		jobsListeners.add(listener);
		return () => {
			jobsListeners.delete(listener);
		};
	};
	const markJobsShown = (sessionId: string, delta: number) => {
		const next = (jobsShown.get(sessionId) ?? 0) + delta;
		if (next > 0) jobsShown.set(sessionId, next);
		else jobsShown.delete(sessionId);
		for (const listener of jobsListeners) listener();
	};

	/**
	 * 一次停掉这个会话的全部后台事：还在跑的后台任务（开发服务器、监视、没跑完的命令）和待触发的定时唤醒。停了拿不回来
	 * （服务要 agent 重新起，唤醒要它重新约），所以先问一句，问题里数清各有几项。逐项的停止、取消不问，和原来一样。
	 */
	function StopAll({ sessionId, jobs, wakeups }: { sessionId: string; jobs: number; wakeups: number }) {
		const words = MESSAGES[useI18n().resolvedLocale];
		const confirm = useConfirmer();
		const [busy, setBusy] = useState(false);
		const run = async () => {
			setBusy(true);
			try {
				await runtime.api.stopAll(sessionId);
			} catch (error) {
				runtime.ui.notify(String(error), "error");
			} finally {
				await runtime.state.refresh(sessionId);
				setBusy(false);
			}
		};
		return (
			<>
				<Button
					size="xs"
					loading={busy}
					data-environment-stop-all
					onClick={() =>
						confirm.ask({ title: words.stopAllConfirm, detail: words.stopAllDetail(jobs, wakeups), confirmLabel: words.stopAll, onConfirm: () => void run() })
					}
				>
					{words.stopAll}
				</Button>
				{confirm.element}
			</>
		);
	}

	/** 还在跑的后台任务，一行一个：点了在任务面板里选中它，端口签要问系统，只在这一节画出来时查。 */
	function Jobs({ session }: EnvironmentSectionProps) {
		const words = MESSAGES[useI18n().resolvedLocale];
		const id = session.summary.id;
		const data = runtime.state.useSnapshot(id, true, true);
		const [busy, setBusy] = useState<string>();
		useEffect(() => {
			markJobsShown(id, 1);
			return () => markJobsShown(id, -1);
		}, [id]);
		const jobs = data.jobs.filter((job) => job.finishedAt === undefined);
		if (jobs.length === 0 && !data.error) return null;
		const everything = jobs.length + data.wakeups.length;
		const stop = async (jobId: string) => {
			setBusy(jobId);
			try {
				await runtime.api.stop(id, jobId, false);
				await runtime.state.refresh(id);
			} catch (error) {
				runtime.ui.notify(String(error), "error");
			} finally {
				setBusy(undefined);
			}
		};
		return (
			<>
				{data.error && (
					<Text as="p" size="caption" tone="danger" role="alert">
						{data.error}
					</Text>
				)}
				{jobs.length > 0 && <Label action={everything > 1 && <StopAll sessionId={id} jobs={jobs.length} wakeups={data.wakeups.length} />}>{words.jobs}</Label>}
				{jobs.map((job) => {
					const port = job.endpoints[0]?.port;
					return (
						<div key={job.id} className="plume-diagnostics-heading" data-environment-job={job.id}>
							<button
								type="button"
								className="plume-diagnostics-row plume-diagnostics-grow"
								data-plume-tip={job.wakes ? `${words.monitorTip}\n${job.command}` : job.command}
								onClick={() => runtime.openJob(id, job.id)}
							>
								<span className="plume-diagnostics-dot" data-status="running" />
								<Text size="detail" mono className="plume-diagnostics-grow">
									<ScrollText text={job.description || job.command} />
								</Text>
								{/* 和普通后台命令分开：它每送一批输出就是一轮，人得认得出哪一行在持续花钱。 */}
								{job.wakes && (
									<Text size="caption" tone="muted" data-environment-monitor>
										{words.monitor}
									</Text>
								)}
								{port !== undefined && (
									<Text size="caption" tone="faint" numeric data-environment-port>
										:{port}
									</Text>
								)}
							</button>
							<IconButton
								size="sm"
								label={words.stop}
								disabled={busy === job.id || job.status === "stopping"}
								icon={<Square size={11} />}
								onClick={() => void stop(job.id)}
							/>
						</div>
					);
				})}
			</>
		);
	}

	/**
	 * 模型给这个对话安排的定时唤醒，还没触发的那些。对话里那次工具调用很快就被顶上去了，而它说的事要几分钟、几小时后才发生——
	 * 这一节回答「它还会不会自己动起来、什么时候」，每一项都能当场取消。节底那一句说清楚它们只活在这次运行里。
	 */
	function Wakeups({ session }: EnvironmentSectionProps) {
		const { resolvedLocale } = useI18n();
		const words = MESSAGES[resolvedLocale];
		const id = session.summary.id;
		const { wakeups, jobs } = runtime.state.useSnapshot(id, true);
		const jobsHere = useSyncExternalStore(subscribeJobs, () => jobsShown.has(id));
		if (wakeups.length === 0) return null;
		// 后台任务一节显示着、有在跑的任务时，「全部停止」在排在前面的它那里；它被藏起来时落到这一节，任务照样一起停。
		const running = jobs.filter((job) => job.finishedAt === undefined).length;
		const owner = !(jobsHere && running > 0);
		const cancel = (wakeupId: string) =>
			void runtime.api
				.cancelWakeup(id, wakeupId)
				.then(() => runtime.state.refresh(id))
				.catch((error: unknown) => runtime.ui.notify(String(error), "error"));
		return (
			<>
				<Label action={owner && running + wakeups.length > 1 && <StopAll sessionId={id} jobs={running} wakeups={wakeups.length} />}>{words.wakeups}</Label>
				{wakeups.map((wakeup) => {
					const meta = [
						when(wakeup.nextAt, resolvedLocale),
						wakeup.recurring ? words.wakeupRecurring : words.wakeupOnce,
						...(wakeup.expiresAt !== undefined ? [words.wakeupExpires(when(wakeup.expiresAt, resolvedLocale))] : []),
					].join(" · ");
					return (
						<div key={wakeup.id} className="plume-diagnostics-wakeup" data-environment-wakeup={wakeup.id}>
							<AlarmClock size={14} />
							{/* 悬停读到完整的 prompt 和 cron 表达式：行里只放得下一句。 */}
							<div className="plume-diagnostics-grow" data-plume-tip={wakeup.cron ? `${wakeup.cron}\n${wakeup.prompt}` : wakeup.prompt}>
								<Text as="p" size="label" className="plume-diagnostics-truncate">
									{wakeupLabel(wakeup)}
								</Text>
								<Text as="p" size="caption" tone="muted" numeric className="plume-diagnostics-truncate">
									{meta}
								</Text>
							</div>
							<IconButton size="xs" label={words.wakeupCancel} icon={<X size={12} />} onClick={() => cancel(wakeup.id)} data-wakeup-cancel />
						</div>
					);
				})}
				<Text as="p" size="caption" tone="faint" className="plume-diagnostics-note">
					{words.wakeupMemoryOnly}
				</Text>
			</>
		);
	}

	/** 这个会话压缩过几次：点了到调用轨迹里看。 */
	function Compactions({ session }: EnvironmentSectionProps) {
		const words = MESSAGES[useI18n().resolvedLocale];
		const count = session.compactionRuns.length;
		if (count === 0) return null;
		return (
			<>
				<Label>{words.compactions}</Label>
				<button type="button" className="plume-diagnostics-row" onClick={() => runtime.openTrace(session.summary.id)}>
					<History size={14} />
					<Text size="detail" className="plume-diagnostics-grow">
						{words.summary}
					</Text>
					<Text size="caption" tone="faint" numeric>
						{count}
					</Text>
				</button>
			</>
		);
	}

	/** `attention`：在跑的监视有几个。只在卡片收着、这一节没藏起来时被调，那时才每两秒读一次任务（不查端口）。 */
	function useMonitors(session: SessionView): string | undefined {
		const words = MESSAGES[useI18n().resolvedLocale];
		const { jobs } = runtime.state.useSnapshot(session.summary.id, true);
		const count = jobs.filter((job) => job.wakes && job.finishedAt === undefined).length;
		return count > 0 ? words.runningMonitors(count) : undefined;
	}

	/** `attention`：待触发的定时唤醒有几个。 */
	function usePendingWakeups(session: SessionView): string | undefined {
		const words = MESSAGES[useI18n().resolvedLocale];
		const { wakeups } = runtime.state.useSnapshot(session.summary.id, true);
		return wakeups.length > 0 ? words.pendingWakeups(wakeups.length) : undefined;
	}

	return { Jobs, Wakeups, Compactions, useMonitors, usePendingWakeups };
}
