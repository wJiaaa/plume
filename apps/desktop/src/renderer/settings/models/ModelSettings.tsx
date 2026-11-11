/**
 * 模型设置页：一边是供应商列表，一边是选中的那个。
 *
 * 这里只有布局。改一个供应商实际做什么、容易漏的后果（删掉供应商让默认模型落空）在 useProviders；一个供应商长什么样在
 * ProviderEditor。三个文件，三个问题。列表和编辑器共用一张设置卡片，中间一条分隔线；编辑器自己的几节是其他设置页
 * 用的同一种带标题的卡片。
 */

import { DialogAction, IconButton, MenuBody, MenuItem, Popover, Scroller, ScrollText, useConfirmer, useI18n, usePopover } from "@plume/ui";
import { Download, MoreHorizontal, Plus, Upload } from "@plume/ui/icons";
import { useState } from "react";
import type { ModelConfig } from "../../models/store.ts";
import { Card, PageHeader } from "../layout.tsx";
import { FetchModelsModal } from "./FetchModelsModal.tsx";
import { ModelEditor } from "./ModelEditor.tsx";
import { ProviderAddDialog } from "./ProviderAddDialog.tsx";
import { ProviderAvatar } from "./ProviderAvatar.tsx";
import { ProviderEditor } from "./ProviderEditor.tsx";
import { ProviderImportModal } from "./ProviderImportModal.tsx";
import { useProviders } from "./useProviders.ts";
import { useProviderTransfer } from "./useProviderTransfer.ts";

/** Magpie 接管时合成的供应商，见 packages/core/agent/src/magpie.ts。 */
const MAGPIE_PROVIDER_ID = "magpie";

