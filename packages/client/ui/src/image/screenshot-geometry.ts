/**
 * 选区在哪、它的手柄在哪、工具条能放在哪。
 *
 * 和浮层分开，是因为这些全是不带 React 的算术——所以能测，而那些容易错得很隐蔽的规矩（手柄报的是你没按的
 * 那个角、拖动把矩形翻成负的、工具条跑出屏幕）正是值得测、而不是靠点来点去发现的。
 */

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}

/**
 * 八个方向，按 CSS 光标的叫法命名。
 *
 * 角在前，这样顺着这张表做的命中测试在角和边重叠的地方优先认角——它们总是重叠，而指针瞄的就是角。
 */
export const HANDLES = ["nw", "ne", "se", "sw", "n", "e", "s", "w"] as const;

export type Handle = (typeof HANDLES)[number];

/** 每个手柄该显示的光标：它的名字加上 CSS 要的后缀。 */
export const HANDLE_CURSOR: Record<Handle, string> = {
	nw: "nwse-resize",
	se: "nwse-resize",
	ne: "nesw-resize",
	sw: "nesw-resize",
	n: "ns-resize",
	s: "ns-resize",
	e: "ew-resize",
	w: "ew-resize",
};

/** 手柄在哪，表示为选区边上的一个点。 */
export function handlePoint(rect: Rect, handle: Handle): Point {
	const midX = rect.x + rect.width / 2;
	const midY = rect.y + rect.height / 2;
	const right = rect.x + rect.width;
	const bottom = rect.y + rect.height;
	switch (handle) {
		case "nw":
			return { x: rect.x, y: rect.y };
		case "n":
			return { x: midX, y: rect.y };
		case "ne":
			return { x: right, y: rect.y };
		case "e":
			return { x: right, y: midY };
		case "se":
			return { x: right, y: bottom };
		case "s":
			return { x: midX, y: bottom };
		case "sw":
			return { x: rect.x, y: bottom };
		case "w":
			return { x: rect.x, y: midY };
	}
}

/**
 * 指针在哪个手柄上，没有就是 null。
 *
 * `tolerance` 是屏幕像素的半径，而不是手柄画出来的大小：目标得比记号大，理由和滚动条一样——八个像素见方
 * 的一块，手落不准。
 */
export function hitHandle(rect: Rect, at: Point, tolerance: number): Handle | null {
	for (const handle of HANDLES) {
		const point = handlePoint(rect, handle);
		if (Math.abs(at.x - point.x) <= tolerance && Math.abs(at.y - point.y) <= tolerance) return handle;
	}
	return null;
}

/** 点是否在选区里——在里面按下是移动，而不是重新拖一个。 */
export function insideRect(rect: Rect, at: Point): boolean {
	return at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height;
}

/** 由两个角得到矩形，两个角哪个在前都行。 */
export function rectFromPoints(a: Point, b: Point): Rect {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		width: Math.abs(a.x - b.x),
		height: Math.abs(a.y - b.y),
	};
}

/**
 * 把一个手柄拖到某点之后的选区。
 *
 * 写成「挪动这个手柄管的那几条边，再规范化」，所以拖过对边时矩形会翻过来，而不是得到负的宽度——这是人在
 * 其他任何地方改大小时预期的样子，`rectFromPoints` 本来就是这么写的。
 */
export function resizeRect(rect: Rect, handle: Handle, to: Point): Rect {
	let { x: left, y: top } = rect;
	let right = rect.x + rect.width;
	let bottom = rect.y + rect.height;

	if (handle.includes("n")) top = to.y;
	if (handle.includes("s")) bottom = to.y;
	if (handle.includes("w")) left = to.x;
	if (handle.includes("e")) right = to.x;

	return rectFromPoints({ x: left, y: top }, { x: right, y: bottom });
}

/** 选区平移一段，保持完整、保持在屏幕里。 */
export function moveRect(rect: Rect, dx: number, dy: number, within: { width: number; height: number }): Rect {
	/*
	 * 夹住而不是截掉：把选区拖出边缘，应该停在边上、大小不变，而不是缩小。低的一侧 `Math.max(0, …)`，
	 * 高的一侧是屏幕尺寸减去选区，正是这个意思。
	 */
	const x = Math.min(Math.max(0, rect.x + dx), Math.max(0, within.width - rect.width));
	const y = Math.min(Math.max(0, rect.y + dy), Math.max(0, within.height - rect.height));
	return { ...rect, x, y };
}

