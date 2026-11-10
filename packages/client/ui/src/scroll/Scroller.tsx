import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { scrollFade } from "./fade.ts";
import { cancelMeasure, type Measure, queueMeasure } from "./measure-batch.ts";
import type { Direction } from "./follow.ts";

/**
 * 应用里唯一的滚动面。
 *
 * 原生滚动容器做不到、而参考设计处处都有的几件事：
 *
 *   - 滚动条浮在内容上，而不是预留一条槽，列表一长过它的盒子，内容不会横向重排；
 *   - 边缘说明那个方向还藏着东西，画成边界实际的样子：内容化进空白的地方是渐隐，滑到实心的东西
 *     底下的地方是一道细线。见 `top`——选错了，列表看起来就像坏了。
 *
 * `overscroll-contain` 让滚到头的滚轮停在这里，而不是传给后面的窗口——否则嵌套列表一到底就会带着
 * 父级一起滚。
 *
 * 嵌在外层滚动面里的面（比如转录里的工具卡片、错误日志、代码输出），用 `overscroll="auto"`，
 * 里面滚到边界之后自然地接到外层。
 */
export function Scroller({
	children,
	className = "",
	contentClassName = "",
	top = "fade",
	fadeTop,
	bottom = "fade",
	overscroll = "contain",
	onScroll,
	onResize,
	onUserScroll,
	onHold,
	scrollRef,
}: {
	children: React.ReactNode;
	className?: string;
	contentClassName?: string;
	/**
	 * 滚到自己的边界之后，滚轮还传不传给外面。
	 *
	 * 判断标准是这一块**是页面里的一段内容，还是一块独立的面**。一段内容——设置页里的发版说明、一列
	 * 搜索结果——读到底了还想接着往下看页面，是很自然的一件事，那就该给 `"auto"`。一块
	 * 独立的面——弹窗、浮层、菜单、转录本身——滚到底就该停住，不然一个嵌套列表刚到底就把它背后的整页
	 * 带跑了，那是默认的 `"contain"` 要挡的事。
	 *
	 * 「滚不动的面要不要拦」不用在这里操心：它一律放行，见下面 `chain` 那段。
	 */
	overscroll?: "contain" | "auto";
	/**
	 * 上沿怎么收尾。
	 *
	 * `"fade"` 把最后几行柔化掉，不画任何东西就说出「这边还有」。上面是什么都成立——空窗格也好、
	 * 不透明的导航也好——因为它降的是内容自己的 alpha，而不是往上面刷颜色；为什么这一点就是全部，
	 * 见 `ui/scroll.css` 里 `.plume-fade-y` 上面那段。
	 *
	 * 只在确实有东西滚到底下去之后才出现，短列表完全没有边缘处理：边界在起作用时才值得画。
	 */
	top?: "fade" | "none";
	/** 默认值不适合这个列表时，上沿渐隐伸进去多深，单位 px。 */
	fadeTop?: number;
	/** 下沿的同一个问题。 */
	bottom?: "fade" | "none";
	onScroll?: (element: HTMLDivElement) => void;
	/** 内容或视口尺寸变了就调用。 */
	onResize?: (element: HTMLDivElement) => void;
	/**
	 * 下面滑块的一次拖动，按它本来的手势报出来。
	 *
	 * 滑块是视口的兄弟节点，靠赋值 `scrollTop` 移动视口，于是拖动传到跟随方那里，是一个和浏览器
	 * 夹住正在变短的转录分不开的滚动事件——而跟随方不能因为一次来路不明的位置变化就脱离（见
	 * `follow.ts`），就永远发现不了读者在往外拉。这是唯一知道真相的组件把那个手势明说出来。
	 */
	onUserScroll?: (direction: Direction) => void;
	/**
	 * 读者刚把手指按在了什么上面。
	 *
	 * 给跟随底部的那一方一个机会，把接下来这一次长高认成「读者点开了手里这一块」而不是「新消息
	 * 到了」——两者在 `onResize` 里长得一模一样，而处理方式正好相反。
	 */
	onHold?: (target: EventTarget | null) => void;
	/** 给自己驱动滚动位置的调用方用，比如转录。 */
	scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
	const own = useRef<HTMLDivElement>(null);
	const viewport = scrollRef ?? own;
	const drag = useRef<{ startY: number; startTop: number } | null>(null);
	/*
	 * Activity 保留 DOM，但 Chromium 在隐藏期间会重置原生滚动偏移：在绘制前恢复 `read` 最后看到的位置。
	 * 不在隐藏那一刻读——那时正处在 React 移除旧页面的中途，每个滚动面在那里要一次 `scrollTop`，
	 * 都会强制整页排一遍版。
	 */
	const seenTop = useRef<number | null>(null);

	useLayoutEffect(() => {
		const el = viewport.current;
		if (el && seenTop.current !== null) el.scrollTop = seenTop.current;
	}, [viewport]);

	const [metrics, setMetrics] = useState({ height: 0, overflow: false, atTop: true, atBottom: true });
	const [active, setActive] = useState(false);
	/*
	 * 滑块的位置和长度不进 state，直接写到它身上。
	 *
	 * 贴底跟随每帧都在挪 `scrollTop`，滑块跟着动半个像素就是一次 React 重画、一次样式写入。几个面板
	 * 同时在输出时，一个面板的 scroll 回调刚写完，下一个面板的 scroll 回调读 `scrollHeight`，就为它把
	 * 整页的样式和布局强制算一遍——量过，这里一处占了渲染进程 12%。只有边缘渐隐和要不要画滑块这几样
	 * 真的改变渲染，留在 state 里。
	 *
	 * 写也不能弄脏布局：这一写就夹在各个面板的 scroll 回调之间，写 `top` 会让紧接着读 `scrollTop`
	 * 的下一个面板再排一遍版，量到强制布局翻了一倍多（401 → 980 次 / 3s）。位置走 `transform`，只动绘制；长度取整，
	 * 内容每长一截它只变零点几像素，取整后多半不用写。
	 */
	const thumb = useRef<HTMLDivElement>(null);
	const geometry = useRef({ top: 0, height: 0 });
	const paintThumb = useCallback(() => {
		const element = thumb.current;
		if (!element) return;
		const top = `translateY(${Math.round(geometry.current.top * 2) / 2}px)`;
		const height = `${Math.round(geometry.current.height)}px`;
		if (element.style.transform !== top) element.style.transform = top;
		if (element.style.height !== height) element.style.height = height;
	}, []);

	/** 只读，交回写的那一半——好让 `queueMeasure` 把几个面板的读全排在写前面。 */
	const read = useCallback<Measure>(() => {
		const el = viewport.current;
		if (!el) return () => {};
		const { scrollTop, scrollHeight, clientHeight } = el;
		if (clientHeight > 0) seenTop.current = scrollTop;
		const overflow = scrollHeight - clientHeight > 1;
		// 比这更短的滑块抓不住；内容很长时它就不再严格按比例，换来能用，这笔账划算。
		const thumbHeight = overflow ? Math.max(28, (clientHeight / scrollHeight) * clientHeight) : 0;
		const travel = clientHeight - thumbHeight;
		const progress = scrollHeight - clientHeight <= 0 ? 0 : scrollTop / (scrollHeight - clientHeight);
		const newThumbTop = travel * progress;
		const newAtTop = scrollTop <= 1;
		const newAtBottom = scrollTop >= scrollHeight - clientHeight - 1;

		return () => {
			geometry.current = { top: newThumbTop, height: thumbHeight };
			paintThumb();
			setMetrics((prev) => {
				if (prev.height === clientHeight && prev.overflow === overflow && prev.atTop === newAtTop && prev.atBottom === newAtBottom) return prev;
				return { height: clientHeight, overflow, atTop: newAtTop, atBottom: newAtBottom };
			});
		};
	}, [viewport, paintThumb]);
	const measure = useCallback(() => read()(), [read]);

	// 滑块是 `overflow` 变真时才挂上的，那一刻它身上还没有位置。
	useLayoutEffect(paintThumb, [metrics.overflow, paintThumb]);

	useLayoutEffect(() => {
		const el = viewport.current;
		if (!el) return;
		onResize?.(el);
		measure();

		const scheduleMeasure = () => queueMeasure(read);

		/*
		 * 观察的是内容，不只是盒子——这是两个不同的量。
		 *
		 * 只 `observe(el)` 报的是**视口**的尺寸，而视口是 flex 子项：它的高度由上面的布局决定，里面的
		 * 东西长高变矮它都不动。于是折叠一组工具——把里面的高度动画到零、一个节点都不碰——
		 * `scrollHeight` 变了几百像素，却什么都没触发。量过：把一个子节点从 900px 缩到 200px，零次回调。
		 *
		 * 观察直接子节点就好了，因为高度沿着普通的块级流向外传：三层下面的一组折叠了，它的祖先跟着变矮，
		 * 视口的子节点也跟着变矮。
		 *
		 * 变动观察器留着，还多了一份差事：消息到来时子节点来来去去，新来的也得被尺寸观察器接上。
		 */
		/*
		 * 位置在这里就地改完，其余的照旧推到下一帧。
		 *
		 * 这个回调跑在布局之后、绘制之前——是这一帧最后一次还来得及改 `scrollTop` 的机会。测量和
		 * 那些跟着重画的状态留在 rAF 里（它们不急，而且同步做会把布局搅乱）；位置不能等，展开动画
		 * 每一帧都长高一点，晚一帧就是一串看得见的小抖。
		 *
		 * 贴底跟随（`onResize`）也得照这样做，不能一起推进 rAF——否则内容长高的那一帧先按没补偿的
		 * 位置画出来，下一帧才拉回去：运行行上「本轮 N tokens」冒出来的同一帧，整块转录往下掉 38px，
		 * 再一帧弹回原位。一帧 16 毫秒，看着就是「闪了一下」。
		 */
		const observer = new ResizeObserver(() => {
			const el = viewport.current;
			if (el) onResize?.(el);
			scheduleMeasure();
		});
		const watch = () => {
			observer.disconnect();
			observer.observe(el);
			for (const child of el.children) observer.observe(child);
		};
		watch();

		const mutations = new MutationObserver(() => {
			watch();
			scheduleMeasure();
		});
		mutations.observe(el, { childList: true, subtree: false });

		return () => {
			cancelMeasure(read);
			observer.disconnect();
			mutations.disconnect();
		};
	}, [measure, read, onResize, viewport]);

	// 拖动会延续到滑块外面，所以监听挂在 window 上。
	useEffect(() => {
		if (!active) return;
		let frame = 0;
		let latestEvent: MouseEvent | null = null;

		const updateScroll = () => {
			frame = 0;
			const event = latestEvent;
			if (!event) return;
			const el = viewport.current;
			const state = drag.current;
			if (!el || !state) return;
			const travel = el.clientHeight - geometry.current.height;
			if (travel <= 0) return;
			const ratio = (event.clientY - state.startY) / travel;
			/*
			 * 先报手势，**再**赋值 `scrollTop`。
			 *
			 * 赋值会同步触发 `scroll`。如果这个事件在面还在跟随时就到了 `arrived`，下一次跟随写入会和
			 * 拖动抢一帧——滑块离不开底部。先表明意图就会脱离跟随，之后的写入只是一个位置。
			 *
			 * 方向取自夹过的目标值，而不是原始比例。行程用完的拖动不会产生移动，这时还报一个方向，
			 * 抵在末端按住的滑块就会让正在跟随的转录停下。
			 */
			const travelMax = el.scrollHeight - el.clientHeight;
			const next = Math.max(0, Math.min(travelMax, state.startTop + ratio * travelMax));
			const before = el.scrollTop;
			if (next < before) onUserScroll?.("up");
			else if (next > before) onUserScroll?.("down");
			el.scrollTop = next;
		};

		const onMove = (event: MouseEvent) => {
			latestEvent = event;
			if (!frame) {
				frame = requestAnimationFrame(updateScroll);
			}
		};
		const onUp = () => {
			if (frame) {
				cancelAnimationFrame(frame);
				updateScroll();
			}
			drag.current = null;
			setActive(false);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			if (frame) cancelAnimationFrame(frame);
		};
	}, [active, onUserScroll, viewport]);

	/*
	 * 滚不动的时候不拦滚轮。
	 *
	 * `contain` 要拦的是「滚到边界了别带动外面」，不是「我自己滚不动也不让你滚」。可 `overflow-y: auto`
	 * 的元素**即使内容没溢出**仍然是个 scroll container，`overscroll-behavior` 照样生效——于是设置页
	 * 里一张内容没撑满的卡片，鼠标停上去整页就滚不动了，移开又好。
	 *
	 * 真窗口里拿真滚轮量过：滚不动的盒子挂 `contain`，外层一动不动；同一个盒子换成 `auto`，外层照常
	 * 走 360px。两种溢出状态各试一遍才分得清——只测「可滚且到底」那一半，会把这个毛病当成 `contain`
	 * 本来该做的事放过去。
	 */
	const chain = overscroll === "auto" || !metrics.overflow ? "overscroll-auto" : "overscroll-contain";

	// 两边都只在那个方向确实藏着东西时才有意义。
	const hiddenAbove = metrics.overflow && !metrics.atTop;
	const showTopFade = top === "fade" && hiddenAbove;
	const showBottomFade = bottom === "fade" && metrics.overflow && !metrics.atBottom;
	const fades = top === "fade" || bottom === "fade";

	return (
		<div className={`plume-scroll-host relative flex min-h-0 flex-col ${className}`}>
			<div
				ref={viewport}
				onScroll={(event) => {
					queueMeasure(read);
					onScroll?.(event.currentTarget);
				}}
				/*
				 * 捕获阶段，早于任何 onClick。
				 *
				 * 展开一段折叠区的那一帧要用的是**按下时**元素在视口的高度；等点击冒泡上来，布局
				 * 已经变了，量到的是展开之后的位置，锚也就锚错了地方。
				 */
				onPointerDownCapture={(event) => onHold?.(event.target)}
				/*
				 * 做 flex 子项，不用 `height: 100%`。
				 *
				 * `height: 100%` 要求父级有一个**算得出来**的高度。父级只受 `max-height` 约束时——这里每个
				 * 菜单都是这样定尺寸的——它算出来是 `auto`，视口跟着内容长，什么都不滚：分支列表直接从自己
				 * 菜单的底下跑了出去。百分比的 `max-height` 出于同样的原因同样不行。把宿主做成 flex 列、这个
				 * 做它的子项，尺寸就交给了 flex 算法，固定高度和 `max-height` 它都认——同一个 Scroller 在窗格
				 * 里和弹层里都能用。
				 */
				/*
				 * 渐隐是这个元素上的遮罩，两个深度就是它全部的状态——零就是没有渐隐，所以同一条声明管两头、
				 * 两个方向，两者之间的过渡就是一个长度在插值。只在可能有渐隐的地方挂上这个类：遮罩会把滚动面
				 * 提升成单独的合成层，永远不会柔化的滚动面没理由付这个代价。
				 */
				/*
				 * 只竖着滚，而且 `overflow-x` 明写出来，不交给浏览器。
				 *
				 * `overflow-y: auto` 配 `overflow-x: visible` 在 CSS 里不存在：规范会把 visible 那个也变成
				 * `auto`。于是应用里每个滚动面都悄悄能横着滚，一个过宽的子节点——一段放着提交哈希的代码块、
				 * 一张表格——就把整列带着走。看到的是转录本身连标题带正文往左偏，给一个本来自己就会处理过宽
				 * 的东西腾地方。
				 *
				 * 这才是真正的修法：`pre` 本来就自己滚，在这里裁掉正是让它自己滚的前提。阅读列往右边没有
				 * 意义——真比窗口还宽的东西，宽在它**自己的**盒子里。
				 */
				className={`plume-scroll-view min-h-0 flex-auto overflow-x-hidden overflow-y-auto ${
					chain
					/*
					 * 类名必须正好是 `plume-fade-y`。
					 *
					 * 下面那个 `style` 只写 `--plume-fade-top` 和 `--plume-fade-bottom` 两个变量，遮罩是
					 * `.plume-fade-y`（`ui/scroll.css`）画的。类名一改，变量照样写得出去，遮罩规则却不再命中，
					 * 于是每一个带渐隐的滚动面——转录、侧栏、设置页、浮层——上下边缘都是硬切。
					 *
					 * 没有任何检查拦得住这个：类名是字符串，类型检查和 lint 都不看它。
					 */
				} ${fades ? "plume-fade-y" : ""} ${contentClassName}`}
				tabIndex={-1}
				style={
					fades
						? ({
								"--plume-fade-top": showTopFade ? `${scrollFade(metrics.height, "top", fadeTop)}px` : "0px",
								"--plume-fade-bottom": showBottomFade ? `${scrollFade(metrics.height, "bottom")}px` : "0px",
							} as React.CSSProperties)
						: undefined
				}
			>
				{children}
			</div>

			{metrics.overflow && (
				<div
					/*
					 * 贴着边，压在边上所有东西之上，自己不接点击。
					 *
					 * 这条窄带有两样东西要：滑块，以及——在能调宽度的窗格里——拖宽它的那个把手。两者放在同一
					 * 层、把手在上的话，滑块画出来了、看得见，却永远抓不住。把轨道往里缩、让开把手确实能解决，
					 * 代价却不值：应用里每个窗格的滚动条都浮在离它所属的边九个像素的地方。
					 *
					 * 不过它们其实不冲突，因为轨道不是控件。它没有填充，没有可点的东西——只有里面的滑块有。所以
					 * 轨道放在把手之上，让滑块在吸顶的标题上面也看得见，所有按下都直接穿过去；滑块再把属于自己的
					 * 那部分拿回来。剩下的是调宽度那条带上一个滑块形状的洞，在指针看得见的地方，而不是为了某一个
					 * 窗格的把手，把所有地方的滚动条都挪离原位。
					 *
					 * 点轨道跳转也随之拿掉。在一条看不见轨道的 10px 窄带上，它本来就没人发现得了，不值得为它
					 * 换一条拖不动的边。
					 */
					className="pointer-events-none absolute top-0 right-0 bottom-0 z-40 w-[10px]"
				>
					{/* 对辅助技术隐藏：真正滚的是底下的视口。 */}
					<div
						ref={thumb}
						aria-hidden
						tabIndex={-1}
						onMouseDown={(event) => {
							event.preventDefault();
							const el = viewport.current;
							if (!el) return;
							drag.current = { startY: event.clientY, startTop: el.scrollTop };
							setActive(true);
							// 手按在滑块上，还没动就已经是在认领这块面——如果正在滑回底部，这一下就是喊停。
							onUserScroll?.("unknown");
						}}
						className={`plume-thumb absolute top-0 right-[2px] w-[6px] rounded-full bg-ink-faint ${active ? "plume-thumb-active" : ""}`}
					/>
				</div>
			)}
		</div>
	);
}
