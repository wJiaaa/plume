import { iconButton } from "@plume/styles";
import { Tooltip } from "../overlay/Tooltip.tsx";
import { shortcutLabel } from "../keyboard.ts";
import type { DataAttributes } from "./Button.tsx";

/**
 * 标签是一个图标的按钮。
 *
 * 各个工具栏各写各的，会长出五种高度、三种圆角，按下的反馈从没有到缩小 10% 都有。缩小是有意去掉的——
 * 一个在接触那一刻从指针底下跳开的控件读起来不稳，在这么小的尺寸上那是一下晃动而不是按下。按下用底色
 * 深一档表示，真的按钮就是这样：它待在原地，只是换了状态。
 *
 * 标签同时是悬停提示和无障碍名，调用方没法只给一个——只有图标的工具栏就是这样变得读屏读不出来的。
 * 类名组合在 `@plume/styles` 的 `iconButton`。
 */
export function IconButton({
	label,
	ariaLabel,
	icon,
	onClick,
	active,
	disabled,
	emphasis,
	badge,
	explainDisabled,
	tone = "default",
	size = "md",
	tipSide = "bottom",
	menu,
	expanded,
	className = "",
	...data
}: DataAttributes & {
	label: string;
	/**
	 * 无障碍名要比悬停提示多说一点时用。
	 *
	 * 一列同样的按钮在读屏里是同一个词念了一遍又一遍；无障碍名带上是哪一行（`归档会话「a」`），
	 * 悬停提示仍然短，因为指针已经在那一行上了。不传时 `label` 两样都是，这是通常的情况。
	 */
	ariaLabel?: string;
	icon: React.ReactNode;
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
	/** 按住 / 开着，给「区分大小写」这类开关。 */
	active?: boolean;
	disabled?: boolean;
	/**
	 * 一排里现在值得按的那一个。
	 *
	 * 满色的字，对比一排平时淡灰的字，这是界面里已经用来表示「就是这个」的对比。不是实心或彩色按钮：
	 * 长出 primary 按钮的工具栏就不再是工具栏了。
	 */
	emphasis?: boolean;
	/** 角上的计数。零和 null 都画成什么都没有。 */
	badge?: number | null;
	/**
	 * 禁用时也显示悬停提示，因为标签说明的正是为什么禁用。
	 *
	 * 默认关，对大多数工具栏默认是对的：一个因为显而易见的原因变灰的控件，再冒一个泡重复它的名字
	 * 没有意义。原因本身才是重点的地方就不对了——「当前分支没有上游」正是悬停在一个按不动的拉取按钮上
	 * 的人想知道的，没有这个他们只能得到一片沉默，自己去猜。
	 */
	explainDisabled?: boolean;
	tone?: "default" | "danger";
	/**
	 * `xs` 20px，是窗格标题行和一行小字的高度；圆角跟着降到 6px，这个尺寸的按钮都这样。`composer`
	 * 跟着主输入框自己的控件高度走，那个高度变了，它那一排仍然是一行。
	 */
	size?: "xs" | "sm" | "md" | "composer";
	tipSide?: "top" | "bottom";
	/** 会打开一个菜单；值是它现在开没开。和 `Button` 的一样。 */
	menu?: boolean;
	/** 原地展开或收起一段。和 `Button` 的一样。 */
	expanded?: boolean;
	className?: string;
}) {
	const showBadge = typeof badge === "number" && badge > 0;
	const button = (
		<button
			{...data}
			type="button"
			aria-label={ariaLabel ?? shortcutLabel(label)}
			aria-pressed={active}
			aria-haspopup={menu === undefined ? undefined : "menu"}
			aria-expanded={menu ?? expanded}
			disabled={disabled}
			onClick={onClick}
			// 计数，不用知道它怎么画也读得到——这里是角上的角标，换个地方可能是一个词的一部分。
			data-plume-count={showBadge ? String(badge) : undefined}
			className={`${iconButton.base} ${iconButton.size[size]} ${
				tone === "danger" ? iconButton.tone.danger : active ? iconButton.active : emphasis ? iconButton.emphasis : iconButton.tone.default
			} ${className}`}
		>
			{icon}
			{showBadge && (
				/*
				 * 放在图标外面而不是旁边，所以冒出一个数不会挪动这一排。`tabular-nums` 是同一个理由：
				 * 1 变成 2 不能改变宽度。
				 */
				<span className="pointer-events-none absolute -top-0.5 -right-1 font-mono text-badge leading-none tabular-nums text-ink">{badge}</span>
			)}
		</button>
	);

	// 禁用的控件悬停时什么都解释不了，它的提示也永远不会因为点击而消失——除非禁用的原因正是值得说的。
	// 见 `explainDisabled`。
	return disabled && !explainDisabled ? (
		button
	) : (
		<Tooltip label={label} side={tipSide}>
			{button}
		</Tooltip>
	);
}
