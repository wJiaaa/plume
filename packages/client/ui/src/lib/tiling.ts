/**
 * 平铺树的几何：几棵平铺树（停靠面板、对话分屏）共用的那一半。
 *
 * 两棵树叶子不同——一个是面板种类，一个是会话——但分支长得一样：方向、每个孩子的份额、孩子。
 * 分隔条在哪、拖到某个像素时近侧该占多少，只看分支，所以只写一份。叶子怎么排
 * 各自留在自己的域里，那部分才真的不同。
 */

export type Axis = "row" | "col";

/**
 * 容器里的一个矩形，两个轴都按 0 到 1 的比例算。
 *
 * 用比例不用像素，这里才能保持纯函数：不要元素、不要测量、不要排版，首帧之前和之后算出来一样。
 * 百分比直接写到元素上，窗口缩放由浏览器处理，这里不用重算。
 */
export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * 两个窗格之间一条能拖的边界。
 *
 * 用它所属的分支和近侧的那个孩子来标识，这正是每棵树的 `resize` 要的参数——分隔条可以直接动手，
 * 中间不用有谁再去推算它是「哪条边」的分隔条。
 */
export interface SplitterBox extends Box {
	path: number[];
	index: number;
	dir: Axis;
	/** 近侧窗格现在的份额，拖动从分隔条实际所在的地方开始。 */
	share: number;
	/** 两侧窗格份额之和，也就是这条分隔条能拖动的范围。 */
	pair: number;
	/**
	 * 这条分隔条所分开的那个分支的框。
	 *
	 * 带在这里而不是之后再查：拖这条分隔条时就是在这个参照系里量的，而产出分隔条的那一刻它已经知道了。
	 */
	split: Box;
}

/**
 * 分隔条的抓取区，跨在两个窗格的边界上。
 *
 * 和侧栏的 `ResizeHandle` 一样是 9px，理由也一样：能稳稳点中、又不至于成为一条看得见的边框的最窄宽度。
 */
export const SPLITTER_HIT = 9;

/** 键盘每按一下调多少，按份额算。按住 Shift 翻倍。 */
export const SPLITTER_STEP = 0.02;

/** 分隔条上那段握把多长：够长才读得出是握把，够短才不像边框。 */
export const GRIP_SPAN = 30;

/**
 * 比例转成 CSS。
 *
 * 要取整，但故意不取到整百分比。框是按精确的比例算的，正好铺满；低精度写进 CSS 会把算术刚合上的
 * 两格之间的缝又撑开，窗格旁边露出一道亚像素宽的窗口底色。六位小数远超任何屏幕的分辨率，又短到
 * 帧与帧之间字符串不变——这一点要紧：每帧都变的样式字符串会打断它本该在过渡的那个过渡。
 */
export const pct = (fraction: number): string => `${(fraction * 100).toFixed(6)}%`;

/**
 * 把指针位置换算成分隔条近侧窗格该占的份额。
 *
 * 参照系是分支自己的框，不是容器的。嵌套分支里的分隔条在**那个**分支的长度里移动，按整个窗口量的话
 * 速度就不对——窄列里拖不动，宽列里两头都冲出去。
 *
 * `position` 是拖动轴上的客户区坐标：横向分支是 `clientX`，纵向是 `clientY`。
 */
export function shareFromPointer(handle: SplitterBox, position: number, container: Box): number {
	const { split } = handle;
	const row = handle.dir === "row";
	const span = row ? split.width * container.width : split.height * container.height;
	if (!(span > 0)) return handle.share;

	// 分支从哪开始、指针在哪，都按分支长度的份额算。
	const origin = row ? container.left + split.left * container.width : container.top + split.top * container.height;
	const at = (position - origin) / span;
	// 分支里排在近侧窗格之前的有多少——分隔条这一侧的全部，减去它所属的那个窗格。
	const boundary = row ? (handle.left - split.left) / split.width : (handle.top - split.top) / split.height;
	return at - (boundary - handle.share);
}
