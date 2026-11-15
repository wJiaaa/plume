import type { HTMLAttributes, ReactNode, Ref } from "react";

/**
 * 页面每一栏最上面那一行（两栏页面的栏头）：和窗口顶上那一条一样高，在正文卡片里、宿主的标题栏下面。
 * 只是一行栏头，不拖窗口：拖窗口、双击缩放归卡片外面宿主的标题栏，页面里这一行放按钮、标签都不用标 no-drag。
 * 高度取宿主在页面外层给的 `--plume-top-row-height`；高度、左右内边距之外的排法（间距、两端对齐）由 `className` 补；
 * 行里不折行，放不下的东西自己截断。
 */
export function PageTopRow({
	className = "",
	children,
	...rest
}: { className?: string; children?: ReactNode; ref?: Ref<HTMLElement> } & HTMLAttributes<HTMLElement>) {
	return (
		<header {...rest} className={`flex h-[var(--plume-top-row-height,44px)] min-w-0 shrink-0 flex-nowrap items-center gap-2 px-3 ${className}`.trim()}>
			{children}
		</header>
	);
}
