/**
 * 给一张图做标注背后的算术：一个标记是什么、撤销是什么意思、步骤编号怎么数、马赛克盖住哪些格子，
 * 以及放大时图往哪里去。
 *
 * 和组件分开放，是因为这些都可能错得截图看不出来。缩放不守住锚点，滚轮每走一格就漂一点；步骤编号
 * 存下来而不是数出来，撤掉第三个的那一刻就成了 1、2、4。两者在一张静止的图里都看不见，而它们又都是
 * 有确定答案的普通函数，所以按普通函数来测。
 *
 * 这里的每个坐标都是图片的**原始**像素。画布按这个尺寸打开、由 CSS 缩小显示，所以 3000px 截图上的
 * 标记就按 3000px 存，保存出去时和截图一样清楚。
 */

/**
 * 每个工具都画点什么。
 *
 * 没有指针工具，这是有意的。选择曾经需要它；后来在所有「放置」而非「涂抹」的工具下，每个标记都能直接
 * 拿起来——这时一个只剩「按在空处而不画」这点本事的工具，不只是多余，还会误导：它暗示碰一个已有的标记
 * 得先切到它，而实际发生的正好相反。
 */
export type Tool = "pen" | "arrow" | "line" | "rect" | "ellipse" | "step" | "text" | "mosaic";

export interface Point {
	x: number;
	y: number;
}

export interface Shape {
	tool: Tool;
	colour: string;
	/** 画笔和马赛克留下每一个点；其余的由拖动的起点和终点决定。 */
	points: Point[];
	text?: string;
	/**
	 * 用原始像素，所以和其他标记一样随图缩放：文字的字号、步骤标号的半径。
	 */
	size?: number;
	/** 仅文字：折行的栏宽，原始像素。 */
	width?: number;
	/** 仅文字：这个宽度是手拖出来的，所以改文字时保留它，不重新适配。 */
	fixed?: boolean;
	/** 仅文字：它最后有多高，从打字的那个输入框量出来。 */
	height?: number;
	/** 仅文字：文字后面的 CSS 颜色，undefined 表示没有底。 */
	background?: string;
	/**
	 * 这个标记画下时的线宽，原始像素。
	 *
	 * 记在标记上，而不是画的时候从工具条读，因为工具条管的是**接下来**画什么。按当前设置来画的话，图上
	 * 已有的每一笔都会在调粗细的那一刻跟着变——画三个箭头，觉得第四个该细一点，前三个也一起变细。文字一直
	 * 出于同一个理由保留自己的 `size`；其余工具才是例外。
	 */
	stroke?: number;
	/** 仅马赛克：画它时的格子大小和笔刷宽度。理由同上。 */
	block?: number;
	brush?: number;
}

// ---------------------------------------------------------------------------
// 选中、移动、度量
// ---------------------------------------------------------------------------

/** 每个点都平移；标记的其他东西不变。 */
export function moveShape(shape: Shape, dx: number, dy: number): Shape {
	return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
}

/** 文字上调宽度的那个手柄，它不是文字的某个点。 */
export const WIDTH_HANDLE = -1;

/** 由拖动的起点和终点决定的标记，所以两端都能拖着改大小。 */
const TWO_POINT = new Set<Tool>(["rect", "ellipse", "line", "arrow"]);
/** 其中围出一块面积的那些——所以有四个角，而不是两端。 */
const BOXED = new Set<Tool>(["rect", "ellipse"]);

/**
 * 选中标记上的手柄，原始像素。
 *
 * 只放在拖动有意义的地方：直线和箭头的两端、矩形和椭圆的四个角、文字栏的右边缘。画笔的一笔没有能代表
 * 它的点，步骤标号的大小从工具条改，所以这两种只能移动不能拖大小——给一个拖了没反应的手柄，比不给更糟。
 *
 * 矩形有全部四个角，而不只是画它时的那两个。只有两个的话，从左上角画出的矩形只能从左上角和右下角改
 * 大小：手伸向右上角——一半的时候那是离手最近的一个——那里什么也没有。下标 0 和 1 仍是那两个点；2 和 3
 * 是这两个点推出来的另外两个角。
 */
