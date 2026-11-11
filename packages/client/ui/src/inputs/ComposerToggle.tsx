/**
 * 输入框工具栏里一个有开、关两态的模式开关（工作树、计划模式）。
 *
 * 关着时是一颗淡色图标，常驻，免得这一排因为一个模式时有时无地跳宽度；开着时才带字、换成强调色——它改变的是
 * 下一轮能做什么，开着却看不出来，人会奇怪 agent 为什么不照常做事。
 *
 * 开和关是同一颗按钮、同一个左内边距：左右 6px 让关着时正好是控件边长的方块，一点图标不横跳，颜色也能过渡。
 */

import type { ReactNode } from "react";

export function ComposerToggle({
	on,
	onChange,
	icon,
	label,
	tip,
	size = "composer",
	iconOnly = false,
	...data
}: {
	on: boolean;
	onChange: (on: boolean) => void;
	/** 16px 的图标，颜色跟着文字走。 */
	icon: ReactNode;
	/** 开着时图标旁边的字。 */
	label: string;
	/** 悬停提示和无障碍名：说点了会怎样。 */
	tip: string;
	/** `sm` 放在 `Button size="sm"` 旁边：26px；主输入框的控件跟着 `--plume-composer-control`。 */
	size?: "composer" | "sm";
	/**
	 * 开着时也只有图标，开没开只看颜色，名字和点了会怎样都在悬停提示里。给卡片上挨着一颗「开始」的开关：那里开着时带上的字
	 * 读起来像又一颗要按的按钮。主输入框里不用它，那一排的字说的是下一轮在什么模式里。
	 */
	iconOnly?: boolean;
} & { [key: `data-${string}`]: string | undefined }) {
	return (
		<button
			type="button"
			{...data}
			aria-pressed={on}
			aria-label={tip}
			data-plume-tip={tip}
			data-plume-tip-side="top"
			onClick={() => onChange(!on)}
			className={`${size === "sm" ? "h-[26px] min-w-[26px]" : "plume-composer-control min-w-[var(--plume-composer-control)]"} flex shrink-0 items-center gap-1 rounded-lg px-[6px] text-label transition-colors duration-[var(--plume-t-quick)] ${
				on ? "bg-accent-dim text-accent hover:bg-accent/15" : "text-ink-faint hover:bg-card-hover hover:text-ink active:bg-elevated"
			}`}
		>
			<span className="flex shrink-0" aria-hidden>
				{icon}
			</span>
			{/* 和权限签的字一起让位：图标是强调色、悬停有提示，字是这一排最便宜的东西（输入框底下那一排按 `data-plume-fit-drop` 让）。 */}
			{on && !iconOnly && (
				<span data-plume-fit-drop="1" className="whitespace-nowrap pr-0.5">
					{label}
				</span>
			)}
		</button>
	);
}
