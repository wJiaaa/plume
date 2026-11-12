/**
 * 本插件经 `ui.environmentSection` 往环境卡片里放的三节：在跑的后台任务（10）、待触发的定时唤醒（50）、压缩记录（85）。
 * 卡片是别的插件画的，这里只管节的内容；没东西时返回 null，卡片不留空位。数据都来自本插件自己的逻辑入口（`state.useSnapshot`），
 * 点了去的是本插件的任务面板、调用轨迹。
 *
 * 后台任务、定时唤醒两节带 `attention`：卡片收着时，会自己叫醒这个会话的东西让开关挂圆点——在跑的 `monitor`（有输出就开一轮）、
 * 待触发的唤醒（过一会儿自己开一轮）。普通后台命令不算：开着一个开发服务器是常态，算进去圆点就一直亮着。
 */

import type { SessionView, SessionWakeup } from "@plume/contract";
import type { EnvironmentSectionProps } from "@plume/contract/ui";
import { IconButton, ScrollText, Text, useI18n } from "@plume/ui";
import { AlarmClock, History, Square, X } from "@plume/ui/icons";
import { useState, type ReactNode } from "react";
import { MESSAGES } from "./messages.ts";
import type { Runtime } from "./state.tsx";

function Label({ children }: { children: ReactNode }) {
	return (
		<div className="plume-diagnostics-section-label">
			<Text size="caption" tone="faint">
				{children}
			</Text>
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
	/** 还在跑的后台任务，一行一个：点了在任务面板里选中它，端口签要问系统，只在这一节画出来时查。 */
	function Jobs({ session }: EnvironmentSectionProps) {
		const words = MESSAGES[useI18n().resolvedLocale];
		const id = session.summary.id;
		const data = runtime.state.useSnapshot(id, true, true);
		const [busy, setBusy] = useState<string>();
		const jobs = data.jobs.filter((job) => job.finishedAt === undefined);
		if (jobs.length === 0 && !data.error) return null;
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
				{jobs.length > 0 && <Label>{words.jobs}</Label>}
				{jobs.map((job) => {
					const port = job.endpoints[0]?.port;
					return (
						<div key={job.id} className="plume-diagnostics-heading" data-environment-job={job.id}>
							<button
								type="button"
								className="plume-diagnostics-row plume-diagnostics-grow"
								data-plume-tip={job.kind === "monitor" ? `${words.monitorTip}\n${job.command}` : job.command}
								onClick={() => runtime.openJob(id, job.id)}
							>
								<span className="plume-diagnostics-dot" data-status="running" />
								<Text size="detail" mono className="plume-diagnostics-grow">
									<ScrollText text={job.description || job.command} />
								</Text>
								{/* 和普通后台命令分开：它每送一批输出就是一轮，人得认得出哪一行在持续花钱。 */}
								{job.kind === "monitor" && (
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
		const { wakeups } = runtime.state.useSnapshot(id, true);
		if (wakeups.length === 0) return null;
		const cancel = (wakeupId: string) =>
			void runtime.api
				.cancelWakeup(id, wakeupId)
				.then(() => runtime.state.refresh(id))
				.catch((error: unknown) => runtime.ui.notify(String(error), "error"));
		return (
			<>
				<Label>{words.wakeups}</Label>
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
		const count = jobs.filter((job) => job.kind === "monitor" && job.finishedAt === undefined).length;
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
