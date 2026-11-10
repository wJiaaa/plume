/**
 * 两个窗格之间能拖的边界：两张卡片之间留出的那道缝。
 *
 * 出现的是**指针处**的一小段握把，不是沿整条边的一道线——和侧栏的拖把同一种做法，理由也一样。整条的线读起来
 * 是边框，布局里永久的一部分，而它要说的是「这一处可以拖」。跟着指针走的握把只说这一件事，边界看起来也不会
 * 因为你碰巧靠近而变样。
 *
 * 抓取区是以缝为中心的九像素带子，指针能稳稳找到的最窄宽度。
 *
 * 报告的是**份额**，不是增量。累加增量会把夹紧误差攒起来——拖过下限再拖回来，边界就少了你拖过头的那一截。
 *
 * 停靠面板和对话分屏用的是同一个：两边的分隔条行为一样，拖动的手感是量出来的，不该有两份。
 */

import { translate } from "../i18n/translate.ts";
import { useEffect, useRef, useState } from "react";
import { freezeMotion } from "../motion/freeze.ts";
import { GRIP_SPAN, SPLITTER_HIT, SPLITTER_STEP, pct, shareFromPointer, type SplitterBox } from "../lib/tiling.ts";

export function Splitter({
	handle,
	containerRef,
	onResize,
	onEven,
	at,
	onDragStart,
}: {
	handle: SplitterBox;
	containerRef: React.RefObject<HTMLElement | null>;
	onResize: (share: number) => void;
	/** 双击：让这条边界两侧的窗格一样大。 */
	onEven: () => void;
	/** 横向位置换成这个，和两边格子同一种写法。 */
	at?: string;
	/** 拖动开始时调用，返回的函数在拖动结束时调用。分屏用它在拖动期间压住布局的落盘。 */
	onDragStart?: () => () => void;
}) {
	const row = handle.dir === "row";
	const [active, setActive] = useState(false);
	/** 当前的分隔条，移动监听不用每帧重建（拖动也不会因此掉）。 */
	const current = useRef(handle);
	current.current = handle;
	/**
	 * 和 `active` 同一件事，能同步读。
	 *
	 * `pointermove` 可能和开始拖动的 `pointerdown` 落在同一个任务里，那时状态还没重渲染——只看 `active` 的
	 * 监听会丢掉开头几次移动，短的拖动就整个丢了。
	 */
	const dragging = useRef(false);
	/**
	 * 回调用 ref 拿着，不列进依赖。
	 *
	 * 它在停靠区每次渲染时都重建，而调大小会让停靠区重渲染——列进依赖的话，拖动的每一帧都要拆掉窗口监听再装回去。
	 * 大多数时候没事，偶尔不行：拖动接了第一次移动就不再响应，因为在拆和装之间到达的 `pointermove` 没人在听。
	 */
	const report = useRef(onResize);
	report.current = onResize;
	/** 和 `report` 同样的理由：只有按下那一刻的值要紧。 */
	const hold = useRef(onDragStart);
	hold.current = onDragStart;
	/**
	 * 握把在缝上的哪个位置，从带子起点算起的像素。
	 *
	 * 指针来之前是 null，没人伸手的边界上什么都不画。存成状态而不是从 CSS 读，因为它还得活过整个拖动：指针一离开
	 * 这条九像素的带子，这个元素就收不到移动了，拖到一半握把消失，你就是在拖一条看不见的边。
	 */
	const [grip, setGrip] = useState<number | null>(null);
	const track = useRef<HTMLDivElement>(null);
	/**
	 * 停靠区的框，按下时量一次，整个拖动复用。
	 *
	 * DOM 被动过之后的第一次 `getBoundingClientRect` 不是一次读：浏览器要同步地把文档重新排一遍才答得出来。在这里
	 * 按下会改 DOM——握把出现、窗格冻住——于是拖动的第一次测量要为背后整份正文的排版买单。在真实会话里量到 61ms，
	 * 而同一次拖动后面每一帧都不到 2ms。
	 *
	 * 拖停靠区自己的边界时停靠区不动，所以每一帧量到的都会是同一个矩形。
	 */
	const dock = useRef<DOMRect | null>(null);
	/** 带子沿缝从哪开始，按下时记下：缝只在横过自己的方向上动。 */
	const along = useRef(0);

	/*
	 * 光标和防选中放在 <body> 上，不放在这个元素上。
	 *
	 * 拖起来以后指针大部分时间在两侧的窗格上，这里的 `cursor` 只在它在这九个像素上时生效——拖动一离开带子，光标就会
	 * 闪回文字光标。和 `ResizeHandle` 同一个道理。
	 */
	useEffect(() => {
		if (!active) return;
		document.body.style.cursor = row ? "col-resize" : "row-resize";
		// 冻住窗格自己的过渡，它们跟着指针走，而不是缓动向每一个中间份额、永远到不了——并拒绝拖过窗格时本来会开始的
		// 文字选择。两样都靠点名元素，而不是正文之上的标记；见 `motion/freeze.ts`。
		const thaw = freezeMotion();
		const release = hold.current?.();
		return () => {
			document.body.style.cursor = "";
			thaw();
			release?.();
		};
	}, [active, row]);

	/*
	 * 拖动监听在 window 上，不在这个元素上。
	 *
	 * 靠指针捕获和 React 自己的 `onPointerMove` 有两个毛病。`setPointerCapture` 对浏览器不认识的指针 id 会抛错——
	 * 合成的事件全是这样，于是整个处理函数还没来得及标记拖动开始就中止了。而且捕获本来也不是这里拖动能成的原因：
	 * 拖动期间指针在两侧的窗格上，那些窗格根本不把事件交给这个元素。
	 */
	useEffect(() => {
		if (!active) return;
		/*
		 * 每帧更新一次——和 `ResizeHandle` 同一个道理。
		 *
		 * 指针事件比屏幕快，这里每一个都要量两个元素、设两次状态。一帧里来好几次就是排版抖动，感觉上是缝本身
		 * 完美地跟着指针，窗格却在抖。
		 */
		let frame = 0;
		let pending: PointerEvent | null = null;

		const apply = () => {
			frame = 0;
			const event = pending;
			pending = null;
			if (!event || !dragging.current) return;

			const container = dock.current ?? containerRef.current?.getBoundingClientRect();
			if (!container) return;
			report.current(shareFromPointer(current.current, row ? event.clientX : event.clientY, container));
			// 整个拖动里握把沿着缝跟着指针，而不是停在按下的地方。
			setGrip((row ? event.clientY : event.clientX) - along.current);
		};

		const onMove = (event: PointerEvent) => {
			if (!dragging.current) return;
			pending = event;
			if (!frame) frame = requestAnimationFrame(apply);
		};
		const stop = (event: PointerEvent) => {
			dragging.current = false;
			dock.current = null;
			setActive(false);
			// 拖动几乎总是在别处结束——这正是拖的意义——所以只有指针碰巧又停回缝上时才留着握把。
			const box = track.current?.getBoundingClientRect();
			const over = box && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
			if (!over) setGrip(null);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
			// 不给已经不在拖的缝留下排着的活。
			if (frame) cancelAnimationFrame(frame);
		};
	}, [active, row, containerRef]);

	return (
		<div
			ref={track}
			onPointerEnter={(event) => {
				const box = event.currentTarget.getBoundingClientRect();
				const next = row ? event.clientY - box.top : event.clientX - box.left;
				setGrip((current) => (current !== null && Math.round(current) === Math.round(next) ? current : next));
			}}
			onPointerMove={(event) => {
				if (dragging.current) return;
				const box = event.currentTarget.getBoundingClientRect();
				const next = row ? event.clientY - box.top : event.clientX - box.left;
				setGrip((current) => (current !== null && Math.round(current) === Math.round(next) ? current : next));
			}}
			// 拖动时保留：那时指针通常早就在带子外面了。
			onPointerLeave={() => {
				if (!dragging.current) setGrip(null);
			}}
			role="separator"
			aria-orientation={row ? "vertical" : "horizontal"}
			aria-label={translate("splitter.resizePane")}
			aria-valuenow={Math.round((handle.share / handle.pair) * 100)}
			aria-valuemin={0}
			aria-valuemax={100}
			tabIndex={0}
			onPointerDown={(event) => {
				// 只认左键：在这里右键不该悄悄开始一次拖动。
				if (event.button !== 0) return;
				event.preventDefault();
				// 趁布局还干净，在冻结和握把改动它之前。
				dock.current = containerRef.current?.getBoundingClientRect() ?? null;
				const strip = event.currentTarget.getBoundingClientRect();
				along.current = row ? strip.top : strip.left;
				dragging.current = true;
				setActive(true);
			}}
			onDoubleClick={onEven}
			onKeyDown={(event) => {
				const step = (event.shiftKey ? SPLITTER_STEP * 4 : SPLITTER_STEP) * handle.pair;
				const grow = row ? "ArrowRight" : "ArrowDown";
				const shrink = row ? "ArrowLeft" : "ArrowUp";
				if (event.key === grow) onResize(handle.share + step);
				else if (event.key === shrink) onResize(handle.share - step);
				else if (event.key === "Home") onEven();
				else return;
				event.preventDefault();
			}}
			style={
				row
					? {
							left: at ?? pct(handle.left),
							top: pct(handle.top),
							height: pct(handle.height),
							width: SPLITTER_HIT,
							marginLeft: -SPLITTER_HIT / 2,
						}
					: {
							left: pct(handle.left),
							top: pct(handle.top),
							width: pct(handle.width),
							height: SPLITTER_HIT,
							marginTop: -SPLITTER_HIT / 2,
						}
			}
			className={`plume-splitter absolute z-20 ${row ? "cursor-col-resize" : "cursor-row-resize"}`}
		>
			{/*
			 * 指针处的一小段圆头条，就在缝上。
			 *
			 * 离两端留出距离，永远不会爬进标题栏、也不会滑出下面的窗格——到了两头它停下不走，而不是滑出视野。
			 */}
			{grip !== null && (
				<span
					aria-hidden
					/*
					 * 尺寸写在行内而不是工具类里：长度是一个共享常量，用模板拼出来的类名 CSS 构建看不见。
					 */
					style={
						row
							? {
									top: `clamp(${GRIP_SPAN / 2 + 8}px, ${grip}px, calc(100% - ${GRIP_SPAN / 2 + 8}px))`,
									left: "50%",
									height: GRIP_SPAN,
									width: 3,
								}
							: {
									left: `clamp(${GRIP_SPAN / 2 + 8}px, ${grip}px, calc(100% - ${GRIP_SPAN / 2 + 8}px))`,
									top: "50%",
									width: GRIP_SPAN,
									height: 3,
								}
					}
					className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-[var(--plume-t-quick)] ${
						active ? "bg-accent" : "bg-ink-faint/45"
					}`}
				/>
			)}
		</div>
	);
}
