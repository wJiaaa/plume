/**
 * 侧栏导航的一行：新对话和各个去处共用，去处再标出「现在就在这里」。
 *
 * 新对话是开一段对话、不是去一个地方，没有在不在的状态，所以 active 给 undefined 而不是 false：不是不在，是不适用。
 * 抽屉里的行靠手指点，不是靠肌肉记忆，所以 compact 下行更高。
 */

import type { MouseEvent, ReactNode } from "react";

export function NavItem({
	icon,
	label,
	onClick,
	active,
	badge,
	badgeLabel,
	compact,
	nav,
}: {
	icon: ReactNode;
	label: string;
	onClick: () => void;
	active?: boolean;
	/** 右端的数目：有东西在等你。0 不画。 */
	badge?: number;
	/** 数目是什么意思，给读屏和提示用。 */
	badgeLabel?: string;
	compact: boolean;
	/** 冒烟测试按 data-nav 找这一行。 */
	nav?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			data-nav={nav}
			className={`flex w-full items-center gap-2 rounded-lg px-2.5 text-left text-ink transition-colors active:bg-elevated ${active ? "bg-card-hover" : "hover:bg-card-hover"} ${
				compact ? "h-[40px] text-body" : "h-[32px] text-label"
			}`}
		>
			<span className="shrink-0">{icon}</span>
			{label}
			{badge ? (
				<span
					data-plume-tip={badgeLabel}
					aria-label={badgeLabel}
					className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent/15 px-1.5 text-caption font-medium text-accent tabular-nums"
				>
					{badge}
				</span>
			) : null}
		</button>
	);
}

/**
 * 活动栏里的一格：只有图标，名字在右边的悬停提示里。在哪一页底色深一档、字是满色，别的淡着。
 * 右上角的数目和侧栏那一行的一样，是有东西在等你；人就在这一页时调用方不传。
 */
export function RailItem({
	icon,
	label,
	onClick,
	active,
	badge,
	badgeLabel,
	expanded,
	nav,
	children,
}: {
	icon: ReactNode;
	label: string;
	onClick: (event: MouseEvent<HTMLButtonElement>) => void;
	active?: boolean;
	badge?: number;
	badgeLabel?: string;
	/** 点了弹出一层（通知、搜索）时，那一层开没开。 */
	expanded?: boolean;
	/** 冒烟测试按 data-nav 找这一格。 */
	nav?: string;
	/** 角上别的标记（通知的圆点）。 */
	children?: ReactNode;
}) {
	const tip = badge && badgeLabel ? `${label} · ${badgeLabel}` : label;
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			aria-expanded={expanded}
			aria-label={tip}
			data-nav={nav}
			data-plume-tip={tip}
			data-plume-tip-side="right"
			className={`relative flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
				active || expanded ? "bg-card-hover text-ink" : "text-ink-muted hover:bg-card-hover hover:text-ink"
			}`}
		>
			{icon}
			{badge ? (
				<span className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-badge font-medium text-on-accent tabular-nums">
					{badge > 99 ? "99+" : badge}
				</span>
			) : null}
			{children}
		</button>
	);
}
