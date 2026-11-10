/**
 * 锚在打开它的元素上的弹层。
 *
 * 属于某个控件的菜单应该出现在那个控件旁边，而不是窗口正中——居中的对话框丢掉了「点的是什么」和
 * 「打开的是什么」之间的联系。位置从触发元素的矩形量出来，要跑出屏幕时翻到另一侧。
 *
 * 面是三个槽位而不是一个：中间滚动时 `header` 和 `footer` 不动。没有这个的话，要搜索框的菜单只能把它
 * 放进滚动区，再想办法不让它被滚走——每个菜单各解决一遍，解法还各不相同。
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { OverlayDepth } from "./Overlay.tsx";
import { leaveAfterimage } from "./afterimage.ts";
import { claimHoverSuppression } from "./hover-layers.ts";
import { chromeTop } from "./chrome-top.ts";
import { Scroller } from "../scroll/Scroller.tsx";
import { portal } from "./portal.ts";

/**
 * 挂菜单的一个点，给右键用——被操作的是一整行，唯一有意义的位置就是指针本身。
 */
interface PointAnchor {
	x: number;
	y: number;
}

export type Anchor = HTMLElement | PointAnchor | null;

/**
 * 浮起的面允许的宽度。
 *
 * 各自挑宽度的话，184 到 288 之间能挑出十几种，长得一样的两个菜单也对不上——同一个手势在侧栏和输入框里
 * 打开的面板差四个像素，谁也说不出为什么。这里四档，按面里装的是什么来选，而不是按写它那天最长的
 * 标签碰巧有多长。
 */
const MENU_WIDTH = {
	/** 只有动作，每个一两个词。 */
	compact: 190,
	/** 普通的菜单——图标、文字，有时有第二行——以及所有下拉。 */
	default: 224,
	/** 带搜索框的，或者长到要滚动的列表。 */
	wide: 272,
	/** 不是菜单：一段读数、一个滑块、一张表单。 */
	panel: 300,
	/**
	 * 内容多宽就多宽（`undefined` 就是「这一层别管宽度」）。
	 *
	 * 给宽度要跟着自己的字走的面用（比如一条动作条）：写死一个数，字一变总有一边要截断。菜单默认的
	 * `compact` 是要写死的那种默认，不是这个。
	 */
	hug: undefined,
} as const;

export type PopoverWidth = keyof typeof MENU_WIDTH | number;

/**
 * 列东西的菜单最高能长到多高。
 *
 * 交给窗口决定的话，高屏幕上的一个列表菜单会从输入框一直铺到屏幕顶——技术上没错，但四十行的列表没人
 * 读到底。会滚动的菜单出于同一个理由各挑一个上限（280、300、320），这里把这个理由说一次。
 */
export const MENU_MAX_HEIGHT = 340;

function widthOf(width: PopoverWidth | undefined): number | undefined {
	if (width === undefined) return undefined;
	return typeof width === "number" ? width : MENU_WIDTH[width];
}

/**
 * 没写宽度的动作菜单不按最长的标签收紧。
 *
 * 收紧的话，只有一行的菜单会画成一颗按内容宽的胶囊，旁边就是 190px 的菜单，同一个手势看着像两种组件。
 * compact 就是动作菜单的宽度；列东西、搜索、读数的仍然传自己的宽度。
 */
function resolvedWidth(width: PopoverWidth | undefined, role: "menu" | "listbox" | "dialog" | "group"): PopoverWidth | undefined {
	if (width !== undefined) return width;
	return role === "menu" || role === "listbox" ? "compact" : undefined;
}