export function handlesOf(shape: Shape): { at: Point; index: number }[] {
	const first = shape.points[0];
	if (!first) return [];

	if (shape.tool === "text") {
		const width = shape.width ?? 0;
		const height = shape.height ?? (shape.size ?? 16) * 1.5;
		return [{ at: { x: first.x + width, y: first.y + height / 2 }, index: WIDTH_HANDLE }];
	}

	if (TWO_POINT.has(shape.tool)) {
		const last = shape.points[shape.points.length - 1];
		if (!last) return [];
		const ends = [
			{ at: first, index: 0 },
			{ at: last, index: 1 },
		];
		if (!BOXED.has(shape.tool)) return ends;
		return [...ends, { at: { x: last.x, y: first.y }, index: 2 }, { at: { x: first.x, y: last.y }, index: 3 }];
	}

	return [];
}

/** 把一个手柄拖到新位置。标记的其余部分不动。 */
export function resizeShape(shape: Shape, index: number, to: Point): Shape {
	const first = shape.points[0];
	if (!first) return shape;

	if (index === WIDTH_HANDLE) {
		// 窄过两三个字的栏排不下任何东西。
		const min = (shape.size ?? 16) * 2;
		return { ...shape, width: Math.max(min, to.x - first.x), fixed: true };
	}

	const points = [...shape.points];
	const last = points[points.length - 1] ?? first;
	if (index === 0) points[0] = to;
	else if (index === 1) points[points.length - 1] = to;
	// 推出来的两个角，各从两个点里取一个坐标。
	else if (index === 2) {
		points[0] = { x: first.x, y: to.y };
		points[points.length - 1] = { x: to.x, y: last.y };
	} else if (index === 3) {
		points[0] = { x: to.x, y: first.y };
		points[points.length - 1] = { x: last.x, y: to.y };
	}
	return { ...shape, points };
}

/**
 * 按住 Shift 时拖动的终点落在哪：正方形、正圆，或者整角度的直线。
 *
 * 每个绘图程序都这样用这个键，想把线拉直的人第一个想到的也是它。框取两条边里较长的那条作边长；直线
 * 吸到最近的 15°，水平、竖直和对角线都守得住，中间的角度也不至于够不着。
 */
export function constrainEnd(tool: Tool, from: Point, to: Point): Point {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (BOXED.has(tool)) {
		const side = Math.max(Math.abs(dx), Math.abs(dy));
		return { x: from.x + Math.sign(dx || 1) * side, y: from.y + Math.sign(dy || 1) * side };
	}
	if (tool === "line" || tool === "arrow") {
		const step = Math.PI / 12;
		const angle = Math.round(Math.atan2(dy, dx) / step) * step;
		const length = Math.hypot(dx, dy);
		return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
	}
	return to;
}

/**
 * 标记外面的框，只用来画选中状态，别无他用。
 *
 * 故意给得宽：它提示的是选中了什么，不是断言标记盖住了哪些像素，而一个把自己围着的东西切掉一块的框，
 * 看起来就是出错了。
 */
