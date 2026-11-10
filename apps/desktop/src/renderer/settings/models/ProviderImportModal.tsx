/**
 * 供应商文件会做什么，做之前先给人看。
 *
 * 导入不只是追加：从另一台机器导出的文件通常带着这台已经有的供应商 id，一半的条目是替换而不是新增。两者在 JSON 里
 * 读起来一模一样，导入之后却天差地别，所以这里是逐行标明的列表，而不是对整个文件问一句是或否。
 *
 * key 那一列是另一半：key 没跟过来的供应商（发文件前被人去掉了）其余处处完整，却连不上端点，导入前知道比下一条消息时才知道好。
 */

import type { ProviderImportEntry } from "@plume/contract";
import { Button, DialogAction, DialogFrame, Overlay, ScrollText, useI18n } from "@plume/ui";
import { CheckSquare, KeyRound, Square, Upload } from "@plume/ui/icons";
import { useState } from "react";
import { Badge } from "../controls.tsx";

export function ProviderImportModal({
	entries,
	dropped,
	onCancel,
	onImport,
}: {
	entries: ProviderImportEntry[];
	/** 文件里读不懂的条目数；这个程序自己写的文件是 0。 */
	dropped: number;
	onCancel: () => void;
	/** 勾选的供应商 id。 */
	onImport: (chosen: string[]) => void;
}) {
	const { t } = useI18n();
	const [selected, setSelected] = useState<Set<string>>(() => new Set(entries.map((entry) => entry.id)));

	const chosen = entries.filter((entry) => selected.has(entry.id));
	const allSelected = chosen.length === entries.length;

	function toggle(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setSelected(next);
	}

	return (
		<Overlay onClose={onCancel} width={560}>
			{(dismiss) => (
				<DialogFrame
					icon={<Upload size={20} className="shrink-0 text-accent" />}
					title={
						<span className="flex min-w-0 items-center gap-2">
							<span className="truncate">{t("providerTransfer.importTitle")}</span>
							<span className="shrink-0 rounded-full bg-card-hover px-2 py-0.5 text-caption font-medium text-ink-muted">{entries.length}</span>
						</span>
					}
					bodyClassName="max-h-[min(460px,50dvh)]"
					status={
						// 和拉取弹窗同一颗：方块里一个勾选框认不出是「全选」，名字写出来就够了。
						<div className="flex items-center">
							<Button
								variant="subtle"
								size="sm"
								// 左边让出内衬，方块和正文左沿对齐。
								className="-ml-3"
								onClick={() => setSelected(allSelected ? new Set() : new Set(entries.map((entry) => entry.id)))}
								icon={
									allSelected ? (
										<CheckSquare size={14} className="text-accent" strokeWidth={2} />
									) : (
										<Square size={14} className="text-ink-faint" strokeWidth={1.8} />
									)
								}
							>
								{t(allSelected ? "common.deselectAll" : "common.selectAll")}
							</Button>
						</div>
					}
					actions={
						<>
							{/* 上面选择的后果，放在按下去之前会看的地方。 */}
							<span className="min-w-0 flex-1 truncate text-caption text-ink-muted">
								{t("providerTransfer.importPlan", {
									add: chosen.filter((entry) => entry.kind === "new").length,
									replace: chosen.filter((entry) => entry.kind === "replace").length,
								})}
							</span>
							{/* 名字和数字一起留着：✓3 不说明这一按是导入还是保留。 */}
							<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
							<DialogAction
								tone="primary"
								disabled={chosen.length === 0}
								onClick={() => dismiss(() => onImport(chosen.map((entry) => entry.id)))}
								className="tabular-nums"
								data-provider-import-confirm=""
							>
								{t("providerTransfer.importAction", { n: chosen.length })}
							</DialogAction>
						</>
					}
				>
					<div className="space-y-1.5" data-provider-import="">
						{entries.map((entry) => (
							<Row key={entry.id} entry={entry} checked={selected.has(entry.id)} onToggle={() => toggle(entry.id)} />
						))}
						{dropped > 0 && <p className="pt-1 text-detail text-ink-faint">{t("providerTransfer.dropped", { n: dropped })}</p>}
					</div>
				</DialogFrame>
			)}
		</Overlay>
	);
}

function Row({ entry, checked, onToggle }: { entry: ProviderImportEntry; checked: boolean; onToggle: () => void }) {
	const { t } = useI18n();
	return (
		<label
			data-provider-import-row={entry.id}
			className={`flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 transition-colors select-none ${
				checked ? "border-accent/40 bg-accent/[0.04]" : "border-line bg-card hover:bg-card-hover/40"
			}`}
		>
			{/* 一颗勾选框：读屏要听到是哪个供应商、勾没勾上。焦点环走全局的 focus-visible，不在这里关掉。 */}
			<button type="button" role="checkbox" aria-checked={checked} aria-label={entry.name} onClick={onToggle} className="shrink-0">
				{checked ? (
					<CheckSquare size={16} className="text-accent" strokeWidth={2} />
				) : (
					<Square size={16} className="text-ink-faint hover:text-ink" strokeWidth={1.8} />
				)}
			</button>

			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-label text-ink">{entry.name}</span>
					<Badge tone={entry.kind === "replace" ? "accent" : "muted"}>
						{t(entry.kind === "replace" ? "providerTransfer.willReplace" : "providerTransfer.willAdd")}
					</Badge>
				</div>
				<ScrollText text={entry.baseUrl} className="mt-0.5 font-mono text-detail text-ink-faint" />
			</div>

			<span className="shrink-0 rounded bg-card px-1.5 py-0.5 font-mono text-caption text-ink-faint">
				{t("providerTransfer.modelCount", { n: entry.models })}
			</span>
			<KeyMark entry={entry} />
		</label>
	);
}

/** 三种状态，因为「文件里没有 key」有两种意思。 */
function KeyMark({ entry }: { entry: ProviderImportEntry }) {
	const { t } = useI18n();
	const tone = entry.hasKey ? "text-ok" : entry.keepsLocalKey ? "text-ink-faint" : "text-danger";
	const label = entry.hasKey ? t("providerTransfer.keyIncluded") : entry.keepsLocalKey ? t("providerTransfer.keyKept") : t("providerTransfer.keyMissing");
	return (
		<span data-plume-tip={label} aria-label={label} className={`shrink-0 ${tone}`}>
			<KeyRound size={14} strokeWidth={1.8} />
		</span>
	);
}
