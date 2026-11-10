/**
 * 一条横着滚的标签栏。
 *
 * 普通滚轮直接横着走，触摸板两指一划照旧——见 `useSideways` 的 `plainWheel`。标签栏都长在头部或
 * 底边，上面没有要竖着滚的东西，把滚轮让出去也没人接。
 *
 * 这里从前两头各浮一枚方向键，那是给「只有鼠标、又不知道 Shift + 滚轮」的人准备的；滚轮能直接
 * 横滚之后它们只剩下压住两端标签的那一块，于是拿掉了。附件条躺在可滚动的转录区里，滚轮得留给
 * 上层，它还用着 `SidewaysArrow`。
 */

import { ChevronLeft, ChevronRight } from "../icons/index.ts";
import { useRef } from "react";
import { translate } from "../i18n/translate.ts";
import { useSideways } from "./useSideways.ts";

/** 一次点按走多远：留两成重叠，让眼睛接得上。 */
const STEP = 0.8;

export function Sideways({
	children,
	className = "",
	trackRef,
	...rest
}: {
	children: React.ReactNode;
	/** 给会滚的那一层，`overflow-x-auto` 和「我在父级里占多大」的类都写在这里。 */
	className?: string;
	/** 需要自己够到滚动容器的地方传进来——比如「把选中的标签滚进视野」。 */
	trackRef?: React.RefObject<HTMLDivElement | null>;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "children">) {
	const own = useRef<HTMLDivElement>(null);
	const track = trackRef ?? own;
	useSideways(track, { plainWheel: true });
	return (
		<div ref={track} className={`plume-fade-tail min-w-0 ${className}`} {...rest}>
			{children}
		</div>
	);
}

/**
 * 附件条两头的方向键：那里滚轮要留给转录区，只有鼠标的人得靠它们。
 *
 * - **不占地方。** 绝对定位浮在两端、压在渐隐上，不进 flex 流——占位置的话，刚好排得下的一条会
 *   因为多了两个按钮而排不下。定位壳由附件条自己提供。
 * - **到头就没有。** 和渐隐读同一个「这边还有没有」，永远同进同出；`disabled` 的灰按钮不说明任何事。
 * - **一次滚八成。** 整屏翻页会把刚看到的那个也带走，留一点重叠，眼睛才接得上。
 */
export function SidewaysArrow({ side, shown, track }: { side: "left" | "right"; shown: boolean; track: React.RefObject<HTMLElement | null> }) {
	const left = side === "left";
	return (
		<button
			type="button"
			aria-label={translate(left ? "sideways.left" : "sideways.right")}
			data-plume-tip={translate(left ? "sideways.left" : "sideways.right")}
			// 到头之后不接受按下，也不接受 Tab 停留——它此刻不是一个控件。
			tabIndex={shown ? 0 : -1}
			aria-hidden={!shown}
			onClick={() => {
				const el = track.current;
				if (!el) return;
				el.scrollBy({ left: (side === "left" ? -1 : 1) * el.clientWidth * STEP, behavior: "smooth" });
			}}
			/*
			 * `pointer-events` 跟着可见性走。
			 *
			 * 淡出只是看不见，不按住这一条的话，那块透明的圆仍然接着点击——一条滚到头的标签栏，最
			 * 边上那个标签会变得点不中，而屏幕上根本没有东西挡在那里。
			 */
			className={`absolute inset-y-0 my-auto grid h-[22px] w-[22px] place-items-center rounded-full border border-line-soft bg-card/85 text-ink-muted shadow-sm backdrop-blur-sm transition-[opacity,transform,background-color] duration-[var(--plume-t-quick)] hover:bg-card-hover hover:text-ink ${
				left ? "left-0.5" : "right-0.5"
			} ${shown ? "scale-100 opacity-100" : `pointer-events-none opacity-0 ${left ? "-translate-x-1" : "translate-x-1"} scale-90`}`}
		>
			{left ? <ChevronLeft size={14} strokeWidth={2.1} /> : <ChevronRight size={14} strokeWidth={2.1} />}
		</button>
	);
}
