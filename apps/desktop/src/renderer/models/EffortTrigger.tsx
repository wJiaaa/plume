/**
 * 思考档位，在输入框那一行里的样子。
 *
 * 和 ModelTrigger 成对：一个说「谁来答」，一个说「答之前想多久」，两件事都是这条消息的属性，所以两枚控件长一个样、排在一起。
 */

import { RollingText, useI18n, usePopover } from "@plume/ui";
import { Brain, ChevronDown } from "@plume/ui/icons";
import { EffortMenu, effortLabel } from "./EffortMenu.tsx";
import { chosenThinking, effectiveModel, effectiveThinking, type ComposerSession } from "./session.ts";
import { useModels } from "./store.ts";

export function EffortTrigger({ session, disabled, onError }: { session: ComposerSession; disabled?: boolean; onError: (message: string) => void }) {
	const { t } = useI18n();
	const settings = useModels();
	const menu = usePopover();
	const model = effectiveModel(settings, session.model);
	const label = effortLabel(effectiveThinking(model, chosenThinking(session)), model, t);
	return (
		<>
			<button
				type="button"
				data-effort-trigger=""
				onClick={menu.toggle}
				disabled={disabled}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				aria-label={t("composer.thinking", { level: label })}
				data-plume-tip={t("composer.thinking", { level: label })}
				className={`plume-composer-control flex shrink-0 items-center gap-1 rounded-lg px-1.5 text-label transition-colors disabled:opacity-60 ${
					menu.open ? "bg-card-hover text-ink" : "text-ink hover:bg-card-hover"
				}`}
			>
				<Brain size={16} className="shrink-0" aria-hidden />
				<RollingText>{label}</RollingText>
				<ChevronDown size={14} className="shrink-0 text-ink-muted" aria-hidden />
			</button>
			{menu.open && !disabled && <EffortMenu anchor={menu.anchor} onClose={menu.close} session={session} onError={onError} />}
		</>
	);
}
