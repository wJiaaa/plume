/**
 * 工具组标题、工具行上那句话换掉时：原地交叉淡入淡出，不滚动。宽度从旧句缓到新句，后面的箭头跟着滑过去，不在换的那一帧跳。
 *
 * 新旧两句叠在同一格里（`inline-grid`），新的淡入、旧的淡出，旧的淡完才拿掉。框宽在换的那一下钉成像素：量出旧句和新句各自
 * 的宽，钉回旧宽、再设新宽，过渡走完放回 auto——一直钉着的话，字体晚到、改了字号之后框还是旧宽。框是 `overflow: hidden`：
 * 变窄时还在淡出的长句从右边被裁掉，不压到箭头上。
 *
 * 同一句往后长（参数流进来）不淡，宽度照样缓：参数常常是整段一起到的，「正在浏览 ./」一帧里长成一整条路径，箭头一下被
 * 顶出去两三百像素。还在缓时又变了，从此刻画着的宽度接着缓（和 `RollWords` 一样）。宽度按小数量（`getBoundingClientRect`），
 * 不按取整的 `offsetWidth`：钉住的宽比字窄零点几像素时，缓的那一段句尾一直是省略号，放回 auto 才变回字。
 *
 * 只在字变了时量（比 `textContent`，不读排版）。挂上时只有跑着的（`glide`）记一次宽度：转录里几百行不在跑的挂上时都量的话，
 * 就是几百次强制排版；它们的字也很少再变，变了也不缓。
 *
 * 扫光（`glide`）挂在每一层自己的字上，按拍子走（`useTickedAnimations`），和别的运行中的行一样省。换句时扫光不从头来：
 * 旧的那一层留着原来的元素淡出（按 key 认，只换类名），扫光照走；新的那一层接着旧的走到的地方扫，中间隔着没有扫光的几句
 * （上一次调用跑完了、下一次还没开跑）时按过去的时间接着推。从头扫的话亮带每换一句跳回原处，新旧两层的亮带还一前一后。
 */

import { GLIDE, motionReduced, useTickedAnimations } from "@plume/ui";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";

interface Layer {
	key: string;
	node: ReactNode;
	glide: boolean;
}

