/**
 * 截图工具条画在哪，以及被拖到哪。
 *
 * 从截图浮层里拆出来的。那个组件有 17 个 `useState`，这五个（两个 state、两个 ref、一个派生位置）只服务
 * 一件事，彼此之间的来往比它们和别处的来往多得多——所以它们是一组，而剩下那个组件里再也看不到「工具条
 * 现在多宽」这种东西。
 *
 * 对外只有五样：画在哪、正在拖吗、怎么量、怎么开始拖、怎么归位。工具条自己的尺寸、手动位置、
 * 那个 `ResizeObserver`，调用方一个都不需要知道。
 */

import { clampToolbar, toolbarPosition, type Point, type Rect } from "./screenshot-geometry.ts";
import { useBarDrag } from "./useBarDrag.ts";

/**
 * 对工具条尺寸的第一次估计，第一次绘制后换成量出来的值。
 *
 * 只用来在它出现之前先摆好。故意估得接近实际——工具条现在 48pt 高，加上那两个额外的动作约 800 宽——因为估错
 * 了，工具条会在错的地方待一帧，而眼睛正跟着刚松开选区的那根指针。
 */
const TOOLBAR_SIZE = { width: 800, height: 48 };

/**
 * 粗细颜色气泡有多高，含它上方的间隙。
 *
 * 用常数而不是量：它只用来决定工具条放在选区的哪一侧，这个决定得在气泡出现之前做，而气泡是一个带内边距的
 * 盒子里的一排控件——只有那一排重新设计时这个数才会变。
 *
 * 是 48 而不是以前的 34：工具条用的是 36pt 的尺寸（见 `AnnotateToolbar`），它的气泡是一排 28pt 的控件加
 * 6pt 内边距，再加上和工具条隔开的 8pt 间隙。
 */
const PROPERTIES_HEIGHT = 48;

/** 工具条最终落在哪，以及气泡该往哪一边开。只有下面那个接口用，所以不导出。 */
type ToolbarAt = (Point & { side: "above" | "below" | "over" }) | null;

export interface ToolbarPlacement {
	/** 画在哪。`null` 表示还没有选区，也就没有工具条。 */
	at: ToolbarAt;
	/** 正在被拖动——调用方拿它改光标。 */
	dragging: boolean;
	/** 挂在工具条那个元素上的 ref 回调。 */
	measure: (el: HTMLDivElement | null) => void;
	/** 按住把手时调用，带上按下的点和当时工具条的位置。 */
	startDrag: (grab: { from: Point; origin: Point }) => void;
	/** 新一轮截图开始时调用：忘掉用户上一轮把它拖到了哪。 */
	reset: () => void;
}

/**
 * `bounds` 可以是 null。
 *
 * 组件在拿到第一帧数据之前就早返回了，而 hook 必须在那之前调用——所以这里收一个可能还不存在的
 * 屏幕尺寸。它为 null 时 `selection` 必然也是 null（没有截图就没有选区），下面那两处算位置的
 * 地方都走不到。
 */
export function useToolbarPlacement(selection: Rect | null, bounds: { width: number; height: number } | null): ToolbarPlacement {
	/**
	 * 用户把工具条放在了哪，如果挪过的话。
	 *
	 * null 表示「`toolbarPosition` 说放哪就放哪」，这是平常的情况，也是好的默认：工具条跟着选区走，落在画选区
	 * 的那只手底下。这个状态是给默认错了的时候用的——工具条正好压在要标注的东西上，选区靠近屏幕底部时会这样，
	 * 或者压在一段文字要写上去的那部分图上。
	 *
	 * 用浮层坐标，也就是和选区同一个空间。
	 */
	const {
		size,
		manual: manualAt,
		dragging,
		measure,
		startDrag,
		reset,
	} = useBarDrag((at, measured) =>
		// 留在屏幕上，上方给属性气泡留出地方。见 `clampToolbar`。
		clampToolbar(at, measured ?? TOOLBAR_SIZE, { width: window.innerWidth, height: window.innerHeight }, PROPERTIES_HEIGHT),
	);

	/*
	 * 气泡算进摆放里，不管此刻有没有打开。
	 *
	 * 只量打开的那个，选到一个带属性的工具时工具条就会跳一下——摆放在刚选了它的那根指针底下变了。不论有没有都
	 * 留出这块地方，在什么都没打开的少数情况下多几个像素的空隙，换来工具条不动。
	 */
	const placed = selection && bounds ? toolbarPosition(selection, bounds, size ?? TOOLBAR_SIZE, { height: PROPERTIES_HEIGHT }) : null;

	/*
	 * 用户挪过就放在他放的地方，否则放在它该在的地方。
	 *
	 * 自动摆放几乎总是对的——工具条跟着选区，落在画它的那只手底下——只在它看不见的那种情况下错：工具条压在
	 * 马上要标注的那部分图上，或者压在用户正拿来对照的另一个窗口上。没有哪条规矩能修好这个，因为它不能盖住的
	 * 东西不在浮层能量到的那块屏幕上。所以它能拖，拖过的工具条就不再跟着选区走。
	 *
	 * 侧还是算出来而不是存下来，因为气泡得背着离它最近的边开：拖到屏幕顶部，往上开的气泡就出去了。
	 *
	 * 手挪过的工具条也不许出屏幕。`clampToolbar` 以前只在指针按着时跑，拖动本身是老实的，之后就不管了。而工具条
	 * 在拖完之后会变宽——一选中形状「删除选中」就出现——它被放下的那个位置原样再用，多出来的宽度直接伸出右边。
	 * 改在这里按此刻量到的尺寸夹，之后的每一次变化都守得住，而不只是放下它的那一下手势。
	 */
	const manual = manualAt && bounds ? clampToolbar(manualAt, size ?? TOOLBAR_SIZE, bounds, PROPERTIES_HEIGHT) : null;
	const at: ToolbarAt = manual ? { ...manual, side: manual.y >= PROPERTIES_HEIGHT ? "above" : "below" } : placed;

	return { at, dragging, measure, startDrag, reset };
}