export function ModelSettings() {
	const { t, formatDate } = useI18n();
	const p = useProviders();
	const transfer = useProviderTransfer();
	const confirm = useConfirmer();
	const transferMenu = usePopover();
	const [editingModel, setEditingModel] = useState<{ providerId: string; model: ModelConfig | null } | null>(null);
	const [adding, setAdding] = useState(false);
	const selected = p.selected;

	return (
		// 窗口矮到放不下供应商编辑器的最小高度时，整页还能滚。
		<Scroller className="flex-1" contentClassName="flex flex-col">
			<PageHeader
				className="shrink-0 pt-2"
				title={t("modelSettings.title")}
				actions={
					<>
						{/* 把列表带到另一台机器上一年也做不了一次，所以收在 ⋯ 后面、把字写全——两个光秃的箭头猜不出哪个是导入。 */}
						<IconButton
							label={t("common.more")}
							menu={transferMenu.open}
							onClick={transferMenu.toggle}
							className="aria-expanded:bg-card-hover aria-expanded:text-ink"
							icon={<MoreHorizontal size={16} strokeWidth={1.8} />}
							data-provider-transfer=""
						/>
						{/* 添加供应商放在页面右上角：列表底部那颗会被一长串供应商挤出视野。 */}
						<DialogAction tone="primary" onClick={() => setAdding(true)} data-add-provider="">
							<Plus size={14} strokeWidth={2} aria-hidden />
							{t("modelSettings.addProvider")}
						</DialogAction>
					</>
				}
			>
				{/* 上限、能力和价格都从这份目录来；它会自动更新，这里给个看得见的版本和手动更新的入口。 */}
				<p className="mt-1 text-detail text-ink-faint" data-model-catalog="">
					{t("modelSettings.catalogStatus", {
						source: p.catalog.name,
						date: formatDate(new Date(p.catalog.updatedAt)),
						count: p.catalogModels,
					})}
					{" · "}
					<button
						type="button"
						disabled={p.updatingCatalog}
						onClick={() => void p.updateCatalog()}
						className="text-ink-muted transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-60"
					>
						{p.updatingCatalog ? t("modelSettings.catalogUpdating") : t("modelSettings.catalogUpdate")}
					</button>
					{p.catalogResult && !p.updatingCatalog && (
						<span className={p.catalogResult.status === "failed" ? "text-danger" : undefined}>
							{" · "}
							{p.catalogResult.status === "failed"
								? t("modelSettings.catalogFailed", { error: p.catalogResult.error ?? "" })
								: t(p.catalogResult.status === "updated" ? "modelSettings.catalogUpdated" : "modelSettings.catalogUnchanged")}
						</span>
					)}
				</p>
			</PageHeader>

			{transferMenu.open && (
				<Popover anchor={transferMenu.anchor} onClose={transferMenu.close} placement="bottom" align="end" width="compact" role="menu" label={t("common.more")}>
					<MenuBody>
						<MenuItem
							icon={<Upload size={13} strokeWidth={1.8} />}
							onClick={() => {
								transferMenu.close();
								void transfer.offer();
							}}
						>
							{t("providerTransfer.importTip")}
						</MenuItem>
						<MenuItem
							icon={<Download size={13} strokeWidth={1.8} />}
							disabled={!transfer.canExport}
							onClick={() => {
								transferMenu.close();
								confirm.ask({
									title: t("providerTransfer.exportConfirm"),
									detail: t("providerTransfer.exportConfirmDetail"),
									confirmLabel: t("providerTransfer.exportAction"),
									onConfirm: () => void transfer.exportAll(),
								});
							}}
						>
							{t("providerTransfer.exportTip")}
						</MenuItem>
					</MenuBody>
				</Popover>
			)}

			{/*
			 * 有地方就并排，没地方就上下叠。量的是这个容器而不是窗口：窄窗口里设置页占满整个宽度，宽窗口里只占一部分。
			 * 从 @xl（576px）起并排：编辑器还剩约 340px，每个字段都放得下；设置导航开合时这一页也不会跟着重排。
			 * 查询的元素和被查询的元素不能是同一个：容器由内容撑开，只能被它的后代问。
			 */}
			<div className="@container flex min-h-[340px] flex-1">
				<Card className="mb-6 flex min-h-0 flex-1 flex-col @xl:flex-row" data-provider-panes="">
					{/* 两个窗格各自滚动，长长的供应商列表不会带着编辑器动。分隔线贯穿卡片整个高度，所以内边距在窗格上而不在卡片上。 */}
					<Scroller
						className="max-h-[168px] shrink-0 border-b border-line-soft @xl:max-h-none @xl:w-[232px] @xl:border-r @xl:border-b-0"
						contentClassName="flex flex-col gap-0.5 p-3"
					>
						{p.providers.map((provider) => (
							<button
								key={provider.id}
								type="button"
								onClick={() => p.select(provider.id)}
								aria-current={selected?.id === provider.id ? "true" : undefined}
								data-provider-item={provider.id}
								// 选中用底色而不是描边——这一页的线已经够多了。
								className={`flex h-9 w-full shrink-0 items-center gap-2.5 rounded-lg pr-2.5 pl-2 text-left transition-colors ${
									selected?.id === provider.id ? "bg-card-hover" : "hover:bg-card-hover/50"
								}`}
							>
								<ProviderAvatar name={provider.name} size="sm" className={provider.enabled ? "" : "opacity-50"} />
								<ScrollText text={provider.name} className={`min-w-0 flex-1 text-label ${provider.enabled ? "text-ink" : "text-ink-muted"}`} />
								{provider.enabled ? (
									<span className="h-[6px] w-[6px] shrink-0 rounded-full bg-ok" />
								) : (
									<span className="shrink-0 text-caption text-ink-faint">{t("common.disabled")}</span>
								)}
							</button>
						))}
					</Scroller>

					{/* 一个 flex 列，编辑器能撑满它、把滚动交给模型列表；连那都放不下时这个窗格才滚。 */}
					<Scroller className="min-w-0 flex-1" contentClassName="flex flex-col p-4 @xl:px-6 @xl:py-5">
						{!selected ? (
							<div className="flex h-full flex-col items-center justify-center gap-3 text-center">
								<p className="text-label text-ink-muted">{t("modelSettings.noProviders")}</p>
								<DialogAction tone="primary" onClick={() => setAdding(true)} data-add-provider="">
									<Plus size={14} strokeWidth={2} aria-hidden />
									{t("modelSettings.addFirst")}
								</DialogAction>
							</div>
						) : (
							/*
							 * 带 key，换供应商时字段重置而不是带过去。导入次数也在 key 里：导入按原 id 替换供应商，key 不会变，
							 * 只在挂载时取初值的地址框会继续显示导入前的值——文件说一样，表单说另一样，而人读的是表单。
							 */
							<ProviderEditor
								key={`${selected.id}:${transfer.imports}`}
								provider={selected}
								managed={selected.id === MAGPIE_PROVIDER_ID}
								defaultModelId={p.defaultModelId}
								testResult={p.testResult}
								testing={p.testing}
								testingModelIds={p.testingModelIds}
								modelTestResults={p.modelTestResults}
								fetchingModels={p.fetchingModels}
								fetchModelsError={p.fetchModelsError}
								saveError={p.saveError}
								onFetchModels={() => void p.fetchModelsFromEndpoint()}
								onTest={() => void p.test()}
								onTestModel={(modelId) => void p.test(modelId)}
								onChange={(patch) => void p.update(selected.id, patch)}
								onRemove={() => void p.remove(selected.id)}
								onEditModel={(model) => setEditingModel({ providerId: selected.id, model })}
								onRemoveModel={(modelId) => void p.removeModel(selected.id, modelId)}
								onRemoveModels={(modelIds) => void p.removeModels(selected.id, modelIds)}
								onSetDefault={(modelId) => void p.setDefaultModel(modelId)}
							/>
						)}
					</Scroller>
				</Card>
			</div>

			{editingModel && (
				<ModelEditor
					provider={p.providers.find((provider) => provider.id === editingModel.providerId) ?? { id: editingModel.providerId, baseUrl: "" }}
					model={editingModel.model}
					onCancel={() => setEditingModel(null)}
					onSave={(model) => p.saveModel(editingModel.providerId, model, editingModel.model)}
				/>
			)}

			{adding && <ProviderAddDialog onClose={() => setAdding(false)} onAdd={(draft, fetch) => void p.add(draft, fetch)} />}

			{p.discoveredModels && (
				<FetchModelsModal
					provider={selected ?? { baseUrl: "" }}
					listed={p.discoveredModels}
					models={selected?.models ?? []}
					onClose={p.closeDiscoveredModal}
					onApply={(change) => void p.applyDiscoveredChange(change)}
				/>
			)}

			{transfer.pending && (
				<ProviderImportModal
					entries={transfer.pending.entries}
					dropped={transfer.pending.dropped}
					onCancel={transfer.cancelImport}
					onImport={(chosen) => void transfer.confirmImport(chosen)}
				/>
			)}

			{confirm.element}
		</Scroller>
	);
}
