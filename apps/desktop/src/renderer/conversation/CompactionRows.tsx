/**
 * 转录里那一行压缩（`CompactionRun`），画在它开始时的位置。
 *
 * 自动的：压完是上下文的一个分界，和换模型一样画成分隔线；进行中（写摘要、等重试、本地整理）、失败、被中断留在行里，进行中字上
 * 扫光、失败红字。人敲的 `/compact`：一只人的气泡写着那条命令，底下一行说进行到哪、结果如何——命令不发给模型，可它是人做的一件事。
 */

import type { CompactionRun } from "@plume/contract";
import { FlowRow, useI18n } from "@plume/ui";
import { Check, CircleAlert, FoldVertical, Minus, Terminal } from "@plume/ui/icons";
import { DividerRow } from "./DividerRow.tsx";
import { MessageActions } from "./MessageActions.tsx";

export function CompactionRow({ run }: { run: CompactionRun }) {
	const { t } = useI18n();
	const running = run.status === "running";
	const Icon = running ? Terminal : run.status === "done" ? Check : run.status === "failed" ? CircleAlert : Minus;
	const counts = { before: run.before ?? 0, after: run.after ?? 0 };

	if (run.input === undefined) {
		if (run.status === "done") {
			const text = t(run.via === "fallback" || run.via === "dropped" ? "compact.autoFallbackDone" : "compact.autoDone", counts);
			return (
				<DividerRow
					data-compaction={run.id}
					data-compaction-status={run.status}
					icon={<FoldVertical size={12} strokeWidth={1.8} aria-hidden className="shrink-0" />}
					text={run.retries > 0 ? `${text} · ${t("compact.autoRetries", { n: run.retries })}` : text}
				/>
			);
		}
		const key =
			run.status === "cancelled"
				? "compact.autoInterrupted"
				: run.status === "failed" || run.status === "skipped"
					? "compact.autoFailed"
					: run.phase === "retrying"
						? "compact.autoRetrying"
						: run.phase === "fallback"
							? "compact.autoFallback"
							: "compact.autoSummarizing";
		return (
			<div data-compaction={run.id} data-compaction-status={run.status} data-compaction-phase={run.phase}>
				<FlowRow
					icon={<Icon size={13} strokeWidth={1.8} />}
					title={t("compact.autoTitle")}
					summary={t(key, { ...counts, count: run.retries })}
					trailing={!running && run.retries > 0 ? t("compact.autoRetries", { n: run.retries }) : undefined}
					running={running}
					danger={run.status === "failed"}
				/>
			</div>
		);
	}

	const note = running ? t("compactNote.running") : run.code ? t(`compactNote.${run.code}`, { ...counts, error: run.error ?? "" }) : "";
	return (
		<div className="group/msg flex w-full flex-col items-end" data-compaction={run.id} data-compaction-status={run.status}>
			<div className="plume-user-bubble max-w-[85%] rounded-2xl bg-card px-4 py-2.5 sm:max-w-[75%]">
				<p className="whitespace-pre-wrap break-words text-label leading-6 text-ink">
					<span className="plume-command-token">/compact</span>
					{run.input.slice("/compact".length)}
				</p>
			</div>
			<MessageActions timestamp={run.startedAt} text={run.input} className="mt-1 pr-1" />
			<div className="self-start">
				<FlowRow icon={<Icon size={13} strokeWidth={1.8} />} summary={note} running={running} danger={run.status === "failed"} />
			</div>
		</div>
	);
}