export interface PopoverProps {
	/** 弹层挂在哪个元素上，右键菜单则是一个点。 */
	anchor: Anchor;
	onClose: () => void;
	children: React.ReactNode;
	/**
	 * 优先放在哪一侧。地方不够时自动翻转。
	 *
	 * `right` 把菜单放在触发元素旁边而不是下面，这对列表里的一行很重要：往下掉的菜单会盖住你正要拿来
	 * 对比的那几行。
	 */
	placement?: "top" | "bottom" | "right";
	/** 弹层的哪条边和锚点对齐。 */
	align?: "start" | "end" | "center";
	width?: PopoverWidth;
	/**
	 * 钉在滚动正文上面——搜索框、标题。
	 *
	 * 不放进 `children`，因为它不能滚动：一用就离开屏幕的筛选框，要改它还得滚回去。
	 */
	header?: React.ReactNode;
	/** 钉在它下面，给不管列表多长都要够得着的动作。 */
	footer?: React.ReactNode;
	/**
	 * 钉在它左边——比如一列分类。
	 *
	 * 是槽位，理由和另外两个一样：跟着被筛选的列表一起滚走的筛选，要改还得滚回去。它也不能作为 sticky
	 * 的一列放在 `children` 里，因为滚动区的内容盒会裁掉横向溢出，而祖先上的任何 `overflow` 都会让
	 * `sticky` 粘在那个祖先上而不是视口上。
	 */
	aside?: React.ReactNode;
	/** 给否则会长满窗口的面一个上限——见 `MENU_MAX_HEIGHT`。 */
	maxHeight?: number;
	/**
	 * 这个面是什么，给读窗口而不是看窗口的东西。
	 *
	 * 写死成 `menu` 对大多数是对的，对不是菜单的就错了：重命名表单、一段读数、一个滑块。被播报成菜单项
	 * 的输入框，比什么都不播报更糟。
	 */
	role?: "menu" | "listbox" | "dialog" | "group";
	/** 触发元素没说清时，给这个面一个名字。 */
	label?: string;
	className?: string;
	/** 加在滚动正文上，给自己给内容加内衬的面。 */
	bodyClassName?: string;
	/**
	 * 一列行，还是一样东西。
	 *
	 * `menu` 是每个菜单要的内衬：圆角需要地方，行不能跑到滚动条底下，渐隐的边说明列表在那之外还有。
	 * 这三样对只装一块自己画底色的面板的面都是错的——比如一段 diff，它的代码底色会在离卡片右边 25px、
	 * 离顶 6px 处就停了，缝里露出浮层的底。面板读起来像嵌在一张它没填满的卡片里。
	 *
	 * `panel` 把整个正文交给内容，让叠加的滑块浮在上面，这正是叠加滚动条的用途。
	 */
	surface?: "menu" | "panel";
	/**
	 * 把悬停交给整个面，给悬停打开的弹层用。
	 *
	 * 调用方如果挂在自己传的 `header` 和 `children` 上，描边、滚动区自己的外边距、滚动条那一条和滑块都在
	 * 处理范围之外：指针从这些地方进入弹层，在调用方看来仍然在外面——待执行的关闭就跑了。抓住悬停预览的
	 * 滚动条会把它关掉。
	 */
	onMouseEnter?: () => void;
	onMouseLeave?: () => void;
}

const GAP = 8;
const MARGIN = 12;

/**
 * 退场最多等多久，之后不等 `animationend` 就关掉弹层。
 *
 * 关掉它的是退场自己的结束。用 120ms 的计时器的话，它和要等的那个 120ms 的 `.plume-pop-out` 赛跑，
 * 而且会赢：在 120Hz 屏幕上量到 Escape 在透明度 0.16 时就卸掉了菜单，淡出的最后几帧从没画出来。这里
 * 只兜事件一直不来的情况——窗口在那一帧画出来之前就被隐藏了——所以远远排在退场之后。
 */
const EXIT_FALLBACK_MS = 600;

/**
 * 弹层离窗口每条边至少多远：留白，顶上还要让开窗口的标题栏（见 `chromeTop`）。
 */
function edges(): { top: number; bottom: number; left: number; right: number } {
	return { top: Math.max(MARGIN, chromeTop() + GAP), bottom: MARGIN, left: MARGIN, right: MARGIN };
}