export function SwapText({ swapKey, glide = false, children }: { swapKey: string; glide?: boolean; children: ReactNode }) {
	const box = useRef<HTMLSpanElement>(null);
	// 上一次画出来的那一层：换句时它就是要淡出去的那句。
	const last = useRef<Layer>({ key: swapKey, node: children, glide });
	const [shown, setShown] = useState(swapKey);
	const [leaving, setLeaving] = useState<Layer[]>([]);
	// 换进来的那一句才淡入；挂上时的第一句原样出现。
	const [entered, setEntered] = useState<string | null>(null);
	// 最近一次换句时淡出去的那一层：同一层不量第二遍。
	const swapped = useRef<Layer | null>(null);
	// 画着的那一句的字，和上一次量到的宽（字宽，缓的途中是缓向的宽）：字变了才量，没量过的不缓。
	const said = useRef<string | null>(null);
	const width = useRef<number | null>(null);
	// 扫光上一次走到哪、那是什么时候。
	const phase = useRef<{ time: number; at: number } | null>(null);
	useTickedAnimations(box, GLIDE, glide || leaving.some((layer) => layer.glide));

	/*
	 * 换句在渲染时就办，旧句和新句同一次提交画上：旧的那一层还是原来那个元素，扫光不断。放到副作用里加的话，它先被卸掉、
	 * 再作为淡出层重新挂上，扫光从头扫。
	 */
	if (shown !== swapKey) {
		setShown(swapKey);
		if (!motionReduced()) {
			// 上一次提交画出来的那一层：`last` 在提交后才改，换句的这次渲染里还是它。
			const before = last.current;
			setLeaving((list) => [...list.filter((layer) => layer.key !== before.key && layer.key !== swapKey), before]);
			setEntered(swapKey);
		}
	}

	useLayoutEffect(() => {
		last.current = { key: swapKey, node: children, glide };
	});

	// 换句的那次提交：这时两句都在格子里，各自按字宽（`justify-items: start`）。
	useLayoutEffect(() => {
		const element = box.current;
		const outgoing = leaving[leaving.length - 1];
		if (!element || !outgoing || swapped.current === outgoing) return;
		swapped.current = outgoing;
		const old = element.children[leaving.length - 1];
		const current = element.lastElementChild;
		if (!(old instanceof HTMLElement) || !(current instanceof HTMLElement)) return;
		continueGlide(old, current, phase);
		said.current = current.textContent;
		width.current = easeWidth(element, current, old.getBoundingClientRect().width);
	}, [leaving]);

	// 同一句的字变了（参数流进来、句尾多了「失败」「+3 −1」）：从原来的宽缓过去。挂上时只记下跑着的那一句有多宽。
	useLayoutEffect(() => {
		const element = box.current;
		const current = element?.lastElementChild;
		if (!element || !(current instanceof HTMLElement) || current.textContent === said.current) return;
		const mounted = said.current === null;
		said.current = current.textContent;
		if (mounted) {
			if (glide) width.current = element.getBoundingClientRect().width;
			return;
		}
		if (width.current !== null && !motionReduced()) width.current = easeWidth(element, current, width.current);
	});

	return (
		<span
			ref={box}
			className="tool-swap"
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && event.propertyName === "width") event.currentTarget.style.width = "";
			}}
		>
			{/*
			 * 淡出的几层和画着的那一层放在同一个数组里、按句子认 key：换句时画着的那一层原地变成淡出层，不卸掉重挂。
			 * 分成数组加一个单独的元素的话，key 不在同一处比，它照样被卸掉、重新挂成淡出层。
			 * 淡入淡出和扫光各在一层：同一个元素上两个 `animation` 会互相盖掉。
			 */}
			{[...leaving, { key: swapKey, node: children, glide }].map((layer) =>
				leaving.includes(layer) ? (
					<span
						key={layer.key}
						aria-hidden
						className="tool-swap-out"
						onAnimationEnd={(event) => {
							if (event.target === event.currentTarget) setLeaving((list) => list.filter((one) => one !== layer));
						}}
					>
						<span className={layer.glide ? "plume-glide" : undefined}>{layer.node}</span>
					</span>
				) : (
					<span
						key={layer.key}
						className={entered === swapKey ? "tool-swap-in" : undefined}
						// 淡完摘掉：藏起来的页面再显出来时动画会重演一遍。
						onAnimationEnd={(event) => {
							if (event.target === event.currentTarget) setEntered(null);
						}}
					>
						<span className={glide ? "plume-glide" : undefined}>{children}</span>
					</span>
				),
			)}
		</span>
	);
}

/** 框宽缓到 `layer` 的字宽，返回缓向的宽。还在缓时从此刻画着的宽度接着走，不然从 `from`（原来那句的宽）起步。 */
function easeWidth(element: HTMLElement, layer: HTMLElement, from: number): number {
	const moving = element.style.width !== "";
	const start = moving ? element.getBoundingClientRect().width : from;
	if (moving) element.style.width = "";
	const to = layer.getBoundingClientRect().width;
	if (Math.abs(start - to) < 0.5) return to;
	element.style.width = `${start}px`;
	void element.offsetWidth;
	element.style.width = `${to}px`;
	return to;
}

/**
 * 新句的扫光接着旧句走到的地方扫；旧句没有扫光时，从上一次记下的地方按过去的时间往后推。接上以后当场停住交给拍子
 * （`useTickedAnimations` 见到停着的就从它的 `currentTime` 接着拨）：不然下一拍之前它先由浏览器逐帧推几帧，再改成按拍走。
 */
function continueGlide(old: HTMLElement, current: HTMLElement, phase: RefObject<{ time: number; at: number } | null>): void {
	const before = glideOf(old);
	if (before) phase.current = { time: Number(before.currentTime ?? 0), at: performance.now() };
	const after = glideOf(current);
	if (!after || motionReduced()) return;
	if (phase.current) after.currentTime = phase.current.time + performance.now() - phase.current.at;
	after.pause();
}

function glideOf(layer: HTMLElement): Animation | undefined {
	const text = layer.firstElementChild;
	if (!text || typeof text.getAnimations !== "function") return undefined;
	// 按属性认而不是 `instanceof`：测试用的 DOM 里没有 `CSSAnimation` 这个类。
	return text.getAnimations().find((animation) => "animationName" in animation && GLIDE.has((animation as CSSAnimation).animationName));
}
