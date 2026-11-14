/**
 * 本插件经 `ui.environmentSection` 往环境卡片里放的两节：这个会话在后台的事（10）、压缩记录（85）。
 * 卡片是别的插件画的，这里只管节的内容；没东西时返回 null，卡片不留空位。数据都来自本插件自己的逻辑入口（`state.useSnapshot`），
 * 点了去的是本插件的任务面板、调用轨迹。
 *
 * 「后台任务」一节把人不在时还会动的都列在一处（人要问的是「我不在时还有什么会动」，不按本体里的两本账分成两节）：还在跑的后台命令、
 * 监视，和模型约好的检查（`schedule_wakeup`）、定时任务（只来一次的 `cron_create`）、轮询（反复的 `cron_create`），叫法和转录里那一行一致。
 * 每一行先说具体在做的事（命令的说明、约它时写给人看的那句），小字是种类和时间；每一项都能当场停下、取消。
 * 不放「全部停止」：要一次清掉，归档、删会话或退出应用，本体都会一起停掉、取消。
 *
 * 这一节带 `attention`：卡片收着时，会自己叫醒这个会话的东西让开关挂圆点——在跑的监视（`wakes`，有输出就开一轮）、
 * 待触发的检查、定时任务和轮询（过一会儿自己开一轮）。普通后台命令不算：开着一个开发服务器是常态，算进去圆点就一直亮着。
 * 会话闲着时输入框上没有停止键，挂着的服务、监视、检查、定时任务和轮询只能在这里停；入口不另放到输入框上：开关上的圆点和计数已经指到这里。
 */

import type { Locale, SessionView, SessionWakeup } from "@plume/contract";
import type { EnvironmentSectionProps } from "@plume/contract/ui";
import { IconButton, ScrollText, Text, useI18n } from "@plume/ui";
import { AlarmClock, History, Square, X } from "@plume/ui/icons";
import { useState, type ReactNode } from "react";
import { MESSAGES, type Plan } from "./messages.ts";
import type { Runtime } from "./state.tsx";

function Label({ children }: { children: ReactNode }) {
	return (
		<div className="plume-diagnostics-section-label">
			<Text size="caption" tone="faint" className="plume-diagnostics-grow">
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

/** 约好的这一项是哪种：检查（`schedule_wakeup`）、定时任务（只来一次的 cron）、轮询（反复的 cron）。 */
function planOf(wakeup: SessionWakeup): Plan {
	return wakeup.kind === "wakeup" ? "checkIn" : wakeup.recurring ? "loop" : "prompt";
}

/** 那句话下面的小字：种类、什么时候；轮询说「下次」，有到期时间的带上。 */
function wakeupMeta(wakeup: SessionWakeup, locale: Locale): string {
	const words = MESSAGES[locale];
	const plan = planOf(wakeup);
	const next = when(wakeup.nextAt, locale);
	return [
		words.plans[plan],
		plan === "loop" ? words.nextAt(next) : next,
		...(wakeup.expiresAt !== undefined ? [words.wakeupExpires(when(wakeup.expiresAt, locale))] : []),
	].join(" · ");
}

export function environmentSections(runtime: Runtime) {
	/** 这个会话在后台的事，一行一项：先是还在跑的命令、监视（点了在任务面板里选中它，端口签要问系统，只在这一节画出来时查），再是约好的几项，按到点先后。 */
	function Background({ session }: EnvironmentSectionProps) {
		const { resolvedLocale } = useI18n();
		const words = MESSAGES[resolvedLocale];
		const id = session.summary.id;
		const data = runtime.state.useSnapshot(id, true, true);
		const [busy, setBusy] = useState<string>();
		const jobs = data.jobs.filter((job) => job.finishedAt === undefined);
		const { wakeups } = data;
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
				{(jobs.length > 0 || wakeups.length > 0) && <Label>{words.jobs}</Label>}
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
								onClick={() => void act(job.id, () => runtime.api.stop(id, job.id, false))}
							/>
						</div>
					);
				})}
				{wakeups.map((wakeup) => (
					<div key={wakeup.id} className="plume-diagnostics-wakeup" data-environment-wakeup={wakeup.id} data-plan={planOf(wakeup)}>
						<AlarmClock size={14} />
						{/* 悬停读到完整的 prompt 和 cron 表达式：行里只放得下一句。 */}
						<div className="plume-diagnostics-grow" data-plume-tip={wakeup.cron ? `${wakeup.cron}\n${wakeup.prompt}` : wakeup.prompt}>
							<Text as="p" size="label" className="plume-diagnostics-truncate">
								{wakeupLabel(wakeup)}
							</Text>
							<Text as="p" size="caption" tone="muted" numeric className="plume-diagnostics-truncate">
								{wakeupMeta(wakeup, resolvedLocale)}
							</Text>
						</div>
						<IconButton
							size="xs"
							label={words.wakeupCancel}
							disabled={busy === wakeup.id}
							icon={<X size={12} />}
							onClick={() => void act(wakeup.id, () => runtime.api.cancelWakeup(id, wakeup.id))}
							data-wakeup-cancel
						/>
					</div>
				))}
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

	/** `attention`：会自己叫醒这个会话的有几个——在跑的监视，待触发的检查、定时任务、轮询各几个。只在卡片收着、这一节没藏起来时被调，那时才每两秒读一次（不查端口）。 */
	function useAttention(session: SessionView): string | undefined {
		const words = MESSAGES[useI18n().resolvedLocale];
		const { jobs, wakeups } = runtime.state.useSnapshot(session.summary.id, true);
		const plans: Record<Plan, number> = { checkIn: 0, prompt: 0, loop: 0 };
		for (const wakeup of wakeups) plans[planOf(wakeup)]++;
		return words.attention(jobs.filter((job) => job.wakes && job.finishedAt === undefined).length, plans);
	}

	return { Background, Compactions, useAttention };
}
