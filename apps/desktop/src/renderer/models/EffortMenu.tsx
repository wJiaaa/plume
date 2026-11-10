/**
 * 思考档位菜单：一条点阵滑杆，左边快、右边聪明，下面一句这一档的说明。选中写到这个会话上，下一轮生效。
 */

import type { ModelConfig, ThinkingLevel, ThinkingOption } from "@plume/llm/types";
import { resolveModelThinkingOptions, resolveThinkingOption } from "@plume/llm/thinking-options";
import { type Anchor, IconButton, type MessageKey, Popover, RollingText, translate, useI18n } from "@plume/ui";
import { CircleHelp } from "@plume/ui/icons";
import { useState } from "react";
import { chosenThinking, effectiveModel, effectiveThinking, type ComposerSession } from "./session.ts";
import { modelsAgent, useModels } from "./store.ts";

type Translate = (key: MessageKey) => string;

export function effortLabel(level: ThinkingLevel, model?: ModelConfig | null, t?: Translate): string {
	const selected = resolveThinkingOption(level, model);
	if (!selected) return t?.("thinking.off") ?? translate("common.close");
	return localizeThinkingOption(selected, t).label;
}

export function EffortMenu({
	anchor,
	onClose,
	session,
	onError,
}: {
	anchor: Anchor;
	onClose: () => void;
	session: ComposerSession;
	onError: (message: string) => void;
}) {
	const { t } = useI18n();
	const settings = useModels();
	const [showHelp, setShowHelp] = useState(false);
	/** 刚拖到的那一档，在会话事件回来之前先这样画：滑杆落后一拍，读起来像没拖动。 */
	const [pending, setPending] = useState<ThinkingLevel>();

	const model = effectiveModel(settings, session.model);
	const supported = model?.supportsThinking !== false;

	const options: ThinkingOption[] = resolveModelThinkingOptions(model).map((option) => localizeThinkingOption(option, t));
	// 模型没有这一档时显示的是就近落到的那档，和实际发出去的一致。
	const effective = effectiveThinking(model, pending ?? chosenThinking(session));
	const index = Math.max(
		0,
		options.findIndex((option) => option.id === effective),
	);
	const current = options[index];
	const atMax = options.length > 0 && index === options.length - 1;

	const set = (nextIndex: number) => {
		const next = options[Math.min(options.length - 1, Math.max(0, nextIndex))]?.id;
		if (!next) return;
		setPending(next);
		if (session.id === null) {
			session.setThinking(next);
			return;
		}
		modelsAgent()
			.setSessionThinking(session.id, next)
			.catch((cause: unknown) => {
				setPending(undefined);
				onError(t("turn.thinkingFailed", { reason: cause instanceof Error ? cause.message : String(cause) }));
			});
	};

	return (
		<Popover anchor={anchor} onClose={onClose} placement="top" align="center" width="default" role="group" label={t("thinking.title")}>
			<div className="px-3 py-2.5" data-effort-menu="">
				<div className="flex items-center gap-1.5">
					<span className="text-label text-ink-muted">{t("thinking.title")}</span>
					<span className={`text-label font-medium ${atMax ? "text-violet" : "text-accent"}`}>
						<RollingText>{supported && current ? current.label : t("thinking.unsupported")}</RollingText>
					</span>
					<div className="flex-1" />
					<IconButton
						size="sm"
						label={t("thinking.help")}
						active={showHelp}
						onClick={() => setShowHelp((value) => !value)}
						icon={<CircleHelp size={13} strokeWidth={1.8} />}
					/>
				</div>

				<div className="mt-2 mb-1.5 flex items-center justify-between text-detail text-ink-faint">
					<span>{t("thinking.faster")}</span>
					<span>{t("thinking.smarter")}</span>
				</div>

				<DotSlider value={index} max={Math.max(0, options.length - 1)} disabled={!supported || options.length <= 1} atMax={atMax} onChange={set} />

				{/* 所有说明叠在同一格里：只按最高的那段留高度，换档时滑杆不跳、短的说明下面也不空一行。 */}
				<p className="mt-2 grid text-detail leading-relaxed text-ink-faint">
					{supported &&
						options.map((option) => (
							<span key={option.id} aria-hidden="true" className="invisible col-start-1 row-start-1">
								{option.detail}
							</span>
						))}
					<RollingText rollKey={supported && current ? current.id : "unsupported"} className="col-start-1 row-start-1 block self-start">
						{supported && current ? current.detail : t("thinking.unsupportedDetail")}
					</RollingText>
				</p>

				{/* 一直挂着、只是收起，关的时候和开的时候一样有动画；按条件渲染的话只能动画进来，关是一刀切。 */}
				<div className="plume-reveal" data-open={showHelp} aria-hidden={!showHelp}>
					<div>
						<div className="mt-2.5 space-y-1 border-t border-line-soft pt-2.5 text-caption leading-relaxed text-ink-faint">
							{options.map((entry) => (
								<div key={entry.id} className="flex gap-2">
									<span className={`w-7 shrink-0 transition-colors ${entry.id === effective ? "text-ink" : ""}`}>{entry.label}</span>
									<span className="flex-1">{entry.detail}</span>
								</div>
							))}
							<p className="pt-1">{t("thinking.providerSupport")}</p>
						</div>
					</div>
				</div>
			</div>
		</Popover>
	);
}

