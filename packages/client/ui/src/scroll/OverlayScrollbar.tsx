import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 给标记不归应用管的滚动面用的滚动条。
 *
 * 应用自己渲染的东西都由 `Scroller` 管。这个给它够不着的地方——CodeMirror 的滚动容器、文本框、回复里
 * 横着滚的代码块或表格、diff——元素会滚，但 DOM 属于别人或者没法包一层。给它那个元素的 ref，它就在
 * 上面画同样的滑块。
 *
 * 这里不能用原生滚动条。原生滚动条是全局隐藏的，好让每个滚动面都经过 `Scroller`；按元素重新打开
 * 也拿不回同样的控制：macOS 上的浮动滚动条完全无视 `::-webkit-scrollbar` 的样式，只在滚轮转动时出现，
 * 于是一个静止的窗格看上去根本没有滚动条——编辑器当时读起来正是这样。在这里画，它遵守应用自己的
 * 规则，也永远不从内容那里拿走一个像素的宽度。
 *
 * 两个方向有意不按同一种方式显示，和 diff 的理由一样：竖向溢出自己会说话，因为内容在下沿明显被
 * 截断了，悬停时出现滑块就够。一行跑到右边外面去的字，看着和在那里结束的一行一模一样，也没有东西
 * 动起来说明不是——所以那一条一直显示。
 *
 * 横向轨道放在哪，是这些地方之间唯一的不同，所以它是一个参数而不是第二个组件。通常被滚的元素
 * **就是**窗格，它的下沿就是对的位置（`overlay`）。diff 嵌在一个高得多的竖向滚动面里，钉在内容底部
 * 的滚动条要等你滚过它本该帮忙的所有内容之后才会露出来——所以那里的轨道 `sticky` 在外面那个竖向
 * 滚动面的底部。
 */
/** 轨道的厚度，也是两条轨道交汇时彼此让开的距离。 */
const THICKNESS = 10;

