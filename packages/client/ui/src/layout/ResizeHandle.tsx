import { useEffect, useRef, useState } from "react";

import { freezeMotion } from "../motion/freeze.ts";

/**
 * 指针离开边多远还算抓着它。
 *
 * 几乎全在边界的另一侧——见 `INSIDE`。
 */
const HIT_WIDTH = 9;
/**
 * 那条抓取区有多少落在被调整的窗格里面。
 *
 * 一个像素，有它边界本身才抓得住，而不只是边界旁边的内容。其余的悬在邻居上面。
 *
 * 原因是滚动条。窗格的滚动区把滑块放在同一条边的最后几个像素上，而滑块只在滚动区被悬停时才够得着——停在
 * 拖把上的指针并没有悬停它。所以共用这条带子不只是让两者抢，还让滚动条能不能拖取决于指针从哪个方向来：
 * 从列表那边过来，路上就悬停了滚动区；从内容那边过来就没有。什么 z 序都修不了这个。把抓取区挪到另一侧
 * 就行，而且看不出代价：滑块占的是从窗格边算起的第 2 到第 8 个像素，重叠一个像素，两者互不相交。
 */
const INSIDE = 1;
/** 键盘每按一下调多少。Shift 放大它，和别处微调的习惯一样。 */
const STEP = 16;
/** 够长才读得出是握把，够短才不像边框。 */
const GRIP_HEIGHT = 30;

/**
 * 窗格能拖的那条边。
 *
 * 出现的是指针处的一小段握把，不是沿整条边的一道线。整高的线读起来是边框——布局里永久的一部分——而它要说的
 * 是「这一处可以拖」。跟着指针走的握把只说这一件事，边界看起来也不会因为你碰巧靠近而变样。
 *
 * 抓取区跨在边界上，几乎全在邻居那一侧，这样才离窗格里的滚动条远——见 `INSIDE`。渲染它的地方要给它一个
 * 不裁切的定位上下文：窗格会裁掉自己的溢出，悬在窗格外面的拖把会直接被切掉。所以用它的地方要在窗格外面
 * 再包一层框。
 *
 * 报告的是从拖动开始处算出的绝对宽度，不是增量。每次 mousemove 累加增量会把夹紧误差攒起来：拖过最小值
 * 再拖回来，窗格就少了你拖过头的那一截。
 */
