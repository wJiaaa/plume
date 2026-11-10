/**
 * 一个供应商提供的模型。
 *
 * 和供应商自己的字段分开，因为回答的是不同的问题：上面是「怎么连上它」，这里是「它能做什么」——这也是填写的顺序，
 * 以后回来改的也多半是这一块。
 */

import type { ProviderTestResult } from "@plume/contract";
import {
	ActionSpinner,
	Button,
	ChoiceMark,
	IconButton,
	MenuBody,
	MenuItem,
	MenuSeparator,
	type MessageKey,
	Popover,
	Scroller,
	ScrollText,
	Text,
	useConfirmer,
	useI18n,
	usePopover,
} from "@plume/ui";
import { isImageModel } from "@plume/llm/image-models";
import { CheckSquare, CircleAlert, CloudDownload, Image, Lightbulb, MoreHorizontal, Palette, Pencil, Play, Plus, Star, Trash2, Wrench } from "@plume/ui/icons";
import { useState } from "react";
import { formatWindow, ModelIcon } from "../../models/index.ts";
import { type ModelConfig, useModels } from "../../models/store.ts";
import { Badge } from "../controls.tsx";
import { Card } from "../layout.tsx";

export function ProviderModels({
	models,
	managed,
	defaultModelId,
	testing,
	testingModelId,
	modelTestResults,
	fetchingModels,
	fetchModelsError,
	onFetchModels,
	onTestModel,
	onEdit,
	onRemove,
	onRemoveMany,
	onSetDefault,
}: {
	models: ModelConfig[];
	/** 由 Magpie 管理：只能测试和设默认，不能增删改。 */
	managed: boolean;
	defaultModelId: string | null;
	/** 供应商自己的连接测试；拉取不该和它抢。 */
	testing: boolean;
	testingModelId?: string | null;
	modelTestResults?: Record<string, ProviderTestResult>;
	fetchingModels?: boolean;
	fetchModelsError?: string | null;
	onFetchModels?: () => void;
	onTestModel?: (modelId: string) => void;
	/** 传 `null` 是新建。 */
	onEdit: (model: ModelConfig | null) => void;
	onRemove: (modelId: string) => void;
	onRemoveMany: (modelIds: string[]) => void;
	onSetDefault: (modelId: string) => void;
}) {
	const { t } = useI18n();
	const confirm = useConfirmer();
	const imageModelId = useModels()?.imageModelId ?? null;
	/*
	 * 批量删除：先进「选择」，勾好再一次删。
	 *
	 * 不在平时就给每行挂一个勾选框——这一页大多数时候是来改一个模型、测一个模型的，一列常驻的勾选框
	 * 只是让每一行多一样要读的东西。选择模式里整行都是勾选的落点，行尾的测试和菜单收起来，免得一次
	 * 点击既像在选又像在测。
	 */
	const [selecting, setSelecting] = useState(false);
	const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
	// 列表在选择期间变了（别处删了一个）：只认还在的。
	const picked = models.filter((model) => chosen.has(model.id));
	const allPicked = models.length > 0 && picked.length === models.length;
	const stopSelecting = () => {
		setSelecting(false);
		setChosen(new Set());
	};
	const toggle = (id: string) =>
		setChosen((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const removePicked = () => {
		const ids = picked.map((model) => model.id);
		const hasDefault = picked.some((model) => model.id === defaultModelId);
		confirm.ask({
			title: t("providerModels.deleteManyConfirm", { n: ids.length }),
			detail: hasDefault ? t("providerModels.deleteManyDefaultDetail") : undefined,
			confirmLabel: t("common.delete"),
			onConfirm: () => {
				onRemoveMany(ids);
				stopSelecting();
			},
		});
	};
	return (
		/*
		 * 编辑器剩下的高度，至少约三行。
		 * 用 `h-0` 加 `grow` 而不是 `flex-1`：它要的高度得是下限而不是全部模型，否则这一列长成整个列表，滚动的是窗格而不是列表。
		 */
		<section className="flex h-0 min-h-[240px] grow flex-col pt-7">
			{/* SectionTitle 的字号和间距，这一行还要放下几个动作。 */}
			<div className="mb-3 flex h-7 shrink-0 items-center gap-1">
				<Text as="h2" size="title" weight="semibold">
					{t("providerModels.list")}
				</Text>
				{models.length > 0 && <span className="ml-1 text-caption text-ink-faint tabular-nums">{models.length}</span>}
				<span className="flex-1" />
				{selecting ? (
					<>
						<Button
							variant="subtle"
							size="sm"
							onClick={() => setChosen(allPicked ? new Set() : new Set(models.map((model) => model.id)))}
							data-model-select-all=""
						>
							{allPicked ? t("common.deselectAll") : t("common.selectAll")}
						</Button>
						<Button
							variant="danger"
							size="sm"
							disabled={picked.length === 0}
							onClick={removePicked}
							icon={<Trash2 size={13} strokeWidth={1.8} aria-hidden />}
							data-model-delete-selected=""
						>
							{t("providerModels.deleteSelected", { n: picked.length })}
						</Button>
						<Button variant="subtle" size="sm" onClick={stopSelecting} data-model-select-done="">
							{t("common.done")}
						</Button>
					</>
				) : managed ? null : (
					<>
						{/*
						 * 这几颗都带字、都不画框：`subtle` 就是为这种成排的动作留的。字补上是因为云朵下载这个图标
						 * 猜不到是「拉取模型」；tooltip 只留那句图标和标题都说不完的说明。
						 */}
						{onFetchModels && (
							<Button
								variant="subtle"
								size="sm"
								onClick={onFetchModels}
								disabled={fetchingModels || testing}
								label={t("providerModels.fetchDetail")}
								icon={fetchingModels ? <ActionSpinner size={13} className="text-accent" /> : <CloudDownload size={13.5} strokeWidth={1.8} aria-hidden />}
							>
								{fetchingModels ? t("providerModels.fetching") : t("providerModels.fetch")}
							</Button>
						)}
						<Button variant="subtle" size="sm" onClick={() => onEdit(null)} icon={<Plus size={13.5} strokeWidth={1.9} aria-hidden />} data-add-model="">
							{t("providerModels.add")}
						</Button>
						{models.length > 1 && (
							<Button
								variant="subtle"
								size="sm"
								onClick={() => setSelecting(true)}
								icon={<CheckSquare size={13.5} strokeWidth={1.8} aria-hidden />}
								data-model-select=""
							>
								{t("providerModels.select")}
							</Button>
						)}
					</>
				)}
			</div>

			{fetchModelsError && (
				<div className="mb-2 flex shrink-0 items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-caption text-danger">
					<CircleAlert size={13} className="shrink-0" />
					<span className="truncate">{fetchModelsError}</span>
				</div>
			)}

			{/* 放得下时是内容的高度，短列表下面不留空卡片；放不下时收缩并滚动。 */}
			<Card data-model-list="" className="flex min-h-0 flex-col">
				<Scroller>
					{models.length > 0 ? (
						models.map((model) => (
							<ModelRow
								key={model.id}
								model={model}
								isDefault={isImageModel(model) ? imageModelId === model.id : defaultModelId === model.id}
								managed={managed}
								testing={testingModelId === model.id}
								testResult={modelTestResults?.[model.id]}
								onTest={() => onTestModel?.(model.id)}
								onEdit={() => onEdit(model)}
								onRemove={() => onRemove(model.id)}
								onSetDefault={() => onSetDefault(model.id)}
								selection={selecting ? { checked: chosen.has(model.id), onToggle: () => toggle(model.id) } : undefined}
							/>
						))
					) : (
						<p className="px-4 py-6 text-center text-label text-ink-muted">{t("providerModels.empty")}</p>
					)}
				</Scroller>
			</Card>
			{confirm.element}
		</section>
	);
}

/* 模型能做什么，三个标记放在定宽的一列里，不管一行有哪几个，后面的上下文大小都上下对齐。 */
const CAPABILITIES: { has: (model: ModelConfig) => boolean; label: MessageKey; Icon: typeof Lightbulb; tone: string }[] = [
	// 排第一：它改变了这一行是什么——生图模型不进对话。
	{ has: (m) => isImageModel(m), label: "modelEditor.imageOutput", Icon: Palette, tone: "bg-accent/12 text-accent" },
	{ has: (m) => m.supportsThinking && !isImageModel(m), label: "modelEditor.thinking", Icon: Lightbulb, tone: "bg-violet/12 text-violet" },
	{ has: (m) => m.supportsImages, label: "modelEditor.images", Icon: Image, tone: "bg-ok/12 text-ok" },
	{ has: (m) => m.supportsTools && !isImageModel(m), label: "modelEditor.toolCalls", Icon: Wrench, tone: "bg-accent/12 text-accent" },
];

function ModelRow({
	model,
	isDefault,
	managed,
	testing,
	testResult,
	onTest,
	onEdit,
	onRemove,
	onSetDefault,
	selection,
}: {
	model: ModelConfig;
	isDefault: boolean;
	managed: boolean;
	testing: boolean;
	testResult?: ProviderTestResult;
	onTest: () => void;
	onEdit: () => void;
	onRemove: () => void;
	onSetDefault: () => void;
	/** 选择模式：整行点下去是勾选，不是编辑。 */
	selection?: { checked: boolean; onToggle: () => void };
}) {
	const { t } = useI18n();
	const confirm = useConfirmer();
	const menu = usePopover();
	const alias = model.name && model.name !== model.modelId ? model.name : null;

	return (
		// 分隔线同别的页面的 Row；悬停底色铺满整行。
		<div className="group/row border-b border-line-soft transition-colors last:border-b-0 hover:bg-card-hover">
			<div className="flex h-12 items-center gap-3 pr-2 pl-4">
				{/* 整个名字就是进编辑的入口；行尾两颗按钮是仅有的另外两扇门。 */}
				<button
					type="button"
					onClick={selection ? selection.onToggle : managed ? undefined : onEdit}
					className="flex min-w-0 flex-1 items-center gap-3 text-left"
					data-model-row={model.modelId}
					{...(selection ? { role: "checkbox", "aria-checked": selection.checked } : {})}
				>
					{selection && (
						<span className="shrink-0 text-ink-muted">
							<ChoiceMark kind="checkbox" checked={selection.checked} />
						</span>
					)}
					<span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-card">
						<ModelIcon model={model.modelId} name={model.name} size={13} />
					</span>
					<ScrollText text={model.modelId} className="min-w-0 shrink font-mono text-label text-ink" />
					{alias && <span className="min-w-0 shrink-[2] truncate text-detail text-ink-muted">{alias}</span>}
					{isDefault && <Badge tone="accent">{t("common.default")}</Badge>}
				</button>

				{testResult && !testing && (
					<span
						data-plume-tip={`${testResult.ok ? t("providerModels.testPassed") : t("providerModels.testFailed")} · ${testResult.message}`}
						className={`flex shrink-0 items-center gap-1.5 font-mono text-caption tabular-nums ${testResult.ok ? "text-ink-muted" : "text-danger"}`}
					>
						<span className={`h-1.5 w-1.5 rounded-full ${testResult.ok ? "bg-ok" : "bg-danger"}`} />
						{testResult.ok ? (testResult.latencyMs > 0 ? `${testResult.latencyMs}ms` : t("providerModels.testPassed")) : t("providerModels.testFailed")}
					</span>
				)}

				<span className="hidden w-[68px] shrink-0 justify-end gap-1 @md:flex">
					{CAPABILITIES.filter((capability) => capability.has(model)).map(({ label, Icon, tone }) => (
						<span key={label} role="img" aria-label={t(label)} data-plume-tip={t(label)} className={`grid h-5 w-5 place-items-center rounded-sm ${tone}`}>
							<Icon size={11} strokeWidth={2} />
						</span>
					))}
				</span>

				<span
					className={`grid h-5 w-[46px] shrink-0 place-items-center rounded-sm font-mono text-caption text-ink-muted tabular-nums ${isImageModel(model) ? "" : "bg-card"}`}
				>
					{/* 生图模型留空：它没有上下文窗口这回事，这一列空着让各行仍然对齐。 */}
					{isImageModel(model) ? "" : formatWindow(model.contextWindow)}
				</span>

				<span className={`flex shrink-0 items-center ${selection ? "invisible" : ""}`}>
					<IconButton
						label={testing ? t("providerModels.connecting") : isImageModel(model) ? t("providerModels.testDraw") : t("providerModels.testOne")}
						disabled={testing}
						explainDisabled
						onClick={onTest}
						className="text-ink-faint group-hover/row:text-ink-muted"
						icon={testing ? <ActionSpinner size={13} className="text-accent" /> : <Play size={13} strokeWidth={1.9} className="ml-0.5" />}
					/>
					<IconButton
						label={t("common.more")}
						menu={menu.open}
						onClick={menu.toggle}
						className="text-ink-faint group-hover/row:text-ink-muted aria-expanded:bg-card-hover aria-expanded:text-ink"
						icon={<MoreHorizontal size={15} strokeWidth={1.8} />}
					/>
				</span>
			</div>

			{testResult && !testResult.ok && !testing && (
				<div className="-mt-1 pr-4 pb-3 pl-[52px] text-detail break-words text-danger">
					<span className="font-medium">{t("providerModels.connectFailed")} </span>
					{testResult.message}
				</div>
			)}

			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="compact" role="menu" label={model.modelId}>
					<MenuBody>
						<MenuItem
							icon={<Star size={13} strokeWidth={1.8} />}
							disabled={isDefault}
							onClick={() => {
								menu.close();
								onSetDefault();
							}}
						>
							{isImageModel(model) ? t("providerModels.makeDefaultImage") : t("providerModels.makeDefault")}
						</MenuItem>
						{!managed && (
							<>
								<MenuItem
									icon={<Pencil size={13} strokeWidth={1.8} />}
									onClick={() => {
										menu.close();
										onEdit();
									}}
								>
									{t("providerModels.editOne")}
								</MenuItem>
								<MenuSeparator />
								<MenuItem
									danger
									icon={<Trash2 size={13} strokeWidth={1.8} />}
									onClick={() => {
										menu.close();
										confirm.ask({
											title: t("providerModels.deleteConfirm", { id: model.modelId }),
											detail: isDefault ? t("providerModels.deleteDefaultDetail") : undefined,
											confirmLabel: t("common.delete"),
											onConfirm: onRemove,
										});
									}}
								>
									{t("providerModels.deleteOne")}
								</MenuItem>
							</>
						)}
					</MenuBody>
				</Popover>
			)}

			{confirm.element}
		</div>
	);
}
