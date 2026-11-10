/**
 * 端点列出的模型，放在这个供应商已有的模型旁边——也是同时改两边的地方。
 *
 * 经 Overlay 挂载，和应用里其他对话框一样：Overlay 带着 Esc、焦点陷阱、关闭后焦点回到原处和退场动画，
 * 自己在原地画遮罩的话，遮罩会停在设置正文的边上（Scroller 的 mask 让 fixed 相对它定位），旁边的导航栏照样能点。
 *
 * 行的意思在 model-sync.ts：勾选框表示「应用之后在不在列表里」，所以弹窗既能加也能删，端点没列出的名字也能手动输入。
 */

import { DialogAction, DialogFrame, Overlay, SearchField, useI18n } from "@plume/ui";
import { useMemo, useState } from "react";
import type { ModelConfig, ProviderEntry } from "../../models/store.ts";
import { AddRow, Group, ModelRow } from "./FetchModelsRows.tsx";
import { changeOf, cleanModelIds, isNewModelName, type ModelChange, rowMatches, syncRows } from "./model-sync.ts";

export function FetchModelsModal({
	provider,
	listed,
	models,
	onClose,
	onApply,
}: {
	/** 模型来自哪个端点；新的一行要它查目录里的上下文窗口。 */
	provider: Pick<ProviderEntry, "baseUrl">;
	/** 端点返回的。可能为空：中转可以提供它不列出的模型。 */
	listed: readonly string[];
	/** 这个供应商已配置的模型。 */
	models: readonly ModelConfig[];
	onClose: () => void;
	onApply: (change: ModelChange) => void;
}) {
	const { t } = useI18n();
	const [search, setSearch] = useState("");
	const [custom, setCustom] = useState<string[]>([]);
	const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());

	const rows = useMemo(() => syncRows(listed, models, custom), [listed, models, custom]);
	const query = search.trim();
	const configured = useMemo(() => rows.configured.filter((row) => rowMatches(row, query)), [rows, query]);
	const available = useMemo(() => rows.available.filter((row) => rowMatches(row, query)), [rows, query]);
	const change = useMemo(() => changeOf(rows, unchecked), [rows, unchecked]);
	const canAdd = isNewModelName(query, rows);
	const listedCount = useMemo(() => cleanModelIds(listed).length, [listed]);

	function setChecked(ids: readonly string[], checked: boolean) {
		setUnchecked((current) => {
			const next = new Set(current);
			for (const id of ids) {
				if (checked) next.delete(id);
				else next.add(id);
			}
			return next;
		});
	}

	function addTyped() {
		if (!canAdd) return;
		setCustom((current) => [...current, query]);
		// 取消勾选后又敲了一遍：要的是加进来，所以它勾着出现。
		setChecked([query], true);
	}

	const edits = change.add.length + change.remove.length;
	const applyLabel =
		edits === 0
			? t("fetchModels.apply")
			: change.remove.length === 0
				? t("fetchModels.applyAdd", { n: change.add.length })
				: change.add.length === 0
					? t("fetchModels.applyRemove", { n: change.remove.length })
					: t("fetchModels.applyBoth", { n: edits });

	return (
		<Overlay onClose={onClose} width={540} label={t("fetchModels.title")}>
			{(dismiss) => (
				<DialogFrame
					title={
						<span className="flex min-w-0 items-center gap-2">
							<span className="truncate">{t("fetchModels.title")}</span>
							<span className="shrink-0 rounded-full bg-card-hover px-2 py-0.5 text-caption font-medium text-ink-muted tabular-nums">
								{t("fetchModels.totalCount", { n: listedCount })}
							</span>
						</span>
					}
					bodyClassName="min-h-[220px] max-h-[min(460px,52dvh)]"
					status={
						<SearchField
							value={search}
							onChange={setSearch}
							onEnter={addTyped}
							placeholder={t("fetchModels.search")}
							size="comfortable"
							className="bg-input"
							// Esc 先清空搜索，空了再关弹窗。从这里交过去，是因为输入框拦下了那次按键，Overlay 在 window 上听不到；
							// 焦点一打开就在这个框里，没有这一句 Esc 就成了按了没反应的键。
							onEscape={() => dismiss()}
						/>
					}
					actions={
						<>
							<span className="flex min-w-0 flex-1 items-center gap-2 truncate text-caption tabular-nums" data-fetch-summary="">
								{edits === 0 ? (
									<span className="text-ink-faint">{t("fetchModels.noChanges")}</span>
								) : (
									<>
										{change.add.length > 0 && <span className="text-accent">{t("fetchModels.toAdd", { n: change.add.length })}</span>}
										{change.add.length > 0 && change.remove.length > 0 && <span className="text-ink-faint">·</span>}
										{change.remove.length > 0 && <span className="text-danger">{t("fetchModels.toRemove", { n: change.remove.length })}</span>}
									</>
								)}
							</span>
							<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
							<DialogAction
								tone={change.add.length === 0 && change.remove.length > 0 ? "danger" : "primary"}
								disabled={edits === 0}
								// 经 dismiss：改动在离开的路上存，而不是压在还在屏幕上的弹窗底下。
								onClick={() => dismiss(() => onApply(change))}
								className="tabular-nums"
								data-fetch-apply=""
							>
								{applyLabel}
							</DialogAction>
						</>
					}
				>
					{/* 行的底色比文字略宽一点，文字本身和标题左沿对齐。 */}
					<div className="-mx-2.5 pb-1">
						{canAdd && <AddRow name={query} onAdd={addTyped} />}

						{configured.length > 0 && (
							<Group label={t("fetchModels.added")} rows={configured} unchecked={unchecked} onToggleAll={setChecked} data-fetch-group="configured">
								{configured.map((row) => (
									<ModelRow
										key={row.modelId}
										provider={provider}
										row={row}
										checked={!unchecked.has(row.modelId)}
										onToggle={(on) => setChecked([row.modelId], on)}
									/>
								))}
							</Group>
						)}

						{available.length > 0 && (
							<Group label={t("fetchModels.available")} rows={available} unchecked={unchecked} onToggleAll={setChecked} data-fetch-group="available">
								{available.map((row) => (
									<ModelRow
										key={row.modelId}
										provider={provider}
										row={row}
										checked={!unchecked.has(row.modelId)}
										onToggle={(on) => setChecked([row.modelId], on)}
									/>
								))}
							</Group>
						)}

						{/*
						 * 只在没有可加的时候、在列表下面说一次：列出的都已经在了，或者端点什么都没列。两种情况下一步都是上面的输入框。
						 */}
						{!query && rows.available.length === 0 && (
							<p className="px-2.5 pt-4 pb-2 text-caption text-ink-faint" data-fetch-empty="">
								{listedCount === 0 ? t("fetchModels.noneListed") : t("fetchModels.nothingNew")}
							</p>
						)}
						{query && !canAdd && configured.length === 0 && available.length === 0 && (
							<p className="py-12 text-center text-caption text-ink-faint">{t("fetchModels.noMatch")}</p>
						)}
					</div>
				</DialogFrame>
			)}
		</Overlay>
	);
}