export function shapeBounds(shape: Shape, stroke: number): { x: number; y: number; w: number; h: number } {
	const first = shape.points[0] ?? { x: 0, y: 0 };

	if (shape.tool === "text") {
		const size = shape.size ?? 16;
		return {
			x: first.x,
			y: first.y,
			/*
			 * 只有在宽度还没量过时存下的文字才会走到这里。
			 *
			 * `fitWidth` 对着画布量真实宽度；这里没有画布，只能按字数估——每个字比半个 em 多一点，介于
			 * 拉丁字母和中日韩文字之间。怎么都比常数好：固定六个字，对两个词的文字太宽，对一句话又太窄。
			 */
			w: shape.width ?? Math.max(size * 1.6, (shape.text?.length ?? 4) * size * 0.6 + size * 0.56),
			h: shape.height ?? size * 1.9,
		};
	}

	if (shape.tool === "step") {
		const r = Math.max(12, stroke * 4.5);
		return { x: first.x - r, y: first.y - r, w: r * 2, h: r * 2 };
	}

	const xs = shape.points.map((p) => p.x);
	const ys = shape.points.map((p) => p.y);
	// 马赛克用很宽的笔刷画，其余用线宽。
	const pad = shape.tool === "mosaic" ? stroke * 6 : stroke;
	const [x1, x2] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
	const [y1, y2] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
	return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * 点下面是哪个标记，没有就是 -1。
 *
 * 从最新的往前找，所以压在最上面的赢——在看图的人眼里，指着的就是它。
 *
 * 轮廓只在轮廓上算命中，不算它围住的面积：一个矩形**围着**某样东西画，就是为了让那样东西还露着，
 * 吞掉本该点给里面的点击，等于把它的用处抵消了。文字和步骤标号是实心的，整个框都算命中。
 */
export function hitShape(shapes: Shape[], at: Point, tolerance: number): number {
	for (let i = shapes.length - 1; i >= 0; i--) {
		const shape = shapes[i];
		if (shape && hits(shape, at, tolerance)) return i;
	}
	return -1;
}

/**
 * 点下面的所有标记，最上面的在前。
 *
 * 一叠互相压着的标记能被逐个点到，靠的就是它：`hitShape` 永远回答最上面的那个，没有这个，压在底下的
 * 永远够不着。
 */
export function hitShapes(shapes: Shape[], at: Point, tolerance: number): number[] {
	const found: number[] = [];
	for (let i = shapes.length - 1; i >= 0; i--) {
		const shape = shapes[i];
		if (shape && hits(shape, at, tolerance)) found.push(i);
	}
	return found;
}

function hits(shape: Shape, at: Point, tolerance: number): boolean {
	const first = shape.points[0];
	if (!first) return false;
	const last = shape.points[shape.points.length - 1] ?? first;

	if (shape.tool === "text" || shape.tool === "step") {
		/*
		 * 标号自己的框，加一份余量——不是两份，也不是错的那一份。
		 *
		 * `shapeBounds` 收的是**线宽**，步骤标号按它定自己的大小：`max(12, stroke * 4.5)`。以前把容差传
		 * 进去，标号的半径就被余量撑大了一圈，下面的比较又再加一次容差——能拿起它的范围比看得见的圆大出
		 * 不少，明明没点中的按下也会把标号拿起来。
		 */
		const box = shapeBounds(shape, shape.stroke ?? tolerance);
		return at.x >= box.x - tolerance && at.x <= box.x + box.w + tolerance && at.y >= box.y - tolerance && at.y <= box.y + box.h + tolerance;
	}

	if (shape.tool === "pen" || shape.tool === "mosaic") {
		// 马赛克是一支宽笔刷，它的一笔比画笔的好点中。
		const reach = shape.tool === "mosaic" ? tolerance * 4 : tolerance;
		for (let i = 1; i < shape.points.length; i++) {
			const a = shape.points[i - 1];
			const b = shape.points[i];
			if (a && b && toSegment(at, a, b) <= reach) return true;
		}
		return shape.points.length === 1 && distance(at, first) <= reach;
	}

	if (shape.tool === "line" || shape.tool === "arrow") return toSegment(at, first, last) <= tolerance;

	if (shape.tool === "rect") {
		const [x1, x2] = [Math.min(first.x, last.x), Math.max(first.x, last.x)];
		const [y1, y2] = [Math.min(first.y, last.y), Math.max(first.y, last.y)];
		const edges: [Point, Point][] = [
			[
				{ x: x1, y: y1 },
				{ x: x2, y: y1 },
			],
			[
				{ x: x2, y: y1 },
				{ x: x2, y: y2 },
			],
			[
				{ x: x2, y: y2 },
				{ x: x1, y: y2 },
			],
			[
				{ x: x1, y: y2 },
				{ x: x1, y: y1 },
			],
		];
		return edges.some(([a, b]) => toSegment(at, a, b) <= tolerance);
	}

	// 椭圆：沿着从圆心出发的射线量点到曲线的距离。精确解要迭代；这是常用的近似，对手画的东西远在容差
	// 之内。
	const cx = (first.x + last.x) / 2;
	const cy = (first.y + last.y) / 2;
	const rx = Math.abs(last.x - first.x) / 2;
	const ry = Math.abs(last.y - first.y) / 2;
	if (rx < 1 || ry < 1) return toSegment(at, first, last) <= tolerance;
	const radius = Math.hypot((at.x - cx) / rx, (at.y - cy) / ry);
	if (radius === 0) return false;
	return Math.abs(radius - 1) * Math.min(rx, ry) <= tolerance;
}

/**
 * 点是否在标记自己的框里——就是选中时围着它画的那个框。
 *
 * **只**用于已经选中的标记。一样东西一旦带着看得见的框，人伸手拿的就是那个框：在框里按下去，却发现
 * 自己开始画第二个矩形而不是挪第一个，是「只认轮廓」这条规矩里最让人别扭的一点。要人瞄准 2px 的边去
 * 挪一个明明看得见的形状，不是合理的要求。
 *
 * 故意不用于没选中的标记。`hitShape` 的承诺靠这一点才守得住——矩形**围着**某样东西画，是为了让它露着；
 * 要是里面也吞点击，就没法在一个框里再做标注了。
 */
export function insideBounds(shape: Shape, at: Point, stroke: number, tolerance: number): boolean {
	const box = shapeBounds(shape, stroke);
	return at.x >= box.x - tolerance && at.x <= box.x + box.w + tolerance && at.y >= box.y - tolerance && at.y <= box.y + box.h + tolerance;
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 点到线段的最短距离——给轮廓做命中测试，全靠它。 */
function toSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = dx * dx + dy * dy;
	if (length === 0) return distance(p, a);
	// 垂足落在哪，夹在线段上，这样两端是圆的，而不是沿着直线延伸到无穷远。
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
	return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * 选中时容许偏多远，原始像素。
 *
 * 随线宽放大——一个 12px 宽的标记就按 12px 宽来瞄——又按一个图片像素占多少屏幕像素反过来缩，所以不管图
 * 怎么显示，容差都是固定的几个**屏幕**像素。图片像素里的固定容差，在 25% 下没法瞄，在 800% 下又粘得离谱。
 *
 * `scale` 是图片适配后的尺寸乘以缩放。以前只用缩放，等于假定 100% 时一个图片像素就是一个屏幕像素：
 * 一张 3000px 的截图适配进窗口只显示成三分之一大，它那 7 像素的余量到屏幕上还不到三个点宽。
 */
export function pickTolerance(stroke: number, scale: number): number {
	return Math.max(stroke, 7 / Math.max(scale, 0.01)) + stroke / 2;
}

// ---------------------------------------------------------------------------
// 文字排版
// ---------------------------------------------------------------------------

// i18n-exempt：折行规则按字符认标点和中日韩文字，不是给人读的文字。
/** 不能出现在行首的：右括号，以及结束分句、句子的标点。 */
const NO_START = /[、。，．,.;；:：!！?？)）\]］}｝」』】〕〉》〗〙〛…‥％%]/u;
/** 不能出现在行尾的：左括号。 */
const NO_END = /[(（[［{｛「『【〔〈《〖〘〚]/u;

/**
 * 不会被拆到两行的最小片段。
 *
 * 中日韩文字在任意两个字之间都能断，拉丁文字在空格处断——只是标点要粘着它的邻居：行首不能是逗号或右
 * 括号，行尾不能是左括号。打字的输入框按这些规矩折行，画布以前不管，于是一段文字可能打出来是
 * 「长的说 / 明，会在」，画出来是「长的说明 / ，会在图」——一行以逗号开头，后面每一行都错开一个字。
 */
function segments(text: string): string[] {
	const out: string[] = [];
	const push = (run: string) => {
		const last = out[out.length - 1];
		if (last !== undefined && (NO_START.test(run[0] ?? "") || NO_END.test(last.at(-1) ?? ""))) out[out.length - 1] = last + run;
		else out.push(run);
	};
	let latin = "";
	for (const ch of text) {
		// 中日韩文字哪里都能断，这是它的排法；拉丁文字在空格处断，这是它的读法。
		// i18n-exempt：按字符范围认中日韩文字，不是给人读的文字。
		if (/[　-〿぀-ヿ一-鿿＀-￯]/.test(ch)) {
			if (latin) {
				push(latin);
				latin = "";
			}
			push(ch);
		} else if (ch === " ") {
			push(`${latin} `);
			latin = "";
		} else {
			latin += ch;
		}
	}
	if (latin) push(latin);
	return out;
}

/**
 * 把文字折成放得进一栏的若干行，保留文字里已有的换行。
 *
 * 画布自己不会折行——`fillText` 一行有多长就画多长，一路画出图的边缘，文字以前就是这样。度量从外面传进来
 * 而不是从某个 context 取，这样规则不靠 DOM 也能测，输入框和画图也能共用同一个函数。
 *
 * 一段自己就比整栏还宽的片段——一个链接、一串长数字——在字与字之间断开，和输入框（`overflow-wrap`）一样；
 * 留成一整段的话，它会冲出栏宽，跑到文字底板外面。
 */
export function wrapText(measure: (line: string) => number, text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const run of segments(paragraph)) {
			if (line !== "" && measure(line + run) > maxWidth) {
				lines.push(line);
				// 造成断行的那个空格不属于任何一行。
				line = run.trimStart() === "" ? "" : run.replace(/^ +/, "");
			} else {
				line += run;
			}
			// 行尾的空格挂在栏外，和输入框里一样。
			while (measure(line.trimEnd()) > maxWidth && [...line.trimEnd()].length > 1) {
				const chars = [...line];
				let fit = 1;
				while (
					fit < chars.length &&
					measure(
						chars
							.slice(0, fit + 1)
							.join("")
							.trimEnd(),
					) <= maxWidth
				)
					fit++;
				lines.push(chars.slice(0, fit).join(""));
				line = chars.slice(fit).join("");
			}
		}
		lines.push(line);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// 历史
// ---------------------------------------------------------------------------

/**
 * 撤销和重做：一张步骤清单加一个指向它的游标，而不是两个栈。
 *
 * 两个栈的写法每次操作都要在两边之间挪条目，而且总在同一个地方把边界弄错：有可重做的步骤时提交新的，
 * 得丢掉那些重做——两个栈下这是一件要单独记住的事。这里它直接从数组切片里落出来。
 */
export interface History {
	steps: Shape[][];
	cursor: number;
}

/** 够撤销一下午的，又有上限，长时间用下来不至于留住它经历过的每一个状态。 */
const HISTORY_LIMIT = 100;

export const emptyHistory = (): History => ({ steps: [[]], cursor: 0 });

export const current = (history: History): Shape[] => history.steps[history.cursor] ?? [];

export const canUndo = (history: History): boolean => history.cursor > 0;
export const canRedo = (history: History): boolean => history.cursor < history.steps.length - 1;

export const undo = (history: History): History => (canUndo(history) ? { ...history, cursor: history.cursor - 1 } : history);

export const redo = (history: History): History => (canRedo(history) ? { ...history, cursor: history.cursor + 1 } : history);

/**
 * 记下一个新状态，丢掉游标前面的一切。
 *
 * 撤销后再画，就放弃了被撤掉的那一支——另一种做法是一棵树，而树是要用户自己去走的东西。从来没有人想要
 * 截图标注工具给他一棵树。
 */
export function commit(history: History, shapes: Shape[]): History {
	const steps = [...history.steps.slice(0, history.cursor + 1), shapes];
	const excess = steps.length - HISTORY_LIMIT;
	if (excess <= 0) return { steps, cursor: steps.length - 1 };
	// 最老的步骤从前面掉出去；游标仍指着最新的。
	const kept = steps.slice(excess);
	return { steps: kept, cursor: kept.length - 1 };
}

// ---------------------------------------------------------------------------
// 步骤编号
// ---------------------------------------------------------------------------

/**
 * 步骤标号显示几：它在所有步骤标号里排第几，画的时候现数。
 *
 * 数出来而不是存下来，所以撤掉四个里的第二个，剩下的会重新编号，而不是留下 1、3、4。标号描述的是顺序，
 * 顺序是这张清单的属性。
 */
export function stepNumber(shapes: Shape[], index: number): number {
	let n = 0;
	for (let i = 0; i <= index && i < shapes.length; i++) {
		if (shapes[i]?.tool === "step") n++;
	}
	return n;
}

// ---------------------------------------------------------------------------
// 马赛克
// ---------------------------------------------------------------------------

/**
 * 马赛克的格子大小，原始像素——粗到真能把一张脸、一串密钥遮住。
 *
 * `unit` 是图片适配后，一个屏幕像素盖住多少个图片像素，所以不管图片分辨率多少，屏幕上的颗粒都一样大。
 * 以前它是图片宽度的一个比例，这对截图是对的——截图按一个图片像素对一个设备像素显示——对别的都不对：
 * 一张 1408px 的画适配进窗口，出来是 4pt 的小方块，读起来是噪点而不是打码。
 *
 * `scale` 是粗细控件，所以颗粒能调：遮一行字和遮一整个窗口，要的方块明显不一样大。取整像素，因为它取样
 * 的那份平均过的副本每个格子只有一个像素，格子不是整数就会取到两个像素之间。
 */
export function mosaicBlock(unit: number, scale = 1): number {
	return Math.max(2, Math.round(MOSAIC_BLOCK * unit * scale));
}

/**
 * 马赛克笔刷画多宽，原始像素：屏幕上大约一行字，活儿大时由粗细控件加宽。
 */
export function mosaicBrush(unit: number, scale = 1): number {
	return Math.max(4, MOSAIC_BRUSH * unit * scale);
}

// ---------------------------------------------------------------------------
// 尺寸
// ---------------------------------------------------------------------------

/*
 * 中间那一档画出来多大，单位是图片适配后屏幕上的点。
 *
 * 从屏幕量，而不是像以前那样从图片量：以前线宽是图片宽度的 1/500、字号是五倍线宽，这条规矩是为截图写的，
 * 截图按一个图片像素对一个设备像素显示。生成的图不是：1408px 宽，适配进窗口是 1100 个点，中间档画出来
 * 是 2.3pt 的线和 11.7pt 的字——比周围的界面还小，而这张图的意义恰恰是要标得清清楚楚。
 *
 * 定在适配后的尺寸上，而不是当前缩放：在 300% 下画的标记和 100% 下画的是同一个标记，只是凑近了看。
 */
const STROKE = 4;
const TYPE = 22;
const BADGE = 14;
const MOSAIC_BLOCK = 10;
const MOSAIC_BRUSH = 32;

/** 线宽，原始像素。粗细控件直接乘上去。 */
export const strokeAt = (unit: number, weight: number): number => Math.max(1, STROKE * weight) * unit;

/**
 * 文字的字号，原始像素。
 *
 * 它长得比线慢：线粗 1.8 倍是加粗，字大 1.8 倍就成了标题。这个指数让三档落在 16、22、32 点——最小那档
 * 也高于界面本身的 14 点，低于它，图上的批注就没人读了。
 */
export const typeAt = (unit: number, weight: number): number => TYPE * weight ** 0.62 * unit;

/** 步骤标号的半径，原始像素：三档分别是 11、14、19 点。 */
export const badgeAt = (unit: number, weight: number): number => BADGE * weight ** 0.55 * unit;

/**
 * 一笔马赛克盖住哪些网格，用每个格子左上角的 `x,y` 表示。
 *
 * 吸到网格上而不是随手画，有两个理由。对齐的方块读起来是有意的打码，跟着光标走的模糊读起来是一块污渍。
 * 而且网格是幂等的：同一处涂两遍盖住的是同样的格子，紧张地来回涂的人不会比一笔画过的人涂得更深。
 */
export function mosaicCells(points: Point[], brush: number, block: number): string[] {
	const cells = new Set<string>();
	const radius = brush / 2;
	for (const point of points) {
		const left = Math.floor((point.x - radius) / block) * block;
		const top = Math.floor((point.y - radius) / block) * block;
		for (let x = left; x <= point.x + radius; x += block) {
			for (let y = top; y <= point.y + radius; y += block) {
				// 格子的中心落在笔刷里，这样一笔的末端是圆的，而不是一个在拐角处落后于光标的方头。
				if (Math.hypot(x + block / 2 - point.x, y + block / 2 - point.y) <= radius + block / 2) {
					cells.add(`${x},${y}`);
				}
			}
		}
	}
	return [...cells];
}

// ---------------------------------------------------------------------------
// 缩放
// ---------------------------------------------------------------------------

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;
/** 缩放按钮按一下；滚轮每一格用它的一部分。 */
export const ZOOM_STEP = 1.25;

export const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/**
 * 一次滚轮事件缩放多少。
 *
 * 两种手势到这里是同一种事件。触控板捏合是按着 `ctrlKey` 的滚轮，每次几个像素的增量，一秒几十次，所以
 * 那条路要灵敏。Ctrl+滚轮——Windows 和 Linux 上的缩放方式——也是按着 `ctrlKey` 的滚轮，但一格大约 100px，
 * 照捏合的灵敏度算是 e¹：一格 2.7 倍。所以任何一次事件都不许缩放得比按一下按钮还多。捏合的增量离这个
 * 上限远得很，而普通的一格本来就差不多在那儿。
 */
export function wheelZoomFactor(deltaY: number, pinch: boolean): number {
	const limit = Math.log(ZOOM_STEP);
	const exponent = -deltaY * (pinch ? 0.01 : 0.0022);
	return Math.exp(Math.min(limit, Math.max(-limit, exponent)));
}

/**
 * 绕着屏幕上的一点缩放，让那一点下面的东西留在那一点下面。
 *
 * 舞台按 `translate(offset) scale(zoom)` 绕自身中心变换，所以离中心屏幕偏移为 `v` 的点，对应内容偏移
 * `(v - offset) / zoom`。缩放变化时让它不动，就是把这个等式对新的 offset 解出来——这就是「放大你正在看的
 * 东西」和「放大正中间、再去找它」的区别。
 */
export function zoomAt(from: number, to: number, offset: Point, anchor: Point, centre: Point): { zoom: number; offset: Point } {
	const zoom = clampZoom(to);
	const ratio = zoom / from;
	const vx = anchor.x - centre.x;
	const vy = anchor.y - centre.y;
	return {
		zoom,
		offset: { x: vx - (vx - offset.x) * ratio, y: vy - (vy - offset.y) * ratio },
	};
}
