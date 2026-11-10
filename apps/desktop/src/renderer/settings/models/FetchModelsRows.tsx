/**
 * 拉取弹窗列表的几个零件：带标题的一组、一行模型、名字旁边的说明，以及把搜索变成「添加这个模型」的那一行。
 * 弹窗本身——勾了什么、应用会做什么——在 FetchModelsModal。
 */

import { Button, ChoiceMark, useI18n } from "@plume/ui";
import { isImageModel, isImageModelId } from "@plume/llm/image-models";
import { Palette, Plus } from "@plume/ui/icons";
import type { HTMLAttributes, ReactNode } from "react";
import { formatWindow, ModelIcon } from "../../models/index.ts";
import type { ProviderEntry } from "../../models/store.ts";
import { windowLabel } from "./model-defaults.ts";
import type { SyncRow } from "./model-sync.ts";

/**
 * 带标题的一串行，各自有自己的全选。
 *
 * 每组一个，而不是搜索框旁边一个：两组取消勾选的意思相反——一组是删掉已配置的，一组是跳过提供的，一个同时管两组的
 * 「取消全选」会把「我不要新的」变成「把我已有的全删了」。按钮写着字：左边什么都没有的光秃勾选框读起来什么都不是。
 */
export function Group({
	label,
	rows,
	unchecked,
	onToggleAll,
	children,
	...rest
}: {
	label: string;
	rows: readonly SyncRow[];
	unchecked: ReadonlySet<string>;
	onToggleAll: (ids: readonly string[], checked: boolean) => void;
	children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
	const { t } = useI18n();
	const allChecked = rows.every((row) => !unchecked.has(row.modelId));
	return (
		<div role="group" aria-label={label} className="pt-1.5 first:pt-0" {...rest}>
			<div className="flex h-7 items-center justify-between px-2.5">
				<span className="text-caption font-medium text-ink-muted">
					{label}
					<span className="ml-1.5 font-normal text-ink-faint tabular-nums">{rows.length}</span>
				</span>
				{rows.length > 1 && (
					<Button
						variant="subtle"
						size="xs"
						onClick={() =>
							onToggleAll(
								rows.map((row) => row.modelId),
								!allChecked,
							)
						}
						data-fetch-toggle-all=""
					>
						{allChecked ? t("common.deselectAll") : t("common.selectAll")}
					</Button>
				)}
			</div>
			<div className="space-y-0.5">{children}</div>
		</div>
	);
}

/*
 * 一行就是一行，不是一张卡片：每行带边框和底色的话，三十几个模型就是三十几张叠着的卡片，默认全勾时一齐亮起来，
 * 屏幕在说边框而不是名字。
 *
 * 勾上也不给行上色：每行打开时都勾着，铺满整屏的状态什么也区分不了。勾选框那一列说明它，底色留给指针下的那一行。
 * 应用后这一行会做什么，在名字旁边用字说，而且只在不是显而易见的时候说：要移除的已配置模型、手动输入的名字、
 * 端点已经不再列出的已配置模型。
 */
export function ModelRow({
	provider,
	row,
	checked,
	onToggle,
}: {
	provider: Pick<ProviderEntry, "baseUrl">;
	row: SyncRow;
	checked: boolean;
	onToggle: (checked: boolean) => void;
}) {
	const { t } = useI18n();
	const image = row.existing ? isImageModel(row.existing) : isImageModelId(row.modelId);
	const removing = Boolean(row.existing) && !checked;
	// 已配置的显示它自己的窗口；新的显示导入时会写的那个，出自同一次目录查询（model-defaults.ts）。
	// 生图模型没有上下文窗口，这一列空着，其余的照样对齐。
	const contextWindow = image ? "" : row.existing ? formatWindow(row.existing.contextWindow) : windowLabel(provider, row.modelId);
	return (
		<label
			className="group flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 transition-colors select-none hover:bg-card-hover"
			data-fetch-row={row.modelId}
			data-fetch-state={row.existing ? (checked ? "keep" : "remove") : checked ? "add" : "skip"}
		>
			<span className="flex min-w-0 items-center gap-3">
				<button
					type="button"
					role="checkbox"
					aria-checked={checked}
					aria-label={row.modelId}
					onClick={(event) => {
						event.stopPropagation();
						onToggle(!checked);
					}}
					className="shrink-0 cursor-pointer text-ink-muted focus:outline-none"
				>
					<ChoiceMark kind="checkbox" checked={checked} />
				</button>
				<ModelIcon model={row.modelId} name={row.existing?.name} size={16} />
				<span className={`truncate font-mono text-label transition-colors ${removing ? "text-ink-faint line-through decoration-ink-faint/60" : "text-ink"}`}>
					{row.modelId}
				</span>
				{image && (
					<span
						role="img"
						aria-label={t("modelEditor.imageOutput")}
						data-plume-tip={t("modelEditor.imageOutput")}
						className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-sm bg-accent/12 text-accent"
					>
						<Palette size={10.5} strokeWidth={2} />
					</span>
				)}
				{removing ? (
					<Tag tone="danger">{t("fetchModels.willRemove")}</Tag>
				) : row.custom ? (
					<Tag tone="accent">{t("fetchModels.typed")}</Tag>
				) : row.existing && !row.listed ? (
					<Tag tone="muted" tip={t("fetchModels.unlistedDetail")}>
						{t("fetchModels.unlisted")}
					</Tag>
				) : null}
			</span>
			<span className="shrink-0 font-mono text-caption text-ink-faint">{contextWindow}</span>
		</label>
	);
}

function Tag({ tone, tip, children }: { tone: "danger" | "accent" | "muted"; tip?: string; children: ReactNode }) {
	const paint = tone === "danger" ? "bg-danger/10 text-danger" : tone === "accent" ? "bg-accent/10 text-accent" : "bg-ink-faint/10 text-ink-faint";
	return (
		<span data-plume-tip={tip} className={`shrink-0 rounded px-1.5 py-px text-caption ${paint}`}>
			{children}
		</span>
	);
}

/**
 * 搜索变成一个要添加的名字——给中转提供却不列出的模型。
 *
 * 放在最上面而不是匹配结果后面，因为它就是对输入的回答：下面的匹配是建议，这一行是那个东西本身。回车也一样。
 */
export function AddRow({ name, onAdd }: { name: string; onAdd: () => void }) {
	const { t } = useI18n();
	return (
		<button
			type="button"
			onClick={onAdd}
			className="mb-1 flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-card-hover"
			data-fetch-add=""
		>
			<span className="grid size-4 shrink-0 place-items-center text-accent">
				<Plus size={14} strokeWidth={2.2} />
			</span>
			<span className="min-w-0 truncate font-mono text-label text-ink">{name}</span>
			<span className="ml-auto flex shrink-0 items-center gap-1.5 text-caption text-ink-faint">
				{t("fetchModels.addTyped")}
				<kbd className="rounded border border-line-soft px-1 font-sans text-caption">↵</kbd>
			</span>
		</button>
	);
}