export function ResizeHandle({
	edge,
	width,
	min,
	max,
	onResize,
	onReset,
	label,
}: {
	/** 在窗格的哪一边：左边的窗格是 `end`，右边的是 `start`。 */
	edge: "start" | "end";
	width: number;
	min: number;
	max: number;
	onResize: (next: number) => void;
	/** 双击恢复默认。 */
	onReset?: () => void;
	label: string;
}) {
	const track = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState(false);
	/*
	 * 握把在边上的哪个位置，从拖把顶部算起的像素。
	 *
	 * 指针来之前是 null，没人伸手的窗格上什么都不画。存成状态而不是从 CSS 变量读，因为它还得活过整个拖动：
	 * 指针一离开这条 9px 的带子，拖把就收不到移动了，拖到一半握把消失，你就是在拖一条看不见的边。
	 */
	const [grip, setGrip] = useState<number | null>(null);
	const start = useRef({ x: 0, width: 0, top: 0 });

	useEffect(() => {
		if (!active) return;

		/*
		 * 每帧更新一次，不是每个事件一次。
		 *
		 * `mousemove` 比屏幕刷新得快——120Hz 的触控板上尤其明显——而每次都要做三件贵的事：一次重渲染整个窗口
		 * 的 `setState`、一次同步强制排版的 `getBoundingClientRect`、再一次 `setState`。一帧里来好几次就是
		 * 排版抖动，拖动另一侧是多窗格的停靠区时，表现为拖把走得顺、窗格在抖。
		 *
		 * 合并到 `requestAnimationFrame`，活就正好按看得见的频率做，测量也发生在一帧里排版本来就已经落定的
		 * 那个时刻。
		 */
		let frame = 0;
		let pending: MouseEvent | null = null;

		const apply = () => {
			frame = 0;
			const event = pending;
			pending = null;
			if (!event) return;

			const travel = event.clientX - start.current.x;
			const next = edge === "end" ? start.current.width + travel : start.current.width - travel;
			onResize(Math.min(max, Math.max(min, next)));
			// 整个拖动里握把跟着指针的高度，而不是停在按下的地方。
			setGrip(event.clientY - start.current.top);
		};

		const onMove = (event: MouseEvent) => {
			pending = event;
			if (!frame) frame = requestAnimationFrame(apply);
		};
		/*
		 * 握把也放掉，除非指针又停回了边上。
		 *
		 * 拖动几乎总是在别处结束——这正是拖的意义——而 `mouseleave` 报告不了这个，因为指针早在按键抬起之前就
		 * 离开这个元素了。
		 */
		const stop = (event: MouseEvent) => {
			setActive(false);
			if (!over(track.current, event)) setGrip(null);
		};

		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", stop);
		/*
		 * 光标和防选中放在 <body> 上，不放在拖把上。
		 *
		 * 拖起来以后指针大部分时间在两侧的窗格上，而拖把上的 `cursor` 只在指针真的在它上面时生效——拖动一离开
		 * 这条 9px 的带子，光标就会闪回文字光标。
		 */
		document.body.style.cursor = "col-resize";
		// 拖动期间冻住过渡，窗格跟着指针走，而不是缓动向每一个中间宽度、永远到不了——并拒绝拖过内容时会开始的
		// 文字选择。两样都靠点名元素，而不是根上的标记（根在正文之上）；见 `motion/freeze.ts`。
		const thaw = freezeMotion();

		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", stop);
			// 在一帧中间结束的拖动，不给已卸载的拖把留下排着的活。
			if (frame) cancelAnimationFrame(frame);
			document.body.style.cursor = "";
			thaw();
		};
	}, [active, edge, min, max, onResize]);

	/*
	 * 光靠 `mouseleave` 不足以知道指针走了。
	 *
	 * 指针在两帧之间整个越过元素时它不发——快速划过一条九像素的带子正是这样——指针离开窗口时它干脆不发，而这
	 * 正是会被注意到的情形：握把在一条没人靠近的边上一直亮着，也永远不会有什么来把它熄掉。
	 *
	 * 所以反过来问。握把显示着的时候，任何地方的每一次指针移动都重新检查它还在不在这条带子上，离开文档或窗口
	 * 就立刻了结。只在不拖动时这样——拖动时指针本来就该在远处，握把本来就该跟着它。
	 */
	useEffect(() => {
		if (grip === null || active) return;
		const check = (event: MouseEvent) => {
			if (!over(track.current, event)) setGrip(null);
		};
		const gone = () => setGrip(null);
		// 没有 relatedTarget 的 `mouseout` 是指针越过了窗口自己的边界。
		const out = (event: MouseEvent) => {
			if (!event.relatedTarget) gone();
		};
		window.addEventListener("mousemove", check);
		document.addEventListener("mouseout", out);
		window.addEventListener("blur", gone);
		return () => {
			window.removeEventListener("mousemove", check);
			document.removeEventListener("mouseout", out);
			window.removeEventListener("blur", gone);
		};
	}, [grip, active]);

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={Math.round(width)}
			aria-valuemin={min}
			aria-valuemax={max}
			tabIndex={0}
			ref={track}
			onMouseEnter={(event) => setGrip(event.clientY - event.currentTarget.getBoundingClientRect().top)}
			onMouseMove={(event) => {
				if (active) return;
				setGrip(event.clientY - event.currentTarget.getBoundingClientRect().top);
			}}
			onMouseLeave={() => {
				// 拖动时保留：那时指针通常早就在带子外面了。
				if (!active) setGrip(null);
			}}
			onMouseDown={(event) => {
				// 只认左键：在这里右键不该悄悄开始一次拖动。
				if (event.button !== 0) return;
				event.preventDefault();
				start.current = { x: event.clientX, width, top: event.currentTarget.getBoundingClientRect().top };
				setActive(true);
			}}
			onDoubleClick={onReset}
			onKeyDown={(event) => {
				const step = event.shiftKey ? STEP * 4 : STEP;
				// 方向键挪的是边本身，所以对左边的窗格，左键总是变窄。
				const grow = edge === "end" ? "ArrowRight" : "ArrowLeft";
				const shrink = edge === "end" ? "ArrowLeft" : "ArrowRight";
				if (event.key === grow) onResize(Math.min(max, width + step));
				else if (event.key === shrink) onResize(Math.max(min, width - step));
				else if (event.key === "Home") onReset?.();
				else return;
				event.preventDefault();
			}}
			// 除了 `INSIDE` 那一像素都推出去，带子落在窗格边的外面。
			style={{ width: HIT_WIDTH, [edge === "end" ? "right" : "left"]: INSIDE - HIT_WIDTH }}
			className="group/resize absolute top-0 bottom-0 z-30 cursor-col-resize [--plume-grip:30px]"
		>
			{/*
			 * 握把：一小段圆头竖条，中心对着指针，钉在边界本身上。
			 *
			 * 带子挪到了邻居那一侧，边界是这条带子的**近**边而不是远边。画在那里而不是抓取区中间，指针底下出现的
			 * 才仍然是两个窗格之间的缝，而不是飘在内容上的一个记号。
			 *
			 * 离两端留出距离，永远碰不到上面的窗口按钮和下面的状态行——到了两头它停下不走，而不是滑出窗格。
			 */}
			{grip !== null && (
				<span
					aria-hidden
					style={{ top: `clamp(${GRIP_HEIGHT / 2 + 8}px, ${grip}px, calc(100% - ${GRIP_HEIGHT / 2 + 8}px))` }}
					className={`absolute h-[var(--plume-grip)] w-[3px] -translate-y-1/2 rounded-full transition-colors duration-[var(--plume-t-quick)] ${
						edge === "end" ? "left-0" : "right-0"
					} ${active ? "bg-accent" : "bg-ink-faint/45"}`}
				/>
			)}
		</div>
	);
}

/** 指针事件是否落在元素的框里。元素是 null 算「不在」。 */
function over(element: HTMLElement | null, event: MouseEvent): boolean {
	if (!element) return false;
	const box = element.getBoundingClientRect();
	return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
}
