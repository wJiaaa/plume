/**
 * 时长和曲线，给读不到 CSS 变量的代码用。
 *
 * 以 CSS 为准——`@plume/styles` 的 theme.css 定义它们，每张样式表都读那里。这个文件是给少数几个由
 * JavaScript 驱动的动画的：一个要比过渡活得久的 `setTimeout`，一次要缓动字符串的 Web Animations 调用。
 *
 * 一个数写两份恰恰是最会漂开的安排，所以改了一处，另一处必须一起改。
 *
 * 档位按**什么在动**分，不按它有多重要：
 *
 *   quick   一个状态，不是一个位置——悬停、按下、手指底下变的颜色
 *   base    在移动或改变大小的东西：一个窗格、滑块的把手、一列让出宽度
 *   slow    原来不在、现在到来的东西——一段展开
 *
 * 曲线说的是东西往哪个方向去。`out` 减速落定，到来的东西看上去是停稳了而不是被卡住；`in` 是它的镜像，
 * 给离开的东西。
 */

/** 毫秒。和 `--plume-t-*` 同一组数。 */
export const DURATION = {
	quick: 150,
	base: 220,
	slow: 340,
} as const;

/** 和 `--plume-e-*` 同一组字符串。 */
export const EASING = {
	out: "cubic-bezier(0.22, 1, 0.36, 1)",
	in: "cubic-bezier(0.55, 0, 1, 0.45)",
	soft: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;
