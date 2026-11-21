/**
 * 本插件经 `ui.environmentSection` 往环境卡片放两块内容：后台（运行中的命令、监视和约好的检查）与页脚（压缩记录）。
 * 卡片宿主画“后台”标题和统一行骨架，这里只提供 `EnvironmentRow`；没东西时返回 null。
 */

import type { Locale, SessionView, SessionWakeup } from "@plume/contract";
import type { EnvironmentSectionProps } from "@plume/contract/ui";
import { EnvironmentRow, Text, useI18n, useNow } from "@plume/ui";
import { AlarmClock, Eye, History, Repeat2, SquareTerminal } from "@plume/ui/icons";
import { useState } from "react";
import { MESSAGES, type Plan } from "./messages.ts";
import type { Runtime } from "./state.tsx";

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

/** 约好的这一项是哪种：检查（`schedule_wakeup`）、定时任务（只来一次的 cron）、轮询（反复的 cron）。 */
function planOf(wakeup: SessionWakeup): Plan {
	return wakeup.kind === "wakeup" ? "checkIn" : wakeup.recurring ? "loop" : "prompt";
}

/** 行尾的机器事实：种类和到点时间；轮询说“下次”，有到期时间的放进悬停提示而不是挤在行里。 */
function wakeupMeta(wakeup: SessionWakeup, locale: Locale): string {
	const words = MESSAGES[locale];
	const plan = planOf(wakeup);
	const next = when(wakeup.nextAt, locale);
	return `${words.plans[plan]} · ${plan === "loop" ? words.nextAt(next) : next}`;
}

export function environmentSections(runtime: Runtime) {
	/** 这个会话在后台的事，一行一项：人写的说明在左，端口、种类和时间在右，停下或取消只在悬停时盖住行尾。 */
	function Background({ session }: EnvironmentSectionProps) {
		const { resolvedLocale } = useI18n();
		const words = MESSAGES[resolvedLocale];
		const id = session.summary.id;
		const data = runtime.state.useSnapshot(id, true, true);
		const [busy, setBusy] = useState<string>();
		const jobs = data.jobs.filter((job) => job.finishedAt === undefined);
		const { wakeups } = data;
		const now = useNow(wakeups.length > 0, 1000);
		if (jobs.length === 0 && wakeups.length === 0 && !data.error) return null;
		const act = async (key: string, run: () => PromiseLike<unknown>) => {
			setBusy(key);
			try {
				await run();
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
				{jobs.map((job) => {
					const port = job.endpoints[0]?.port;
					return (
						<EnvironmentRow
							key={job.id}
							icon={job.wakes ? <Eye size={14} /> : <SquareTerminal size={14} />}
							title={job.description || job.command}
							fact={
								<>
									{job.wakes && <span data-environment-monitor>{words.monitor}</span>}
									{port !== undefined && <span data-environment-port>:{port}</span>}
								</>
							}
							running
							tip={job.wakes ? `${words.monitorTip}\n${job.command}` : job.command}
							onClick={() => runtime.openJob(id, job.id)}
							action={{
								label: words.stop,
								disabled: busy === job.id || job.status === "stopping",
								onClick: () => void act(job.id, () => runtime.api.stop(id, job.id, false)),
							}}
							data-environment-job={job.id}
						/>
					);
				})}
				{wakeups.map((wakeup) => {
					const left = wakeup.nextAt - now;
					const progress = wakeup.kind === "wakeup" ? left / Math.max(1, wakeup.nextAt - wakeup.createdAt) : undefined;
					const tip = [wakeup.cron, wakeup.prompt, wakeup.expiresAt === undefined ? undefined : words.wakeupExpires(when(wakeup.expiresAt, resolvedLocale))]
						.filter(Boolean)
						.join("\n");
					return (
						<EnvironmentRow
							key={wakeup.id}
							icon={planOf(wakeup) === "loop" ? <Repeat2 size={14} /> : <AlarmClock size={14} />}
							title={wakeupLabel(wakeup)}
							fact={wakeupMeta(wakeup, resolvedLocale)}
							progress={progress}
							urgent={left <= 60_000}
							tip={tip}
							action={{
								label: words.wakeupCancel,
								disabled: busy === wakeup.id,
								onClick: () => void act(wakeup.id, () => runtime.api.cancelWakeup(id, wakeup.id)),
								"data-wakeup-cancel": "",
							}}
							data-environment-wakeup={wakeup.id}
							data-plan={planOf(wakeup)}
						/>
					);
				})}
			</>
		);
	}

	/** 这个会话压缩过几次：作为整张卡片的页脚，点了到调用轨迹里看。 */
	function Compactions({ session }: EnvironmentSectionProps) {
		const words = MESSAGES[useI18n().resolvedLocale];
		const count = session.compactionRuns.length;
		if (count === 0) return null;
		return (
			<EnvironmentRow
				icon={<History size={14} />}
				title={words.compactionCount(count)}
				onClick={() => runtime.openTrace(session.summary.id)}
				data-environment-compactions=""
			/>
		);
	}

	/** `attention`：会自己叫醒这个会话的有几个，在跑的监视与待触发的检查、定时任务、轮询。 */
	function useAttention(session: SessionView): string | undefined {
		const words = MESSAGES[useI18n().resolvedLocale];
		const { jobs, wakeups } = runtime.state.useSnapshot(session.summary.id, true);
		const plans: Record<Plan, number> = { checkIn: 0, prompt: 0, loop: 0 };
		for (const wakeup of wakeups) plans[planOf(wakeup)]++;
		return words.attention(jobs.filter((job) => job.wakes && job.finishedAt === undefined).length, plans);
	}

	return { Background, Compactions, useAttention };
}