/**
 * 弹层属于哪一列，这样它不会溢到隔壁那一列去。
 *
 * 从输入框打开的菜单属于对话区上方。只限制在窗口里的话，一个宽菜单会跑到旁边的侧面板底下——一半
 * 被遮住，看得见的一半落在和它毫不相干的区域。布局的几列是天然的边界：触发元素在哪一列，菜单就留在
 * 哪一列（正文是 `main`，侧面板带 `.plume-panel`）。
 *
 * 点锚点（右键）时为 null，菜单在它那一列里放不下时也是——被裁掉比压在别处更糟。
 */
function columnBounds(anchor: Anchor, width: number): { left: number; right: number } | null {
	if (!(anchor instanceof HTMLElement)) return null;
	const column = anchor.closest("main, .plume-panel");
	if (!column) return null;
	const rect = column.getBoundingClientRect();
	return rect.width - 8 < width ? null : { left: rect.left + 4, right: rect.right - 4 };
}

/**
 * 所有打开着的弹层，新的一个挂载时能关掉其他的。
 *
 * 不这样的话，右键第二行时第一个菜单还留在屏幕上——更糟的是，第一个菜单待执行的退场计时器随后触发，
 * 120ms 后把*新*菜单关掉。一次只开一个，在挂载时强制，两个问题都没了。
 *
 * 「其他」指不相关的，而不只是更早的——见 `PopoverChain`。
 */
const openPopovers = new Set<PopoverHandle>();

interface PopoverHandle {
	close: () => void;
	/** 从窗口打开的弹层是 1，每嵌在一个弹层里打开就多 1。 */
	depth: number;
}

/**
 * 这个弹层所在的那些弹层，最外层在前。
 *
 * 在菜单里打开的菜单不是它的对手。比如弹层里的一棵文件树，右键其中一行打开文件菜单——那也是一个弹层，
 * 和其他弹层一样 portal 到 `<body>`。不知道两者有关系的话，挂载第二个会关掉第一个：一右键树就没了，
 * 菜单指着空处；点那个菜单的任何地方也都算点在树外面。
 *
 * 经 React 的树而不是 DOM 传：portal 移动的是元素，不是 context，所以渲染在弹层 `children` 里的任何东西
 * 仍然看得到自己在哪些弹层下面。
 */
const PopoverChain = createContext<PopoverHandle[]>([]);

