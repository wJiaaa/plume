/**
 * 新版本是什么、要怎么办：下载的一个视图，不是它的主人。
 *
 * 外框是 `Dialog`；进度在正文里。关掉对话框不停任何东西，它本来就没拿着什么。
 */

import { Dialog, DialogAction, useI18n } from "@plume/ui";
import { ExternalLink } from "@plume/ui/icons";
import type { UpdateInfo, UpdatePhase } from "../../shared/update.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import { notify } from "../toast/index.ts";
import { notesForLocale } from "./notes-locale.ts";
import { confirmLabel, controlsFor, failureDetail, fractionOf, mb, publishedOn } from "./view.ts";

function ProgressStatus({ phase, fraction }: { phase: UpdatePhase; fraction: number | null }) {
	const { t } = useI18n();
	if (phase.at === "ready") return <p className="text-detail text-ok">{t("update.readyRestart")}</p>;
	if (phase.at !== "downloading" && phase.at !== "paused" && phase.at !== "preparing") return null;
	const percent = Math.round((fraction ?? 0) * 100);
	const bytes = phase.at === "preparing" ? null : `${mb(phase.received)} / ${mb(phase.total)}`;
	return (
		<div data-plume-update-progress className="rounded-2xl bg-card px-4 py-3">
			<div className="flex items-baseline justify-between text-detail">
				<span className="text-ink-muted">
					{phase.at === "downloading" && t("updateDialog.downloading")}
					{phase.at === "paused" && t("updateDialog.paused")}
					{phase.at === "preparing" && t("updateDialog.preparing")}
				</span>
				<span className="text-ink-faint tabular-nums">
					<span className="text-ink">{percent}%</span>
					{bytes ? <span className="pl-2">{bytes}</span> : null}
				</span>
			</div>
			<div className="mt-2 h-1 overflow-hidden rounded-full bg-ink/10">
				<div
					className={`h-full rounded-full transition-[width,background-color] duration-[var(--plume-t-base)] ease-out ${
						phase.at === "paused" ? "bg-ink-faint" : "bg-accent"
					}`}
					style={{ width: `${Math.max(2, (fraction ?? 0) * 100)}%` }}
				/>
			</div>
		</div>
	);
}

export function UpdateDialog({ info, phase, onClose }: { info: UpdateInfo; phase: UpdatePhase; onClose: () => void }) {
	const { t, resolvedLocale } = useI18n();
	const fraction = fractionOf(phase);
	const controls = controlsFor(phase);
	const notes = info.notes ? notesForLocale(info.notes, resolvedLocale) : "";
	const meta = [info.latest, t("updateDialog.current", { version: info.current })];
	if (info.asset) meta.push(mb(info.asset.size));
	if (info.publishedAt) meta.push(publishedOn(info.publishedAt, resolvedLocale));

	const confirm = async () => {
		if (controls.confirmPauses) {
			void window.plume.updates.pause();
			return;
		}
		if (phase.at === "ready") {
			if (!(await window.plume.updates.relaunch())) notify(t("updateDialog.notReady"), "warn");
			return;
		}
		// 结果经 onProgress 到，和别的阶段一样。
		void window.plume.updates.download(info.latest);
	};

	return (
		<Dialog
			onClose={onClose}
			width={480}
			height={480}
			data-plume-update-dialog=""
			title={t("updateDialog.available")}
			detail={meta.join(" · ")}
			status={
				phase.at === "failed" ? (
					<div className="rounded-2xl bg-card px-4 py-3">
						<p className="text-label font-medium text-ink">{t("updateDialog.failedTitle")}</p>
						<p className="mt-1 text-detail leading-relaxed text-ink-muted">{failureDetail(phase.error)}</p>
						{phase.received > 0 ? (
							<p className="mt-1 text-caption text-ink-faint tabular-nums">{t("updateDialog.downloadedSoFar", { size: mb(phase.received) })}</p>
						) : null}
					</div>
				) : phase.at === "idle" ? undefined : (
					<ProgressStatus phase={phase} fraction={fraction} />
				)
			}
			actions={(dismiss) => (
				<>
					{controls.cancel ? <DialogAction onClick={() => void window.plume.updates.cancel()}>{t("updateDialog.cancel")}</DialogAction> : null}
					<div className="flex-1" />
					<DialogAction onClick={() => dismiss()}>{t("common.close")}</DialogAction>
					{info.asset ? (
						<DialogAction tone="primary" disabled={controls.confirmDisabled} onClick={() => void confirm()}>
							{confirmLabel(phase, t)}
						</DialogAction>
					) : (
						// 没有这台机器的安装包：只剩发布页可给。
						<DialogAction
							tone="primary"
							onClick={() => {
								void window.plume.updates.open(info.url);
								dismiss();
							}}
						>
							<ExternalLink size={13} strokeWidth={2} aria-hidden />
							{t("updateDialog.releasePage")}
						</DialogAction>
					)}
				</>
			)}
		>
			{notes ? (
				<>
					<p className="mb-2 text-caption font-medium text-ink-faint">{t("updateDialog.whatsNew")}</p>
					<div className="text-label leading-relaxed text-ink/90">
						<Markdown text={notes} className="text-label" />
					</div>
				</>
			) : phase.at !== "failed" ? (
				<p className="text-detail text-ink-faint">{t("updateDialog.available")}</p>
			) : null}
		</Dialog>
	);
}
