/**
 * 设置页里选一个模型的下拉：框里写模型名，跟随时后面跟一句来源（「随主会话」）；点开是和输入框旁同一份模型菜单。
 *
 * 不带模型的标：智能体页一列好几行，只写名字读得更快。插件经 `ui.ModelSelect` 用的也是它。
 * `compact` 只剩一枚箭头，贴在它管的那颗按钮旁边当分体按钮，见 `ModelSelectProps.compact`。
 */

import type { ModelSelectProps } from "@plume/contract/ui";
import { ScrollText, useI18n, usePopover } from "@plume/ui";
import { ChevronDown } from "@plume/ui/icons";
import { ModelMenu } from "./ModelMenu.tsx";
import { modelIdentity } from "./model-grouping.ts";
import { useModels } from "./store.ts";

export function ModelSelect({
	value,
	onChange,
	ariaLabel,
	inheritLabel,
	inheritDetail,
	inheritedModelId,
	inheritedSource,
	disabled,
	compact,
	onOpenSettings,
	kind,
}: ModelSelectProps & { onOpenSettings: () => void; kind?: "chat" | "image" }) {
	const { t } = useI18n();
	const settings = useModels();
	const menu = usePopover();
	const selected = modelIdentity(settings, value || inheritedModelId, kind);
	const label = selected
		? selected.ambiguous
			? `${selected.model.name} · ${selected.provider.name}`
			: selected.model.name
		: value || inheritedModelId
			? t("model.unavailable")
			: inheritedSource
				? t("model.notSet")
				: inheritLabel;
	const tip = selected ? `${selected.provider.name} · ${selected.model.name}${value ? "" : ` · ${inheritDetail ?? inheritLabel}`}` : value || inheritDetail;
	return (
		<>
			<button
				type="button"
				aria-label={ariaLabel}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				disabled={disabled}
				onClick={menu.toggle}
				data-plume-select=""
				data-plume-tip={tip}
				data-set={value ? "" : undefined}
				className={`${compact ? "plume-field-quiet px-1.5" : "plume-field"} max-w-[240px] justify-between gap-2 disabled:opacity-60`}
			>
				{!compact && (
					<>
						{/* 挤不下时先让出位置的是来源，不是模型名——模型名才是这一格要回答的。 */}
						<span className="min-w-0 flex-1 text-left">
							<ScrollText text={label} />
						</span>
						{!value && inheritedSource && <span className="shrink-0 text-caption text-ink-muted">{inheritedSource}</span>}
					</>
				)}
				<ChevronDown size={12} className={`shrink-0 text-ink-faint transition-transform duration-[var(--plume-t-quick)] ${menu.open ? "rotate-180" : ""}`} />
			</button>
			{menu.open && !disabled && (
				<ModelMenu
					anchor={menu.anchor}
					onClose={menu.close}
					target={{ selection: { value, onChange, inheritLabel, ...(inheritDetail ? { inheritDetail } : {}), ...(kind ? { kind } : {}) } }}
					onError={() => undefined}
					onOpenSettings={onOpenSettings}
				/>
			)}
		</>
	);
}
