/**
 * 挑数字、挑时间的控件。
 *
 * 它们各自替掉一个由平台来画的 `<input>`：数字框的上下箭头、时间框的时钟。样式够不着这些部件，于是它们会以系统挑的
 * 形状和颜色，出现在一排自己画的控件旁边。所以留下原生元素的行为和无障碍，看得见的部分自己画。
 */

import { type JSX, useRef, useState } from "react";
import { translate } from "../i18n/translate.ts";
import { Minus, Plus } from "../icons/index.ts";
import { commitDraft, decimalsOf, formatNumber, isLegalDraft, stepNumber } from "../lib/number-draft.ts";
import { Input } from "./NativeField.tsx";
import { InlineSelect } from "./Select.tsx";

/**
 * 带自己画的步进按钮的数字框。
 *
 * 用 `type="text"` 加数字键盘提示，不用 `type="number"`：后者的上下箭头每个浏览器画得都不一样，而且它认为不合法的
 * 输入一律报成空字符串，`1e5`、`--3` 看着像收下了，到手却是「什么也没敲」。
 *
 * 存的值不是每敲一下就改：聚焦时框里留一份草稿，下限是 11 时「1」才能留到变成「16」。永远到不了范围内的字符进不来，
 * 加减按钮停在同样的边界上。拒掉的按键不提示。
 */
export function NumberField({
	value,
	onChange,
	min = Number.NEGATIVE_INFINITY,
	max = Number.POSITIVE_INFINITY,
	step = 1,
	width = 76,
	label,
	name,
}: {
	value: number;
	onChange: (value: number) => void;
	min?: number;
	max?: number;
	step?: number;
	width?: number;
	label: string;
	name?: string;
}): JSX.Element {
	const bounds = { min, max, step };
	const decimals = decimalsOf(step);
	const [draft, setDraft] = useState<string | null>(null);
	const shown = draft ?? formatNumber(value, decimals);
	const effective = draft === null ? value : (commitDraft(draft, bounds) ?? value);

	const applyText = (text: string, input: HTMLInputElement) => {
		if (!isLegalDraft(text, bounds)) {
			input.value = shown;
			return;
		}
		setDraft(text);
		const parsed = Number(text);
		if (text === "" || text === "-" || text.endsWith(".") || !Number.isFinite(parsed)) return;
		if (parsed < min || parsed > max) return;
		const next = commitDraft(text, bounds);
		if (next !== null && next !== value) onChange(next);
	};

	const finish = (text: string) => {
		const next = commitDraft(text, bounds);
		setDraft(null);
		if (next !== null && next !== value) onChange(next);
	};

	const nudge = (delta: number) => {
		const base = commitDraft(draft ?? formatNumber(value, decimals), bounds) ?? value;
		setDraft(null);
		onChange(stepNumber(base, delta, bounds));
	};

	return (
		<div data-plume-number={name ?? ""} className="plume-field plume-number-field pr-1" style={{ width }}>
			<Input
				type="text"
				inputMode={decimals > 0 || min < 0 ? "decimal" : "numeric"}
				value={shown}
				aria-label={label}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => applyText(event.target.value, event.currentTarget)}
				onFocus={() => setDraft(formatNumber(value, decimals))}
				onBlur={() => {
					if (draft !== null) finish(draft);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						if (draft !== null) finish(draft);
						event.currentTarget.blur();
						return;
					}
					if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
					event.preventDefault();
					nudge(event.key === "ArrowUp" ? step : -step);
				}}
				className="w-full min-w-0 bg-transparent px-1.5 text-center font-mono text-label text-ink"
			/>
			<div className="flex shrink-0 flex-col pr-[3px]">
				<Stepper label={translate("picker.increase", { label })} disabled={effective >= max} onClick={() => nudge(step)}>
					<Plus size={10} strokeWidth={2.4} />
				</Stepper>
				<Stepper label={translate("picker.decrease", { label })} disabled={effective <= min} onClick={() => nudge(-step)}>
					<Minus size={10} strokeWidth={2.4} />
				</Stepper>
			</div>
		</div>
	);
}

function Stepper({ children, label, disabled, onClick }: { children: JSX.Element; label: string; disabled: boolean; onClick: () => void }): JSX.Element {
	return (
		<button
			type="button"
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className="flex h-[11px] w-[16px] items-center justify-center rounded-xs text-ink-faint transition-colors hover:bg-card-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
		>
			{children}
		</button>
	);
}

const HOURS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour).padStart(2, "0"), label: String(hour).padStart(2, "0") }));
const MINUTES = Array.from({ length: 60 }, (_, minute) => ({ value: String(minute).padStart(2, "0"), label: String(minute).padStart(2, "0") }));

/**
 * 时间，用两个列表挑，不用浏览器的时钟。
 *
 * `<input type="time">` 的分段、分隔符和弹出的面板都归平台：macOS 上是步进器，Windows 上是下拉。它还按系统区域解析和
 * 显示，同一个任务在一台机器上读作 `09:00`，在另一台上读作 `9:00 AM`，存的却是同一串字。
 *
 * 两个列表把这些都去掉，顺便去掉了打字：要的只是某个小时的某一分，00:00–23:59 之外没有别的值要表达。
 */
export function TimeField({
	value,
	onChange,
	label,
}: {
	/** `HH:mm`，24 小时制。 */
	value: string;
	onChange: (value: string) => void;
	label: string;
}): JSX.Element {
	// 存的值坏了或是空的，显示成 00:00，不显示一个空控件。
	const [hour = "00", minute = "00"] = /^\d{2}:\d{2}$/.test(value) ? value.split(":") : ["00", "00"];
	const last = useRef({ hour, minute });
	last.current = { hour, minute };

	return (
		<div className="flex items-center gap-1">
			<InlineSelect
				value={hour}
				options={HOURS}
				onChange={(next) => onChange(`${next}:${last.current.minute}`)}
				ariaLabel={translate("picker.hours", { label })}
			/>
			<span className="text-label text-ink-faint">:</span>
			<InlineSelect
				value={minute}
				options={MINUTES}
				onChange={(next) => onChange(`${last.current.hour}:${next}`)}
				ariaLabel={translate("picker.minutes", { label })}
			/>
		</div>
	);
}