export function Popover({
	anchor,
	onClose,
	children,
	placement = "top",
	align = "end",
	width,
	header,
	footer,
	aside,
	maxHeight,
	role = "menu",
	label,
	className = "",
	bodyClassName = "",
	surface: kind = "menu",
	onMouseEnter,
	onMouseLeave,
}: PopoverProps) {
	const ref = useRef<HTMLDivElement>(null);
	const [style, setStyle] = useState<React.CSSProperties>({
		opacity: 0,
		left: 0,
		top: 0,
	});
	/**
	 * 退场动画播放时为真，在通知调用方卸载之前。
	 *
	 * 在点外面的那一帧就直接消失的菜单读起来像故障；眼睛在离开时也需要进来时那样的 120ms。
	 */
	const [leaving, setLeaving] = useState(false);
	/**
	 * 弹层知道自己该去哪之前为假。
	 *
	 * 它在 0,0 挂载，量过之后才知道位置。在那之前就播入场动画，头几帧会在窗口角落播，半路才跳到锚点，
	 * 那就是那一跳。
	 */
	const [placed, setPlaced] = useState(false);
	const closed = useRef(false);
	/** 退场已经在这里播完了，之后的卸载没有什么可显示的了。 */
	const exited = useRef(false);
	const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const finish = useCallback(() => {
		if (exited.current) return;
		exited.current = true;
		clearTimeout(exitTimer.current);
		onClose();
	}, [onClose]);

	// 关闭总是先播退场。加了守卫，紧挨着的一次点击和一次 Escape 不会排两次卸载。
	const dismiss = useCallback(() => {
		if (closed.current) return;
		closed.current = true;
		setLeaving(true);
		exitTimer.current = setTimeout(finish, EXIT_FALLBACK_MS);
	}, [finish]);
	const dismissRef = useRef(dismiss);
	dismissRef.current = dismiss;

	/*
	 * 什么都不会播——不做动画的 DOM，或者没被渲染的卡片——所以没有退场可等。问卡片自己：`getAnimations`
	 * 会刷新样式，所以在浏览器里，类名刚启动的退场已经在列表里了。
	 */
	useLayoutEffect(() => {
		if (!leaving) return;
		const card = ref.current;
		if (!card || typeof card.getAnimations !== "function" || card.getAnimations().length === 0) finish();
	}, [leaving, finish]);

	/*
	 * 新的锚点意味着这个弹层被重新打开了；取消已经在进行的退场。
	 *
	 * 菜单开着时右键，`mousedown` 先于 `contextmenu` 触发。mousedown 落在菜单外面，开始退场；contextmenu
	 * 随后重新设锚点——而继续播完的退场会关掉刚打开的菜单。看起来就像右键什么也没做。
	 */
	useEffect(() => {
		closed.current = false;
		exited.current = false;
		setLeaving(false);
		clearTimeout(exitTimer.current);
	}, [anchor]);

	// 待执行的退场也不能活得比组件长。
	useEffect(() => () => clearTimeout(exitTimer.current), []);

	/*
	 * 由调用方而不是它自己关掉的——再按一次触发按钮、选中一行、离开悬停预览——弹层直接被卸载，本会在那
	 * 一帧消失。它改为留下一份副本来播退场；见 `afterimage.ts`。用 layout 清理，因为它们在 React 摘下
	 * 元素之前运行：副本取的是屏幕上的样子。
	 */
	useLayoutEffect(
		() => () => {
			if (!exited.current) leaveAfterimage(ref.current);
		},
		[],
	);

	/*
	 * 一次一个菜单，它所在的那些菜单除外。
	 *
	 * 挂载时登记，所以打开这一个会关掉不相关的、已经开着的东西，而不动它自己的祖先——在菜单里打开的
	 * 菜单是它的一部分，不是对手。
	 */
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const ancestors = useContext(PopoverChain);
	const self = useRef<PopoverHandle>({
		close: () => onCloseRef.current(),
		depth: ancestors.length + 1,
	}).current;
	const chain = useMemo(() => [...ancestors, self], [ancestors, self]);
	useLayoutEffect(() => {
		/*
		 * 它在的时候，悬停出现的东西都不出现：见 `hover-layers`。
		 *
		 * 持有再释放一个声明，而不是进来时设标志、出去时看 `openPopovers` 空了再清。那种写法嵌套也能对，
		 * 但只是因为两件独立的事碰巧一致：打开着的弹层登记得维护正确，压制状态才会正确。一个句柄不需要
		 * 这种一致——谁拿的谁还，子菜单结束不了父菜单的。
		 */
		const release = claimHoverSuppression();
		for (const other of openPopovers) {
			if (!chain.includes(other)) other.close();
		}
		openPopovers.clear();
		for (const each of chain) openPopovers.add(each);
		return () => {
			openPopovers.delete(self);
			release();
		};
	}, [chain, self]);

	// 在绘制之前量，所以挂载时这里决定的就是任何人看到的第一帧：弹层自己的尺寸决定它放不放得进
	// 锚点上方。
	useLayoutEffect(() => {
		const element = ref.current;
		if (!anchor || !element) return;

		const measure = () => {
			/*
			 * 锚点离开了文档——它那一行被删了，它的视图被换了。摘下来的元素量出来是窗口原点处的 0×0，
			 * 按它来放会把卡片甩到左上角。已经没有可指的东西了，所以它从原地离开。
			 */
			if (anchor instanceof HTMLElement && !anchor.isConnected) {
				dismissRef.current();
				return;
			}
			const a = rectOf(anchor);
			if (!a) return;
			const edge = edges();
			// 比窗口还宽的菜单挪不进视野——只能让出宽度。
			const limit = window.innerWidth - edge.left - edge.right;
			const fixed = widthOf(resolvedWidth(width, role));
			/*
			 * 先定宽度，再量——因为高度取决于它。
			 *
			 * 宽度和位置一起交出去就晚了一帧：第一次量读到的是按*固有*宽度排版的内容的高度，文字随后在
			 * 300px 处换行的卡片会比给它放好的盒子更高。放不放得进触发元素上方是按错的数决定的，错答「放得下」
			 * 的面板就落在了它所指的控件上。
			 */
			if (fixed !== undefined) element.style.width = `${Math.min(fixed, limit)}px`;
			/*
			 * 还有它将会有的高度，已经算上调用方的上限。
			 *
			 * 上限随这一轮决定的位置一起到，所以挂载时还没有，长列表按完整长度读：十五行是 596px 而上限
			 * 340，两侧都放不下，卡片被滑进窗口盖在触发元素上——随后观察者量到 340，下方放得下，菜单一帧之后
			 * 又掉到那里。打开时的缩放属于表现，所以用 offset 而不是 client rect。
			 */
			const box = { width: element.offsetWidth, height: Math.min(element.offsetHeight, maxHeight ?? Infinity) };
			const w = Math.min(fixed ?? box.width, limit);

			const fitsAbove = a.top - box.height - GAP >= edge.top;
			const fitsBelow = a.bottom + box.height + GAP <= window.innerHeight - edge.bottom;

			// 触发元素那一列有地方就留在那一列里，否则留在窗口里。
			const column = columnBounds(anchor, w);
			const minLeft = Math.max(edge.left, column ? column.left : edge.left);
			const maxLeft = Math.min(window.innerWidth - edge.right, column ? column.right : window.innerWidth - edge.right) - w;
			const clampX = (x: number) => Math.min(Math.max(minLeft, x), Math.max(minLeft, maxLeft));

			let left: number;
			/*
			 * 钉住哪条边，而不只是卡片从哪开始。
			 *
			 * 往上打开的卡片如果按 `top: anchor.top - height` 放，用的是量的时候碰巧有的高度。之后到的内容——
			 * 替换骨架行的明细——让它变高，而顶边是钉死的，它就*往下*长，盖住打开它的触发元素。改为把 `bottom`
			 * 钉在触发元素上，它就往远离它的方向长，晚到的内容移动的是远边，从不是近边。
			 */
			let anchorEdge: { top: number } | { bottom: number };
			let resolved: "top" | "bottom" | "right";
			/** 是塞进窗口里放的，而不是挂在锚点上。 */
			let shifted = false;
			/*
			 * 从哪长出来，用弹层自己的坐标。
			 *
			 * 一个关键帧从一个点放大，这个点是离触发元素最近的角——在这里算，因为只有这一轮知道面往哪翻了、
			 * 被夹了多少。每个方向写死一个 `top center` 或 `bottom center` 的话，挂在角落按钮上的右对齐菜单会
			 * 从它自己的中间长出来，读起来像凭空出现，而不是从被点的东西里出来。
			 */
			let origin: string;

			if (placement === "right" && a.width > 0) {
				// 在触发元素旁边，和它的顶边对齐，只有会跑出窗口底部时才往上挪。没地方时退到左边。
				resolved = "right";
				const fitsRight = a.right + GAP + w <= maxLeft + w;
				left = clampX(fitsRight ? a.right + GAP : a.left - GAP - w);
				const top = Math.min(Math.max(edge.top, a.top - 4), window.innerHeight - box.height - edge.bottom);
				anchorEdge = { top };
				origin = `${fitsRight ? "0px" : "100%"} ${clamp(a.top + a.height / 2 - top, 0, box.height)}px`;
			} else {
				// 点锚点（右键）或元素锚点：两侧都放不全时，按哪一侧地方更大来选上或下。
				const spaceAbove = a.top - edge.top;
				const spaceBelow = window.innerHeight - a.bottom - edge.bottom;
				resolved =
					placement === "top"
						? fitsAbove
							? "top"
							: fitsBelow
								? "bottom"
								: spaceAbove >= spaceBelow
									? "top"
									: "bottom"
						: fitsBelow
							? "bottom"
							: fitsAbove
								? "top"
								: spaceBelow >= spaceAbove
									? "bottom"
									: "top";
				left = clampX(align === "start" ? a.left : align === "center" ? a.left + a.width / 2 - w / 2 : a.width === 0 ? a.left : a.right - w);
				/*
				 * 两侧都没地方：把它滑进窗口，而不是在里面滚动。
				 *
				 * 原生菜单就是这么做的。在长文件树靠下的地方右键，打开的菜单比指针下方的空间高，也比上方的高——
				 * 答案不是给一列十一个动作加滚动条，而是把菜单往上挪到放得下。在这里滚动会把末尾的项藏到一个没人
				 * 想到需要的手势后面，而这个菜单末尾的正是破坏性的那几项。
				 *
				 * 只在*两侧*都不行时。任一侧有地方，菜单仍然挂在指针上，那是指针预期找到它的地方。
				 *
				 * 也只对菜单。滑进窗口意味着落在触发元素上面，对一列动作无害——你正要选一个，选完它就没了。面板
				 * 不是用来选的：一个预览会停在它所预览的卡片上，盖住那张卡片本来要提供的按钮。它本来就会滚动，
				 * 所以对它老实的答案是取更高的一侧、变矮一些，下面的上限会自己算出来。
				 */
				shifted = kind === "menu" && !fitsAbove && !fitsBelow && box.height + edge.top + edge.bottom <= window.innerHeight;
				anchorEdge = shifted
					? {
							top: clamp(a.bottom + GAP, edge.top, window.innerHeight - box.height - edge.bottom),
						}
					: resolved === "top"
						? { bottom: window.innerHeight - a.top + GAP }
						: { top: a.bottom + GAP };
				origin = `${clamp(a.left + a.width / 2 - left, 0, w)}px ${resolved === "top" ? "100%" : "0px"}`;
			}

			setPlaced(true);
			setStyle({
				left,
				...anchorEdge,
				// 固有宽度保持固有，只封顶，内容变化时仍会重排。
				width: fixed,
				maxWidth: limit,
				transformOrigin: origin,
				// 封顶在它被放进的那段空隙，晚到的内容在卡片里滚动，而不是把远边推出屏幕。调用方自己的
				// 上限只会把它压得更低。
				maxHeight: Math.min(
					// 滑进来放的，上限是窗口而不是它起始的那段空隙——它正是不再受那段空隙约束了。
					shifted
						? window.innerHeight - edge.top - edge.bottom
						: resolved === "top"
							? Math.max(0, a.top - GAP - edge.top)
							: resolved === "bottom"
								? Math.max(0, window.innerHeight - a.bottom - GAP - edge.bottom)
								: Math.max(0, window.innerHeight - edge.top - edge.bottom),
					maxHeight ?? Infinity,
				),
				opacity: 1,
			});
		};

		measure();
		let frame = 0;
		const schedule = () => {
			if (!frame)
				frame = requestAnimationFrame(() => {
					frame = 0;
					measure();
				});
		};
		// 晚到的内容可能在窗口尺寸不变时移动触发元素（比如一个后来才填上的地址）。
		const observer = new ResizeObserver(schedule);
		observer.observe(element);
		if (anchor instanceof HTMLElement) {
			for (let parent: HTMLElement | null = anchor; parent; parent = parent.parentElement) observer.observe(parent);
		}
		const onScroll = (event: Event) => {
			if (!(event.target instanceof Node) || !element.contains(event.target)) schedule();
		};
		window.addEventListener("resize", schedule);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", schedule);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [anchor, align, placement, width, role, maxHeight, kind]);

	// 这个弹层自己在哪一层模态上——在这里读，因为下面点外面的判断要用，画的 z-index 也再用一次。
	const overlayDepth = useContext(OverlayDepth);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			/*
			 * 最里层的先走，而且只有它走。
			 *
			 * 这些监听在捕获阶段，所以处理按最外层在先的顺序运行——也就是挂载顺序——`stopPropagation` 会让
			 * *外层*菜单吞掉按键并关闭，把里层的也一起带走。右键菜单里按 Escape 应该关掉那个菜单，把你留在
			 * 打开它的那棵树里。
			 */
			let deepest = self.depth;
			for (const other of openPopovers) deepest = Math.max(deepest, other.depth);
			if (self.depth !== deepest) return;
			event.stopPropagation();
			dismiss();
		};
		const onPointerDown = (event: MouseEvent) => {
			const target = event.target as Node;
			// 再点触发元素是它自己的切换；这里不重复处理。
			if (ref.current?.contains(target)) return;
			if (anchor instanceof HTMLElement && anchor.contains(target)) return;
			/*
			 * 在从这个弹层打开的弹层里按下，不算在这个弹层外面按下。
			 *
			 * 它们在 DOM 里是 portal 出去的兄弟，`contains` 看不出关系——元素上的层数看得出。否则在文件菜单里
			 * 选「重命名」会关掉菜单所操作的那棵树，而那一刻正是树要显示重命名的时候。
			 */
			const within = target instanceof Element ? target.closest("[data-plume-popover]") : null;
			if (within && Number(within.getAttribute("data-plume-popover")) > self.depth) return;
			/*
			 * 在这个弹层弹出的模态框上按下也不算。
			 *
			 * 和上面是同一种关系，只是隔着另一种面：在菜单里选一项会先问一句确认，而那个问题是 portal 到
			 * `<body>` 的对话框——所以 `contains` 说确认按钮在菜单外面，菜单就在它刚问出的问题底下把自己关了。
			 * 确认框是*由*菜单渲染的，于是跟着一起走了，回答在该执行前 10ms 被扔掉。屏幕上没有任何东西说这件事
			 * 没有发生。
			 *
			 * 按层数比较而不只是检测到就算，理由和弹层一样：在对话框*里面*打开的菜单，点那个对话框时仍然要关。
			 * 只有叠在这个弹层自己那一层之上的模态框，才可能是它弹出来的。
			 */
			const modal = target instanceof Element ? target.closest("[data-plume-overlay]") : null;
			if (modal && Number(modal.getAttribute("data-plume-overlay")) > overlayDepth) return;
			dismiss();
		};
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("mousedown", onPointerDown, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("mousedown", onPointerDown, true);
		};
	}, [anchor, dismiss, self, overlayDepth]);

	/*
	 * 渲染到 `<body>`，而不是写它的地方。
	 *
	 * 弹层是 `position: fixed`，按窗口坐标定位，所以它在树里的位置本不影响它出现在哪——直到某个祖先的
	 * `overflow`、`mask` 或 `transform` 裁掉它，或者成了它的包含块。属于窗口最上层的临时一层，不该是窗口里
	 * 任何东西的后代。
	 */
	return portal(
		/* 画在这里面的都在这个弹层里，所以不能关掉它。 */
		<PopoverChain.Provider value={chain}>
			<div
				ref={ref}
				role={role}
				aria-label={label}
				// 这一个嵌了几层，给上面点外面的判断用——portal 出去的兄弟只有靠它才分得清祖先和不相干的面。
				data-plume-popover={self.depth}
				onMouseEnter={onMouseEnter}
				onMouseLeave={onMouseLeave}
				// 退场自己的结束，在卡片本身上——不是入场，也不是里面某个在动的东西。
				onAnimationEnd={(event) => {
					if (closed.current && event.target === event.currentTarget && event.animationName === "plume-pop-out") finish();
				}}
				style={{ ...style, zIndex: 60 + overlayDepth * 20 + (overlayDepth ? 10 : 0) }}
				/*
				 * 在一切之上，包括侧面板。
				 *
				 * 两者同为 z-50 的话，赢的是 DOM 里靠后的那个——面板——在它附近打开的菜单就被拦腰截断。弹层是
				 * 临时的，总是属于它被打开时所在的一切之上。
				 *
				 * `no-drag`，因为在窗口标题条上方，在最上层还不够。弹层最高能到 y=12，落在标题栏（Windows/Linux）
				 * 或窗格标题栏（macOS）里，而 Electron 会把任何 `drag` 矩形里的按下交给窗口管理器，除非上面盖着一个
				 * `no-drag` 的：那里的项画出来了却按不动。洞随弹层一起走，关掉之后那一条又能拖了。
				 */
				// `line-float` 而不是 `line`：`line` 是按页面算的，画在比页面亮的浮层上是一圈暗边。
				className={`plume-menu-card [app-region:no-drag] fixed z-[60] flex flex-col overflow-hidden border border-line-float ${
					leaving ? "plume-pop-out" : placed ? "plume-pop-in" : ""
				} ${className}`}
			>
				{header && <div className="shrink-0 border-b border-line-float">{header}</div>}

				<div className={aside ? "flex min-h-0 flex-auto" : "contents"}>
					{aside && <div className="flex shrink-0 flex-col border-r border-line-float">{aside}</div>}
					{/*
					 * 应用自己的滚动区，不是 `overflow: auto`——长过它被放进的空隙的菜单，和窗口里其他每个列表一样
					 * 拿到叠加的滚动条和渐隐的边。让各菜单自己去用 `Scroller` 的话，没用的就是原生滚动条；把它变成
					 * 面的职责，答案才处处一样。
					 */}
					<Scroller
						className={`${kind === "menu" ? "plume-menu-scroll " : ""}min-h-0 min-w-0 flex-auto`}
						contentClassName={`overflow-x-hidden ${bodyClassName}`}
						/*
						 * 面板在卡片结束的地方结束。
						 *
						 * 渐隐说的是「列表在这条边之外还有」，对菜单是真的，对 diff 是假的：它自己最下面几行和横向滚动条
						 * 会溶进一张就停在那里的卡片，半看得见的滚动条读起来是渲染故障而不是边界。圆角的裁切就是边界。
						 *
						 * 钉住的 header 或 footer 旁边也不渐隐：它的细线已经标出了那条边，行再溶进就画在那里的一条线，
						 * 是把同一条边界说两遍。
						 */
						top={kind === "menu" && !header ? "fade" : "none"}
						bottom={kind === "menu" && !footer ? "fade" : "none"}
					>
						{children}
					</Scroller>
				</div>

				{footer && <div className="shrink-0 border-t border-line-float">{footer}</div>}
			</div>
		</PopoverChain.Provider>,
	);
}

