/**
 * 看图器里那条标注工具栏摆在哪：默认贴着窗口底边居中，按住能拖走，拖到哪记到哪。
 *
 * 截图浮层那条有自己的一套（`useToolbarPlacement`），它跟着选区走；这里没有选区，只有一张居中的图
 * 和一扇窗。共用的是：夹在窗口里的那条规矩（`clampToolbar`），量它多大、拖到哪（`useBarDrag`）。
 *
 * 从前这一条钉死在窗口底边，理由是「没有别处可去」。可它要躲的从来不是窗口，是图：在图的下半部
 * 写字、画框时，工具栏和它上面那排粗细颜色正好压在要标的地方，挪不开就只能放大了绕着画。
 */

import { useEffect, useState } from "react";

import { clampToolbar, type Point } from "./screenshot-geometry.ts";
import { useBarDrag } from "./useBarDrag.ts";

/**
 * 工具栏在自己上方给粗细颜色气泡留出的空间，含间隙。
 *
 * 气泡总是往上开，所以拖到窗口顶部的工具栏停在这么靠下的地方，而不是把气泡挤出顶边：28pt 的控件、上下
 * 各 6pt 的内边距加描边是 42，间隙 8，再多 6 让它离边远一点。
 */
const BUBBLE = 56;
/**
 * 没被挪过时它在哪：离窗口底边这么高，和缩放控件齐平。是 12 而不是以前的 24：工具栏连同气泡现在有 100pt
 * 高，正是这几个点让 860pt 高的窗口里一张 16:9 的图底边不被气泡压住——实测在 16 时气泡就碰到了图的底边。
 */
const BOTTOM = 12;
/** 和缩放控件——这条边上唯一的另一样东西——保持多远。 */
const GAP = 12;

type Size = { width: number; height: number };

/**
 * 工具栏上一次被放在哪，给下一张打开的图用。
 *
 * 只在应用运行期间记着，不存盘：为了一张图把它挪开的人，下一张也想它待在一边；但昨天那个窗口大小下的位置，
 * 只是个猜测。
 */
let remembered: Point | null = null;

/**
 * 从障碍物上让开，走更近的那条路——挪到它上面，或者它右边——只要那条路在窗口里还放得下。
 *
 * 缩放控件在左下角。工具栏落在它上面，或者窗口窄到居中的工具栏够得着它，就是一排按钮压在另一排上：两个
 * 控件在同一处，画在上面的那个吃掉了所有本该给另一个的点击。
 */
function dodge(at: Point, bar: Size, obstacle: DOMRect, viewport: Size): Point {
	const overlaps =
		at.x < obstacle.right + GAP && at.x + bar.width > obstacle.left - GAP && at.y < obstacle.bottom + GAP && at.y + bar.height > obstacle.top - GAP;
	if (!overlaps) return at;
	const up = { x: at.x, y: obstacle.top - GAP - bar.height };
	const right = { x: obstacle.right + GAP, y: at.y };
	const fitsRight = right.x + bar.width <= viewport.width - GAP;
	const distance = (to: Point) => Math.hypot(to.x - at.x, to.y - at.y);
	return fitsRight && distance(right) < distance(up) ? right : up;
}

export interface MovableBar {
	/** 画在哪，窗口坐标；还没量到时是 null。 */
	at: Point | null;
	/** 外框的位置样式：量到之前由 CSS 居中，之后按像素摆。 */
	style: React.CSSProperties;
	/** 正在被拖：位置不加缓动，光标也这么说。 */
	dragging: boolean;
	/** 挂在装着工具栏的那个元素上的 ref 回调。 */
	measure: (el: HTMLDivElement | null) => void;
	/** 一下按住变成拖动时，`AnnotateToolbar` 调它。 */
	startDrag: (grab: { from: Point; origin: Point }) => void;
}

export function useMovableBar(avoid: React.RefObject<HTMLElement | null>): MovableBar {
	const [viewport, setViewport] = useState<Size>(() => ({ width: window.innerWidth, height: window.innerHeight }));
	const { size, manual, dragging, measure, startDrag } = useBarDrag(
		(at, measured) => (measured ? clampToolbar(at, measured, viewport, BUBBLE) : at),
		remembered,
	);

	// 窗口变小了，不能把工具栏留在外面。
	useEffect(() => {
		const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);

	useEffect(() => {
		if (!dragging && manual) remembered = manual;
	}, [dragging, manual]);

	/*
	 * 至少按像素摆过一次之后才加缓动。第一次摆放是把 CSS 居中换成同一个位置的像素值；加了缓动的话，`left`
	 * 从 50% 滑过来，而跟它配套的 transform 一下就撤了，工具栏从窗口中间扫过来。
	 */
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		if (!size || settled) return;
		const id = requestAnimationFrame(() => setSettled(true));
		return () => cancelAnimationFrame(id);
	}, [size, settled]);

	/*
	 * 量到之前，由 CSS 居中在它将要摆上的那一行。以前它藏在窗口角上等着，看图器直接打开进「编辑」时晚一帧
	 * 才量到：它上面的气泡先排在左边缘，再往中间跳 355 个点。
	 */
	if (!size) return { at: null, style: { left: "50%", bottom: BOTTOM, transform: "translateX(-50%)" }, dragging, measure, startDrag };
	// 按它最窄时的宽度居中，所以这一排多出一颗按钮时它往右长。见 `BarSize`。
	const wanted = manual ?? { x: (viewport.width - size.narrowest) / 2, y: viewport.height - BOTTOM - size.height };
	const kept = clampToolbar(wanted, size, viewport, BUBBLE);
	/*
	 * 松手之后才躲开缩放控件，拖着的时候不躲：在手底下绕着障碍物跳，会和拖动打架。松手时落在它上面，就滑开。
	 */
	const obstacle = dragging ? null : avoid.current?.getBoundingClientRect();
	const at = obstacle ? dodge(kept, size, obstacle, viewport) : kept;
	const ease = "left var(--plume-t-base) var(--plume-e-out), top var(--plume-t-base) var(--plume-e-out)";
	return { at, style: { left: at.x, top: at.y, transition: dragging || !settled ? "none" : ease }, dragging, measure, startDrag };
}
