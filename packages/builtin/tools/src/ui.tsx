/**
 * 界面入口：本插件交回的结果在对话里的那一行（`ui.agentDelivery`）。后台命令结束、`monitor` 送来新输出、定时唤醒到点时，
 * 结果作为一条运行时送达交给模型；那条消息是写给模型的，原样画出来，读的人会看见一大段自己没说过的话落在自己那一侧，
 * 什么都不画，模型又像是自己突然动了起来。所以画成一行：和工具行同一个骨架，标题先说结果，摘要说是哪件事，
 * 完整命令只在悬停时出现——那串 shell 不是写给人读的。另外登记 `monitor` 在转录里的说法（`ui.toolLine`）。
 */

import type { DeliveredReport } from "@plume/contract";
import type { AgentDeliveryProps, UiContext, UiPlugin } from "@plume/contract/ui";
import { FlowRow, useI18n } from "@plume/ui";
import { AlarmClock, CircleAlert, Terminal } from "@plume/ui/icons";
import type { ComponentType } from "react";
import type { DeliveryDetails } from "./delivery.ts";
import { MESSAGES } from "./messages.ts";
import css from "./tools.css";

type Job = Extract<DeliveryDetails, { kind: "job" }>;

function detailsOf(report: DeliveredReport): DeliveryDetails | undefined {
	const details = report.details as DeliveryDetails | undefined;
	return details?.kind === "job" || details?.kind === "wakeup" ? details : undefined;
}

function deliveries(ui: UiContext): ComponentType<AgentDeliveryProps> {
	return function ToolsDelivery({ sessionId, reports }: AgentDeliveryProps) {
		const text = MESSAGES[useI18n().resolvedLocale];
		const view = ui.useJobViewer();
		const jobs = reports.flatMap((report) => {
			const details = detailsOf(report);
			return details?.kind === "job" ? [{ report, details }] : [];
		});
		return (
			<>
				{reports.map((report) => {
					const details = detailsOf(report);
					if (details?.kind !== "wakeup") return null;
					// 一行题注，不能点：要做的事模型这一轮自己会说，还在等的那些在运行诊断的环境卡片里。cron 表达式只在悬停时出现。
					return (
						<div key={report.id} data-delivery-row="" data-delivery-kind="wakeup" data-plume-tip={details.cron}>
							<FlowRow icon={<AlarmClock size={13} strokeWidth={1.8} className="plume-tools-icon" />} summary={`${text.wakeupFired} · ${report.title}`} />
						</div>
					);
				})}
				{jobs.length > 0 && <JobRow jobs={jobs} open={view ? () => view(sessionId, jobs[0]!.report.id) : undefined} />}
			</>
		);
	};
}

function JobRow({ jobs, open }: { jobs: { report: DeliveredReport; details: Job }[]; open: (() => void) | undefined }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const failed = jobs.filter(({ report }) => report.status === "failed").length;
	const one = jobs.length === 1 ? jobs[0]! : null;
	const monitor = one?.details.monitor;
	const title = one
		? monitor
			? monitor.stopped
				? text.monitorStopped
				: text.monitorLines(monitor.lines)
			: one.report.status === "failed"
				? text.jobFailed
				: text.jobDone
		: // `monitor` 的一批是还在跑的命令送来的输出，「N 个后台命令结束」对它不成立。
			jobs.some(({ details }) => details.monitor)
			? text.jobsUpdated(jobs.length)
			: text.jobsEnded(jobs.length);
	const trailing = one
		? monitor?.stopped
			? monitor.stopped === "idle"
				? text.monitorIdle
				: text.monitorMaxEvents
			: one.report.status === "failed"
				? one.details.exitCode == null
					? text.jobKilled
					: text.jobExitCode(one.details.exitCode)
				: undefined
		: failed > 0
			? text.jobsFailed(failed)
			: undefined;
	return (
		<div data-delivery-row="" data-delivery-kind="job" data-plume-tip={jobs.map(({ details }) => details.command).join("\n")}>
			<FlowRow
				onToggle={open}
				// 只染图标：标题和摘要有自己的墨色，整行标红会让一行说明喊得比回答还响。
				icon={
					failed > 0 ? (
						<CircleAlert size={13} strokeWidth={1.8} className="plume-tools-icon plume-tools-danger" />
					) : (
						<Terminal size={13} strokeWidth={1.8} className="plume-tools-icon" />
					)
				}
				summary={`${title} · ${jobs.map(({ report }) => report.title).join(" · ")}`}
				trailing={trailing}
			/>
		</div>
	);
}

export default {
	name: "plume.tools",
	apply(ui) {
		const style = document.createElement("style");
		style.dataset.pluginStyle = ui.name;
		style.textContent = css;
		document.head.append(style);
		ui.effect(() => style.remove());
		ui.agentDelivery(deliveries(ui));
		// monitor 是长跑的命令：和 bash 归成「跑命令」一类，模型写了说明就说它，没写说「监视命令」。
		ui.toolLine("monitor", { verb: (locale) => MESSAGES[locale].monitorVerb, like: "bash" });
	},
} satisfies UiPlugin;