function rectOf(anchor: Anchor): DOMRect | null {
	if (!anchor) return null;
	if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
	// 指针处一个零尺寸的矩形：下面每条放置规则本来就按矩形算。
	return new DOMRect(anchor.x, anchor.y, 0, 0);
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(Math.max(value, low), high);
}

/** 记下锚点元素和打开状态，每个弹层触发器都要的这一对。 */
export function usePopover() {
	const [anchor, setAnchor] = useState<Anchor>(null);
	return {
		anchor,
		open: Boolean(anchor),
		toggle: (event: React.MouseEvent<HTMLElement>) => {
			const target = event.currentTarget;
			setAnchor((current) => (current === target ? null : target));
		},
		/** 对着指定元素打开。 */
		openAt: (element: HTMLElement) => setAnchor(element),
		/** 在指针处打开——右键作用于整行，所以行不是锚点。 */
		openAtPoint: (event: React.MouseEvent) => setAnchor({ x: event.clientX, y: event.clientY }),
		close: () => setAnchor(null),
	};
}

/*
 * 从这里再导出一次，从这里 import 菜单行的调用方照常能用。
 *
 * 定义在 `Menu.tsx`；弹层是一个定好位的面，菜单是常放在上面的东西，这是一种关系，不是同一个东西。
 */
export { MenuBody, MenuFooter, MenuItem, MenuLabel, MenuSearch, MenuSeparator } from "./Menu.tsx";