/** 选区裁到屏幕以内，给拉过了边的改大小用。 */
export function clampRect(rect: Rect, within: { width: number; height: number }): Rect {
	const left = Math.max(0, rect.x);
	const top = Math.max(0, rect.y);
	const right = Math.min(within.width, rect.x + rect.width);
	const bottom = Math.min(within.height, rect.y + rect.height);
	return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** 工具条离选区多远，离屏幕边多远。 */
const TOOLBAR_GAP = 12;
const SCREEN_MARGIN = 12;

/**
 * 工具条放在哪：选区下方，和它的左边对齐。
 *
 * 左对齐，因为第一个控件是最常按的，也因为从选区起点开始的工具条读起来属于它——把工具条右对齐到一个比它
 * 窄的选区，会把控件推离它们作用的东西。
 *
 * 下面放不下就翻到上面，并且沿着边滑动而不是挂出去。这两样都很平常；不平常的是一块矮屏幕最底下的选区，
 * 两边都放不下——那时它放进选区里面、贴着底，那是唯一剩下的地方。
 */
/**
 * 工具条放在哪，以及最后落在选区的哪一侧。
 *
 * 这一侧不是装饰：工具条打开的任何东西——比如粗细和颜色的气泡——都得**背着**选区开，不然就盖住了正要标注
 * 的东西。只有这个函数的调用方知道是哪个方向，所以把它返回出去，而不是让下游去猜。
 */
export interface ToolbarPlacement extends Point {
	/** `over` 表示两侧都放不下，工具条压在选区上面。 */
	side: "below" | "above" | "over";
}

export function toolbarPosition(
	rect: Rect,
	viewport: { width: number; height: number },
	toolbar: { width: number; height: number },
	/**
	 * 工具条打开的气泡有多高，如果它会打开一个的话。
	 *
	 * 以前放工具条时当它是唯一要放得下的东西，而粗细颜色气泡开在比工具条**更远**离选区的地方——所以一个
	 * 拉到屏幕底部的选区，把工具条放进了最后一条放得下的地方，气泡就落在那下面，整个到了屏幕外。能看见的
	 * 只有底边上一排像素。
	 *
	 * 两侧都把它算进这一摞里：只有工具条**和**它打开的东西都落在屏幕上，这一侧才算放得下。
	 */
	bubble: { height: number } = { height: 0 },
): ToolbarPlacement {
	const extra = bubble.height > 0 ? TOOLBAR_GAP + bubble.height : 0;
	const stack = toolbar.height + extra;
	const below = rect.y + rect.height + TOOLBAR_GAP;
	const above = rect.y - toolbar.height - TOOLBAR_GAP;

	let y: number;
	let side: ToolbarPlacement["side"];
	if (below + stack <= viewport.height - SCREEN_MARGIN) {
		y = below;
		side = "below";
	} else if (above - extra >= SCREEN_MARGIN) {
		y = above;
		side = "above";
	} else {
		/*
		 * 两侧都放不下整摞，所以工具条压在选区上——放得够高，让这时往上开的气泡还有地方去。
		 */
		y = Math.max(SCREEN_MARGIN, viewport.height - toolbar.height - SCREEN_MARGIN);
		// 两侧都放不下，工具条就在选区本身上面，不存在「背着选区」的那一侧了。
		side = "over";
	}

	/*
	 * 和选区右对齐，再夹在屏幕里。
	 *
	 * 工具条最后是收尾的两个控件——取消和确认——把它的右边和选区的右边对齐，就把这两个按钮放在刚松开拖动的
	 * 那只手底下，而拖动通常结束在右下角。左对齐的话，这两个按钮离手势结束的地方有一整条工具条那么远。
	 */
	const x = Math.min(Math.max(SCREEN_MARGIN, rect.x + rect.width - toolbar.width), Math.max(SCREEN_MARGIN, viewport.width - toolbar.width - SCREEN_MARGIN));
	return { x, y, side };
}

/**
 * 被手拖动的工具条允许停在哪。
 *
 * 上面的自动摆放几乎总是对的，只在它看不见的那种情况下错：工具条盖住了正要标注的那部分图。所以它能被挪开，
 * 挪过之后还作数的只剩这一条——它得始终够得着。
 *
 * `bubbleHeight` 是它上方留出的空间，因为只要工具条不贴着屏幕顶，属性气泡就往上开。不留的话，拖到紧贴顶边，
 * 气泡开到屏幕外，手里那个工具的粗细和颜色就够不着了。
 *
 * 两个界限冲突时低的那个赢，这发生在比工具条加边距还矮的视口里。出了底边还能救回来——工具条还在拖它的
 * 指针底下；出了顶边就救不回来了，屏幕上方没有地方能把它拖回来。
 */
export function clampToolbar(at: Point, toolbar: { width: number; height: number }, viewport: { width: number; height: number }, bubbleHeight = 0): Point {
	const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
	return {
		x: clamp(at.x, SCREEN_MARGIN, viewport.width - toolbar.width - SCREEN_MARGIN),
		y: clamp(at.y, Math.max(SCREEN_MARGIN, bubbleHeight), viewport.height - toolbar.height - SCREEN_MARGIN),
	};
}