/** 标准档位的文字跟着界面语言走；自定义档位名用配置里写的。 */
function localizeThinkingOption(option: ThinkingOption, t?: Translate): ThinkingOption {
	if (!t) return option;
	const labelKey = thinkingLabelKey(option.id);
	const detailKey = thinkingDetailKey(option.id);
	return { ...option, label: labelKey ? t(labelKey) : option.label, detail: detailKey ? t(detailKey) : option.detail };
}

function thinkingLabelKey(level: ThinkingLevel): MessageKey | null {
	switch (level) {
		case "off":
			return "thinking.off";
		case "minimal":
			return "thinking.minimal";
		case "low":
			return "thinking.low";
		case "medium":
			return "thinking.medium";
		case "high":
			return "thinking.high";
		case "xhigh":
			return "thinking.xhigh";
		case "max":
			return "thinking.max";
		case "ultra":
			return "thinking.ultra";
		default:
			return null;
	}
}

function thinkingDetailKey(level: ThinkingLevel): MessageKey | null {
	switch (level) {
		case "off":
			return "thinking.detail.off";
		case "minimal":
			return "thinking.detail.minimal";
		case "low":
			return "thinking.detail.low";
		case "medium":
			return "thinking.detail.medium";
		case "high":
			return "thinking.detail.high";
		case "xhigh":
			return "thinking.detail.xhigh";
		case "max":
			return "thinking.detail.max";
		case "ultra":
			return "thinking.detail.ultra";
		default:
			return null;
	}
}

const COLUMNS = 19;
const ROWS = 3;

/**
 * 画成点阵的分档滑杆。每一列是一小格力度；滑块左边的列亮起来，亮度从左到右渐强，读起来是强度而不是进度条。
 * 到最高一档时亮着的列会呼吸——只有那一档的额外开销值得提醒。
 */
function DotSlider({
	value,
	max,
	disabled,
	atMax,
	onChange,
}: {
	value: number;
	max: number;
	disabled?: boolean;
	atMax?: boolean;
	onChange: (value: number) => void;
}) {
	const { t } = useI18n();
	const ratio = max === 0 ? 0 : value / max;
	const litColumns = Math.round(ratio * COLUMNS);

	return (
		<div className={`relative h-[24px] ${disabled ? "opacity-40" : ""}`}>
			<div className="absolute inset-0 flex items-center gap-px overflow-hidden rounded-md bg-card px-[6px]">
				{Array.from({ length: COLUMNS }, (_, column) => {
					const lit = column < litColumns;
					// 亮着的那一段右端最亮。
					const intensity = 0.32 + (column / (COLUMNS - 1)) * 0.68;
					return (
						<div key={column} className="flex flex-1 flex-col items-center gap-[3px]">
							{Array.from({ length: ROWS }, (_, row) => (
								<span
									key={row}
									className={`h-[3px] w-[3px] rounded-none transition-[background-color,opacity] ${lit && atMax ? "plume-thrust" : ""}`}
									style={{
										background: lit ? (atMax ? "var(--plume-violet)" : "var(--plume-accent)") : "var(--plume-ink-faint)",
										opacity: lit ? intensity : 0.3,
										transitionDuration: "var(--plume-t-base)",
										transitionTimingFunction: "var(--plume-e-out)",
										// 按离滑块的远近错开，脉冲从滑块开始往回跑；从左往右跑读起来是进度条在填满，正好相反。
										animationDelay: lit && atMax ? `${(COLUMNS - 1 - column) * 34 + row * 60}ms` : undefined,
										["--plume-matrix-low" as string]: lit ? String(intensity) : undefined,
									}}
								/>
							))}
						</div>
					);
				})}
			</div>

			{/* 滑块落在亮与不亮的分界上。 */}
			<div
				className="plume-knob pointer-events-none absolute top-1/2 h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 rounded-sm border"
				style={{ left: `calc(8px + ${ratio} * (100% - 16px))`, transition: "left var(--plume-t-base) var(--plume-e-out)" }}
			/>

			<input
				type="range"
				min={0}
				max={max}
				step={1}
				value={value}
				disabled={disabled}
				aria-label={t("effort.title")}
				onChange={(event) => onChange(Number(event.target.value))}
				className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed"
			/>
		</div>
	);
}
