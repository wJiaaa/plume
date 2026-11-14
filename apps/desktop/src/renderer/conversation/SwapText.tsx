/**
 * 工具组标题、工具行上那句话换掉时：原地交叉淡入淡出，不滚动。宽度从旧句缓到新句，后面的箭头跟着滑过去，不在换的那一帧跳。
 *
 * 新旧两句叠在同一格里（`inline-grid`），新的淡入、旧的淡出，旧的淡完才拿掉。框宽在换的那一下钉成像素：量出旧句和新句各自
 * 的宽，钉回旧宽、再设新宽，过渡走完放回 auto——一直钉着的话，字体晚到、改了字号之后框还是旧宽。框是 `overflow: hidden`：
 * 变窄时还在淡出的长句从右边被裁掉，不压到箭头上。
 *
 * 只在换句时量：转录里每一行挂上时都走一遍的话，几百行就是几百次强制排版。同一句往后长（参数还在流进来）不淡、不缓，
 * 字长出来，箭头跟着字走。
 *
 * 扫光（`glide`）挂在每一层自己的字上，按拍子走（`useTickedAnimations`），和别的运行中的行一样省。
 */

import { GLIDE, motionReduced, useTickedAnimations } from "@plume/ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

interface Layer {
	key: string;
	node: ReactNode;
	glide: boolean;
}

export function SwapText({ swapKey, glide = false, children }: { swapKey: string; glide?: boolean; children: ReactNode }) {
	const box = useRef<HTMLSpanElement>(null);
	// 上一次画出来的那一层：换句时它就是要淡出去的那句。
	const last = useRef<Layer>({ key: swapKey, node: children, glide });
	const [leaving, setLeaving] = useState<Layer[]>([]);
	// 换进来的那一句才淡入；挂上时的第一句原样出现。
	const [entered, setEntered] = useState<string | null>(null);
	// 最近一次钉过宽度的那一层：同一层不量第二遍。
	const pinned = useRef<Layer | null>(null);
	useTickedAnimations(box, GLIDE, glide || leaving.some((layer) => layer.glide));

	// 先于下面那个副作用：这时 `last` 还是换之前的那一层。布局副作用里设状态，重画在这一帧画出来之前，旧句不会消失一帧。
	useLayoutEffect(() => {
		const before = last.current;
		if (before.key === swapKey || motionReduced()) return;
		setLeaving((list) => [...list.filter((layer) => layer.key !== before.key && layer.key !== swapKey), before]);
		setEntered(swapKey);
	}, [swapKey]);

	useLayoutEffect(() => {
		last.current = { key: swapKey, node: children, glide };
	});

	// 旧句作为淡出层画上之后再量：这时两句都在格子里，各自按字宽（`justify-items: start`）。
	useLayoutEffect(() => {
		const element = box.current;
		const outgoing = leaving[leaving.length - 1];
		if (!element || !outgoing || pinned.current === outgoing) return;
		pinned.current = outgoing;
		const old = element.children[leaving.length - 1] as HTMLElement | undefined;
		const current = element.lastElementChild as HTMLElement | null;
		if (!old || !current) return;
		// 上一次还没缓完就又换了：从此刻画着的宽度接着走，不跳回上一个终点。
		const moving = element.style.width !== "";
		const from = moving ? element.getBoundingClientRect().width : old.offsetWidth;
		if (moving) element.style.width = "";
		const to = current.offsetWidth;
		if (Math.abs(from - to) < 0.5) return;
		element.style.width = `${from}px`;
		void element.offsetWidth;
		element.style.width = `${to}px`;
	}, [leaving]);

	return (
		<span
			ref={box}
			className="tool-swap"
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && event.propertyName === "width") event.currentTarget.style.width = "";
			}}
		>
			{leaving.map((layer) => (
				<span
					key={`out-${layer.key}`}
					aria-hidden
					className="tool-swap-out"
					onAnimationEnd={(event) => {
						if (event.target === event.currentTarget) setLeaving((list) => list.filter((one) => one !== layer));
					}}
				>
					<span className={layer.glide ? "plume-glide" : undefined}>{layer.node}</span>
				</span>
			))}
			{/* 淡入淡出和扫光各在一层：同一个元素上两个 `animation` 会互相盖掉。 */}
			<span
				key={`in-${swapKey}`}
				className={entered === swapKey ? "tool-swap-in" : undefined}
				// 淡完摘掉：藏起来的页面再显出来时动画会重演一遍。
				onAnimationEnd={(event) => {
					if (event.target === event.currentTarget) setEntered(null);
				}}
			>
				<span className={glide ? "plume-glide" : undefined}>{children}</span>
			</span>
		</span>
	);
}
