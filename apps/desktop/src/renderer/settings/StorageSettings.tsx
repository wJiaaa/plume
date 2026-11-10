/**
 * 会话记录占了多少地方，怎么导出，以及怎么删掉一段。
 *
 * 这一页最要紧的是删除按钮下面那句话：删的是会话本身，对话记录一并消失。独立成一页，不挂在使用统计底下：那一页是拿来读的，
 * 一个不可撤销的删除跟在读数后面，等于每次查账都从「不要点错」开始。花销另记一张表，删会话不影响使用统计里的数。
 *
 * 排版用 `Row`，不自己拼一行 flex：数字会变（「78 条 · 330 MB」换成「77 条」），`flex-wrap` 的行内容宽一点就整组换行；
 * `Row` 是说明在左、控件在右的两列，右边 `shrink-0`，什么都不会跳。
 */

import type { ClearRange, ClearResult, StorageUse } from "@plume/contract";
import { ActionSpinner, Button, DateRangeField, dayKey, inRange, rangeLabel, translate, useConfirmer, useI18n } from "@plume/ui";
import { Download, Trash2 } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { modelsAgent } from "../models/store.ts";
import { Card, PageHeader, Row, SectionTitle } from "./controls.tsx";

export function StorageSettings() {
	const { t } = useI18n();
	const [use, setUse] = useState<StorageUse | null>(null);
	const [range, setRange] = useState<ClearRange>({ from: null, to: null });
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<ClearResult | null>(null);
	const confirm = useConfirmer();
	const [exporting, setExporting] = useState(false);
	/** 导出完说的那句话：写到了哪，或者为什么没写成。 */
	const [exported, setExported] = useState<{ path: string } | { error: string } | null>(null);

	const load = useCallback(async () => {
		try {
			setUse(await modelsAgent().storageUse());
		} catch {
			// 说不出自己要删什么的删除按钮比没有更糟：`use` 为 null 时它按不动。
			setUse(null);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/**
	 * 选了这一段会删掉什么，按下去之前就算出来。口径和 agent 进程那边一样：按会话的最后活动日落不落在这一段里，
	 * `use.days` 就是按那个日期分的组。拿总数去问「删除全部 4 条？」而实际只删 1 条，反过来就是灾难。
	 */
	const target = useMemo(() => {
		const days = (use?.days ?? []).filter((each) => inRange(each.day, range));
		return { sessions: days.reduce((sum, each) => sum + each.sessions, 0), bytes: days.reduce((sum, each) => sum + each.bytes, 0) };
	}, [use, range]);

	/** 一条会话都没有：按钮没有东西可按。 */
	const empty = use !== null && use.sessions === 0;
	/** 选了一段，但那一段里一条会话都没有。 */
	const nothing = target.sessions === 0;

	const run = async () => {
		setBusy(true);
		setDone(null);
		try {
			setDone(await modelsAgent().clearSessions(range));
			await load();
		} finally {
			setBusy(false);
		}
	};

	const ask = () => {
		if (!use || empty || nothing) return;
		const all = !range.from && !range.to;
		confirm.ask({
			title: all ? t("cleanup.confirmAll", { n: target.sessions }) : t("cleanup.confirmSome", { n: target.sessions }),
			detail: t("cleanup.confirmDetail", { range: rangeLabel(range), size: formatBytes(target.bytes) }),
			confirmLabel: t("cleanup.clear"),
			onConfirm: () => void run(),
		});
	};

	const exportAll = async () => {
		setExporting(true);
		setExported(null);
		try {
			const path = await window.plume.sessionsExportPath(translate("storage.exportDialogTitle"), `plume-sessions-${dayKey(new Date())}.db`);
			if (!path) return;
			await modelsAgent().exportSessions(path);
			setExported({ path });
		} catch (error) {
			setExported({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			setExporting(false);
		}
	};

	return (
		<>
			<PageHeader title={t("storage.title")} intro={t("storage.intro")} />

			<SectionTitle>{t("storage.records")}</SectionTitle>
			<Card data-usage-cleanup="true">
				<Row
					title={t("storage.sessionLogs")}
					detail={t("storage.sessionLogsDetail")}
					control={
						<span data-usage-total="true" className="text-label text-ink tabular-nums">
							{use === null ? "—" : t("storage.sizeAndCount", { size: formatBytes(use.bytes), n: use.sessions })}
						</span>
					}
				/>
				<Row
					title={t("storage.exportTitle")}
					detail={
						<>
							{t("storage.exportDetail")}
							{exported && (
								<span data-usage-exported="true" className={`block break-all ${"error" in exported ? "text-danger" : "text-ink-muted"}`}>
									{"error" in exported ? t("storage.exportFailed", { reason: exported.error }) : t("storage.exported", { path: exported.path })}
								</span>
							)}
						</>
					}
					control={
						<Button
							variant="ghost"
							size="sm"
							onClick={() => void exportAll()}
							disabled={exporting || use === null || empty}
							data-usage-export="true"
							icon={exporting ? <ActionSpinner size={12} /> : <Download size={12} strokeWidth={1.9} aria-hidden />}
						>
							{exporting ? t("storage.exporting") : t("storage.export")}
						</Button>
					}
				/>
				<Row
					title={t("cleanup.range")}
					// 「这一段里有几条」写在左边、跟着说明走：每选一次换一个数，右边那列是控件的位置，不该跟着位数横向挪。
					detail={
						use === null
							? t("storage.rangeDetail")
							: empty
								? t("cleanup.empty")
								: nothing
									? t("cleanup.nothing")
									: t("cleanup.willRemove", { n: target.sessions, size: formatBytes(target.bytes) })
					}
					control={<DateRangeField value={range} onChange={setRange} earliest={use?.earliest ?? null} ariaLabel={t("cleanup.range")} />}
				/>
				<Row
					title={t("storage.clearTitle")}
					detail={
						<>
							{t("cleanup.warn")
								.split("**")
								.map((part, index) =>
									index % 2 === 1 ? (
										<strong key={index} className="font-medium text-danger">
											{part}
										</strong>
									) : (
										part
									),
								)}
							{done && (
								<span key={`${done.removed}:${done.freed}`} className="ml-1 animate-[plume-fade-up_var(--plume-t-base)_ease-out] text-ink-muted">
									{done.removed > 0 ? t("cleanup.doneRemoved", { n: done.removed, size: formatBytes(done.freed) }) : t("cleanup.nothing")}
									{done.skipped > 0 && ` · ${t("cleanup.doneSkipped", { n: done.skipped })}`}
								</span>
							)}
						</>
					}
					control={
						<Button
							variant="danger"
							size="sm"
							onClick={ask}
							disabled={busy || use === null || empty || nothing}
							data-usage-clear="true"
							icon={busy ? <ActionSpinner size={12} /> : <Trash2 size={12} strokeWidth={1.9} aria-hidden />}
						>
							{busy ? t("cleanup.clearing") : t("cleanup.clear")}
						</Button>
					}
				/>
			</Card>

			{confirm.element}
		</>
	);
}

/**
 * `264 MB`、`1.4 GB`、`812 KB`。1024 进制，和访达报的数一致；上了 GB 留一位小数，往下都取整。
 */
function formatBytes(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0 KB";
	const kb = value / 1024;
	if (kb < 1) return "1 KB";
	const mb = kb / 1024;
	if (mb < 1) return `${Math.round(kb)} KB`;
	const gb = mb / 1024;
	return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
