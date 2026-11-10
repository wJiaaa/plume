/**
 * 侧栏导航的一行：新对话和各个去处共用，去处再标出「现在就在这里」。
 *
 * 新对话是开一段对话、不是去一个地方，没有在不在的状态，所以 active 给 undefined 而不是 false：不是不在，是不适用。
 * 抽屉里的行靠手指点，不是靠肌肉记忆，所以 compact 下行更高。
 */

import type { ReactNode } from "react";

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
