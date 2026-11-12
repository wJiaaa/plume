/**
 * 后台的事有结果了——对话里的一行说明，不是一个人发的气泡。
 *
 * 后台结果到了时，宿主把它作为一条运行时送达交给模型（子会话交回、`ToolRun.background`、新会话交回）。那条消息是写给模型的：
 * 原样画出来，读的人会看见一大段自己没说过的话落在自己那一侧；什么都不画，模型又会像是自己突然动了起来。所以画成一行。
 *
 * 每份是谁交的（`DeliveredReport.plugin`）就交给谁画：那个插件登记了 `ui.agentDelivery` 的，它交的几份一起交给它
 * （「消息来自 @谁」「后台命令完成」，脸和字都是插件的）；没登记、停用了的，宿主按通用字段画默认的一行。
 */

import type { DeliveredReport } from "@plume/contract";
import { FlowRow, useI18n } from "@plume/ui";
import { ChevronRight, CircleAlert, Inbox, SquarePen } from "@plume/ui/icons";
import { AgentDeliverySlot, openReferencedSession, useDeliveryPlugins } from "../plugins.tsx";
import { notify } from "../toast/index.ts";

export function DeliveryRow({ delivery, sessionId }: { delivery: DeliveredReport[]; sessionId: string }) {
	const drawn = useDeliveryPlugins();
	// 按交它的插件分开，先到的插件在前；同一插件的几份一起交给它。
	const plugins = [...new Set(delivery.map((report) => report.plugin))];
	return plugins.map((plugin) => {
		const reports = delivery.filter((report) => report.plugin === plugin);
		return drawn.has(plugin) ? (
			<AgentDeliverySlot key={plugin} plugin={plugin} sessionId={sessionId} reports={reports} />
		) : (
			reports.map((report) => <DefaultDelivery key={`${plugin}:${report.id}`} report={report} />)
		);
	});
}

/**
 * 没人接管的一份：标题说是什么事，失败、没做完挂在右边。带着 `sessionId` 的是新会话交回的（`LaunchedSession.reportBack`）：
 * 回复本身在那个会话里，点了过去，那个会话删掉了就提示一句。
 */
function DefaultDelivery({ report }: { report: DeliveredReport }) {
	const { t } = useI18n();
	const failed = report.status === "failed";
	const target = report.sessionId;
	const outcome = failed ? t("delivery.failed") : report.status === "aborted" || report.incomplete ? t("delivery.incomplete") : undefined;
	return (
		<div data-delivery-row="" data-delivery-plugin={report.plugin} data-delivery-session={target}>
			<FlowRow
				icon={
					failed ? (
						<CircleAlert size={13} strokeWidth={1.8} className="shrink-0 text-danger" />
					) : target ? (
						<SquarePen size={13} strokeWidth={1.8} className="shrink-0" />
					) : (
						<Inbox size={13} strokeWidth={1.8} className="shrink-0" />
					)
				}
				title={target ? <span className="font-normal">{t("delivery.fromSession")}</span> : undefined}
				summary={report.title}
				trailing={
					target || outcome ? (
						<>
							{outcome && <span className={failed ? "text-danger" : undefined}>{outcome}</span>}
							{/* 点了是去那个会话，不是就地展开：箭头自己画。 */}
							{target && <ChevronRight size={12} strokeWidth={2} aria-hidden />}
						</>
					) : undefined
				}
				onToggle={target ? () => void openReferencedSession(target).catch(() => notify(t("peers.sessionGone"), "warn")) : undefined}
				label={report.title}
			/>
		</div>
	);
}
