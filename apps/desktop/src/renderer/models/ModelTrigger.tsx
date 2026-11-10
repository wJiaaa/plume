/**
 * 输入框那一行里的模型：一个标、一个名字，其余都在悬停提示里。点开是模型菜单。
 *
 * 不是设置页那种带边框、像输入框一样大的选择控件：输入框本身已经有边框，里面再套一个，五个控件里就有一个被框起来。
 */

import { RollingText, useI18n, usePopover, useRolled } from "@plume/ui";
import { ChevronDown } from "@plume/ui/icons";
import { FIT_PROBE } from "../composer/fit.ts";
import { ModelIcon } from "./ModelIcon.tsx";
import { formatWindow, ModelMenu, type ModelSelection } from "./ModelMenu.tsx";
import { modelIdentity, modelTooltip } from "./model-grouping.ts";
import { effectiveModelId, type ComposerSession } from "./session.ts";
import { useModels } from "./store.ts";

export function ModelTrigger({
	session,
	disabled,
	onError,
	onOpenSettings,
	selection,
	inheriting,
}: {
	/** 按钮上画哪个模型：`session.model` 是这一轮实际会用的那个。 */
	session: ComposerSession;
	disabled?: boolean;
	onError: (message: string) => void;
	onOpenSettings: () => void;
	/** 选中不直接写到 `session` 上、交给它（子会话的「跟随主会话」）。 */
	selection?: ModelSelection;
	/** 正跟着别处的模型时，悬停说明多一行写明跟着谁。 */
	inheriting?: string;
}) {
	const { t } = useI18n();
	const settings = useModels();
	const menu = usePopover();
	const modelId = effectiveModelId(settings, session.model);
	const identity = modelIdentity(settings, modelId);
	// 只有两个模型同名、光说名字有歧义时才说出供应商。
	const name = identity ? (identity.ambiguous ? `${identity.provider.name} · ${identity.model.name}` : identity.model.name) : null;
	const rolls = useRolled(modelId ?? "");
	const tooltip = modelTooltip(identity, formatWindow);
	return (
		<>
			<button
				type="button"
				data-model-trigger=""
				onClick={menu.toggle}
				disabled={disabled}
				data-plume-tip={inheriting && identity ? `${tooltip}\n${inheriting}` : tooltip}
				aria-label={t("composer.selectModel")}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				className={`plume-composer-control flex min-w-0 items-center gap-1 rounded-lg pr-1.5 pl-2 text-label transition-colors disabled:opacity-60 ${
					menu.open ? "bg-card-hover text-ink" : "text-ink hover:bg-card-hover"
				}`}
			>
				{/* 以模型为 key：换了一家，标和旁边的名字一起翻过去，而不是在它下面直接换掉。 */}
				<ModelIcon key={modelId} model={identity?.model.modelId} name={name} className={rolls ? "plume-roll" : ""} />
				{/* 这一行里唯一会让位的东西，所以名字被截断就是这一行放不下了的时候；`fit.ts` 量的就是它。 */}
				<RollingText className={`${FIT_PROBE} min-w-0 truncate`}>{name ?? t("composer.selectModel")}</RollingText>
				<ChevronDown size={14} className="shrink-0 text-ink-muted" aria-hidden />
			</button>
			{menu.open && !disabled && (
				<ModelMenu
					anchor={menu.anchor}
					onClose={menu.close}
					target={selection ? { selection } : { session }}
					onError={onError}
					onOpenSettings={onOpenSettings}
				/>
			)}
		</>
	);
}
