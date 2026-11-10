/**
 * 一个会转的方向箭头，专给「按下去会展开点什么」的按钮用。
 *
 * 每处各写一遍 `<ChevronDown className={open ? "rotate-180" : ""} />` 的话，有的加了过渡有的没加，
 * 加了的时长也各不相同。结果是同一个手势在不同的角落表现不同——一处的箭头滑过去，另一处「啪」地
 * 跳过去，而这两下是同一件事：一张单子打开了。
 *
 * 转多少度由 `from` 决定，因为收起时的朝向不止一种：下拉菜单的箭头向下、展开到 180 度朝上；
 * 树和折叠块的箭头向右、展开到 90 度朝下。两种都在这里，调用方只说自己是哪一种。
 *
 * 只画箭头，不画按钮。它是按钮里的一个字形，而不是一个控件——`aria-hidden`，名字归按钮自己的
 * `aria-label` 管。
 */

import { ChevronDown, ChevronRight } from "../icons/index.ts";

export function Caret({
	open,
	/** 收起时箭头朝哪儿：`down` 展开到朝上（下拉），`right` 展开到朝下（树、折叠块）。 */
	from = "down",
	size = 12,
	strokeWidth = 2,
	className = "",
	/** 代码预览那种自带配色的表面上，颜色是算出来的而不是 token。 */
	style,
}: {
	open: boolean;
	from?: "down" | "right";
	size?: number;
	strokeWidth?: number;
	className?: string;
	style?: React.CSSProperties;
}) {
	const Glyph = from === "right" ? ChevronRight : ChevronDown;
	const turned = open ? (from === "right" ? "rotate-90" : "rotate-180") : "";
	return (
		<Glyph
			size={size}
			strokeWidth={strokeWidth}
			aria-hidden
			style={style}
			className={`shrink-0 transition-transform duration-[var(--plume-t-quick)] ease-out ${turned} ${className}`}
		/>
	);
}
