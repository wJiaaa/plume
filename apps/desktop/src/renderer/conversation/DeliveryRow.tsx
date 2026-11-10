/**
 * 后台的事有结果了——对话里的一行说明，不是一个人发的气泡。
 *
 * 后台命令结束、`monitor` 送来新输出时，宿主把结果作为一条运行时送达交给模型（`ToolRun.background`）。那条消息是写给模型的：
 * 原样画出来，读的人会看见一大段自己没说过的话落在自己那一侧；什么都不画，模型又会像是自己突然动了起来。所以画成一行：
 * 和工具行同一个骨架，标题先说结果，摘要说是哪件事，完整命令只在悬停时出现——那串 shell 不是写给人读的。
 *
 * 画后台命令、定时唤醒和新会话交回三种；子会话交回的（不带 `kind`，比如子 Agent 的回报）交给登记了 `ui.agentDelivery`
 * 的插件画成一行「消息来自 @谁」——它的脸是插件的，宿主不认识。
 * 定时唤醒到点了画成「定时唤醒 · 理由」，说明接下来这一轮是谁叫起来的。
 */

import type { DeliveredReport } from "@plume/contract";
import { FlowRow, useI18n } from "@plume/ui";
import { AlarmClock, ChevronRight, CircleAlert, SquarePen, Terminal } from "@plume/ui/icons";
import { AgentDeliverySlot, openReferencedSession, useDeliveryAction } from "../plugins.tsx";
import { notify } from "../toast/index.ts";

export function DeliveryRow({ delivery, sessionId }: { delivery: DeliveredReport[]; sessionId: string }) {
	const jobs = delivery.filter((report) => report.kind === "job");
	const wakeups = delivery.filter((report) => report.kind === "wakeup");
	const sessions = delivery.filter((report) => report.kind === "session");
	const agents = delivery.filter((report) => report.kind === undefined);
	return (
		<>
			{wakeups.map((report) => (
				<WakeupDelivery key={report.id} report={report} />
			))}
			{agents.length > 0 && <AgentDeliverySlot sessionId={sessionId} reports={agents} />}
			{sessions.map((report) => (
				<SessionDelivery key={report.id} report={report} />
			))}
			{jobs.length > 0 && <JobDelivery jobs={jobs} sessionId={sessionId} />}
		</>
	);
}

/**
 * 定时唤醒到点了：一行题注，不能点——要做的事模型这一轮自己会说，还在等的那些在运行诊断的环境卡片里。
 * cron 表达式只在悬停时出现，和后台命令那一行的完整命令一样。
 */
function WakeupDelivery({ report }: { report: DeliveredReport }) {
	const { t } = useI18n();
	return (
		<div data-delivery-row="" data-delivery-kind="wakeup" data-plume-tip={report.command}>
			<FlowRow icon={<AlarmClock size={13} strokeWidth={1.8} className="shrink-0" />} summary={`${t("wakeupReturn.fired")} · ${report.description}`} />
		</div>
	);
}

/**
 * 建议另开的会话交回了第一轮的回复（`LaunchedSession.reportBack`）。回复本身在那个会话里，点了过去；那个会话删掉了就提示一句。
 */
function SessionDelivery({ report }: { report: DeliveredReport }) {
	const { t } = useI18n();
	const failed = report.status === "failed";
	return (
		<div data-delivery-row="" data-delivery-kind="session">
			<FlowRow
				icon={
					failed ? <CircleAlert size={13} strokeWidth={1.8} className="shrink-0 text-danger" /> : <SquarePen size={13} strokeWidth={1.8} className="shrink-0" />
				}
				title={<span className="font-normal">{t("sessionReturn.from")}</span>}
				summary={report.description}
				trailing={
					<>
						{failed && <span className="text-danger">{t("sessionReturn.failed")}</span>}
						{/* 点了是去那个会话，不是就地展开：箭头自己画。 */}
						<ChevronRight size={12} strokeWidth={2} aria-hidden />
					</>
				}
				onToggle={() => void openReferencedSession(report.id).catch(() => notify(t("peers.sessionGone"), "warn"))}
				label={report.description}
			/>
		</div>
	);
}

function JobDelivery({ jobs, sessionId }: { jobs: DeliveredReport[]; sessionId: string }) {
	const { t } = useI18n();
	const reveal = useDeliveryAction("job");
	const failed = jobs.filter((job) => job.status === "failed").length;
	const one = jobs.length === 1 ? jobs[0]! : null;
	const title = one
		? one.monitor
			? one.monitor.stopped
				? t("jobReturn.monitorStopped")
				: t("jobReturn.monitorLines", { n: one.monitor.lines })
			: t(one.status === "failed" ? "jobReturn.failed" : "jobReturn.done")
		: // `monitor` 的一批是还在跑的命令送来的输出，「N 个后台命令结束」对它不成立。
			t(jobs.some((job) => job.monitor) ? "jobReturn.manyUpdates" : "jobReturn.many", { n: jobs.length });
	const trailing = one
		? one.monitor?.stopped
			? t(one.monitor.stopped === "idle" ? "jobReturn.monitorIdle" : "jobReturn.monitorMaxEvents")
			: one.status === "failed"
				? one.exitCode == null
					? t("jobReturn.killed")
					: t("jobReturn.exitCode", { code: one.exitCode })
				: undefined
		: failed > 0
			? t("jobReturn.failedCount", { n: failed })
			: undefined;
	return (
		<div data-delivery-row="" data-delivery-kind="job" data-plume-tip={jobs.map((job) => job.command ?? job.description).join("\n")}>
			<FlowRow
				onToggle={reveal ? () => reveal(sessionId, jobs[0]!.id) : undefined}
				// 只染图标：标题和摘要有自己的墨色，整行标红会让一行说明喊得比回答还响。
				icon={
					failed > 0 ? (
						<CircleAlert size={13} strokeWidth={1.8} className="shrink-0 text-danger" />
					) : (
						<Terminal size={13} strokeWidth={1.8} className="shrink-0" />
					)
				}
				summary={`${title} · ${jobs.map((job) => job.description).join(" · ")}`}
				trailing={trailing}
			/>
		</div>
	);
}