export function OverlayScrollbar({
	viewport,
	orientation,
	placement = "overlay",
}: {
	viewport: React.RefObject<HTMLElement | null>;
	orientation: "vertical" | "horizontal";
	/**
	 * `sticky`：轨道排在视口后面，粘在外面那个竖向滚动面的底部，落在内容在末尾预留的一条 10px 上。
	 * 视口溢出期间带着 `data-hscroll="on"`，好让它的样式预留那一条——滑块不能盖住最后一行。只用于横向。
	 */
	placement?: "overlay" | "sticky";
}) {
	const vertical = orientation === "vertical";
	const sticky = !vertical && placement === "sticky";
	const track = useRef<HTMLDivElement>(null);
	const drag = useRef<{ start: number; from: number } | null>(null);
	const [metrics, setMetrics] = useState({ offset: 0, size: 0, overflow: false, inset: 0 });
	const [active, setActive] = useState(false);

	/*
	 * 正在被量的那个元素，放进 state。
	 *
	 * 参数是一个 ref，而 ref 改指向不惊动任何人——这是这个组件最难看出来的一处毛病。编辑器每打开
	 * 一个文件就把 CodeMirror 整个重建一次，`ref.current` 指向新的 `.cm-scroller`；这个组件既没
	 * 卸载也没有重新跑 effect，于是 scroll 监听和两个 observer 全留在上一个、已经被 destroy 的
	 * 元素上，再没有人叫它量第二次。看到的就是：换过一次文件之后滑块不再跟着内容走，停在上一个文
	 * 件留下的位置——内容明明在第 120 行，滑块还贴在顶端。
	 *
	 * 每次渲染之后对一次。值没变时 `setState` 会被 React 直接跳过，不会多渲染一轮；变了才重新
	 * 绑，而「变了」正是那次没人发现的更换。
	 */
	const [element, setElement] = useState<HTMLElement | null>(null);
	/*
	 * 没有依赖数组是有意的：要盯的正是 ref 在两次渲染之间悄悄换掉的那一刻，而那件事不出现在任何
	 * 依赖里。相同的值 React 会直接跳过，连环更新不会发生。
	 */
	// oxlint-disable-next-line react-hooks/exhaustive-deps
	useLayoutEffect(() => setElement(viewport.current));

	const measure = useCallback(() => {
		const el = element;
		if (!el) return;
		const length = vertical ? el.clientHeight : el.clientWidth;
		const total = vertical ? el.scrollHeight : el.scrollWidth;
		const at = vertical ? el.scrollTop : el.scrollLeft;

		const overflow = total - length > 1;
		if (sticky) el.dataset.hscroll = overflow ? "on" : "off";
		/*
		 * 角落归谁。
		 *
		 * 两条轨道各自铺满一整条边，于是右下角那 10×10 是重叠的，而横的那条在 DOM 里靠后、层级
		 * 相同，压在竖的上面。结果是竖滑块走到最后 10px 时鼠标被横轨道接走——按得到、拖不动，
		 * 看着就是「拖不到底」。横滑块到最右也是同一回事。
		 *
		 * 谁在那儿就给谁让开：另一条存在时，这一条短 10px，角落空出来，两个滑块各自都能走到自己
		 * 的尽头。行程也跟着按让开之后的长度算，否则滑块会从轨道末端探出去。
		 */
		const crossTotal = vertical ? el.scrollWidth : el.scrollHeight;
		const crossLength = vertical ? el.clientWidth : el.clientHeight;
		const inset = crossTotal - crossLength > 1 ? THICKNESS : 0;
		const rail = Math.max(0, length - inset);

		// 短于 28px 左右的滑块抓不住；内容很长时它就不再严格按比例，换来能用，这笔账划算。
		const size = overflow ? Math.min(rail, Math.max(28, (length / total) * rail)) : 0;
		const travel = rail - size;
		const progress = total - length <= 0 ? 0 : at / (total - length);
		const offset = travel * progress;
		setMetrics((prev) =>
			Math.abs(prev.offset - offset) < 0.5 && Math.abs(prev.size - size) < 0.5 && prev.overflow === overflow && prev.inset === inset
				? prev
				: { offset, size, overflow, inset },
		);
	}, [vertical, sticky, element]);

	useLayoutEffect(() => {
		const el = element;
		if (!el) return;
		measure();
		el.addEventListener("scroll", measure, { passive: true });

		// 两个都要：窗格改尺寸时盒子变，文件被编辑、或者语法加载完重排时内容变。
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		for (const child of el.children) observer.observe(child);
		/*
		 * 内容变了推到下一帧再量，一帧最多一次。
		 *
		 * 正在输出的代码块每次提交都改一串文字节点，变更回调紧跟在提交后面，那时布局还是脏的——当场读
		 * `scrollWidth` 就是为它强制把整页排一遍，几个面板同时输出时每帧好几次。挪到下一帧开头，几处
		 * 读挨在一起、中间没有写，整页只排一次。
		 */
		let frame = 0;
		const mutations = new MutationObserver(() => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				measure();
			});
		});
		mutations.observe(el, { childList: true, subtree: true, characterData: true });

		return () => {
			cancelAnimationFrame(frame);
			el.removeEventListener("scroll", measure);
			observer.disconnect();
			mutations.disconnect();
		};
	}, [measure, element]);

	// 拖动会延续到滑块外面，所以监听挂在 window 上。
	useEffect(() => {
		if (!active) return;
		const onMove = (event: MouseEvent) => {
			const el = element;
			const state = drag.current;
			if (!el || !state) return;
			const length = vertical ? el.clientHeight : el.clientWidth;
			const total = vertical ? el.scrollHeight : el.scrollWidth;
			const travel = Math.max(0, length - metrics.inset) - metrics.size;
			if (travel <= 0) return;
			const ratio = ((vertical ? event.clientY : event.clientX) - state.start) / travel;
			const next = state.from + ratio * (total - length);
			if (vertical) el.scrollTop = next;
			else el.scrollLeft = next;
		};
		const onUp = () => {
			drag.current = null;
			setActive(false);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
	}, [active, metrics.size, metrics.inset, vertical, element]);

	if (!metrics.overflow) return null;

	return (
		<div
			ref={track}
			// 末端让开另一条轨道占的那 10px——见 `measure` 里的「角落归谁」。
			style={sticky ? undefined : vertical ? { bottom: metrics.inset } : { right: metrics.inset }}
			className={
				sticky
					? // 负外边距让它落在行预留的那一条上，而不是自己再加一截高度。
						"pointer-events-auto sticky bottom-0 z-[2] -mt-[10px] h-[10px]"
					: `pointer-events-auto absolute z-[3] ${vertical ? "top-0 right-0 w-[10px]" : "bottom-0 left-0 h-[10px]"}`
			}
			onMouseDown={(event) => {
				// 点轨道跳到那个位置，然后交给拖动。
				if (event.target !== track.current) return;
				const el = element;
				if (!el || !track.current) return;
				const rect = track.current.getBoundingClientRect();
				const length = vertical ? el.clientHeight : el.clientWidth;
				const total = vertical ? el.scrollHeight : el.scrollWidth;
				const travel = Math.max(0, length - metrics.inset) - metrics.size;
				const from = vertical ? event.clientY - rect.top : event.clientX - rect.left;
				const ratio = (from - metrics.size / 2) / Math.max(1, travel);
				const next = Math.min(1, Math.max(0, ratio)) * (total - length);
				if (vertical) el.scrollTop = next;
				else el.scrollLeft = next;
			}}
		>
			{/*
			 * 有意对辅助技术隐藏。
			 *
			 * 真正滚的是底下的视口，读屏器该驱动的也是它。在这里声明 `role="scrollbar"` 却不给值，
			 * 等于宣布一个什么都不报告的控件——比没有还糟。
			 */}
			<div
				aria-hidden
				tabIndex={-1}
				onMouseDown={(event) => {
					event.preventDefault();
					const el = element;
					if (!el) return;
					drag.current = {
						start: vertical ? event.clientY : event.clientX,
						from: vertical ? el.scrollTop : el.scrollLeft,
					};
					setActive(true);
				}}
				style={vertical ? { top: metrics.offset, height: metrics.size } : { left: metrics.offset, width: metrics.size }}
				className={`absolute rounded-full bg-ink-faint ${
					vertical
						? `plume-thumb right-[2px] w-[6px] ${active ? "plume-thumb-active" : ""}`
						: `plume-hthumb bottom-[2px] h-[6px] ${active ? "plume-hthumb-active" : ""}`
				}`}
			/>
		</div>
	);
}
