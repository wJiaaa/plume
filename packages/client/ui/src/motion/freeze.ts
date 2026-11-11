/**
 * 拖动期间一动不动。
 *
 * 有几个元素会缓动到新的几何位置上，布局自己变的时候这是对的，指针在拖边界的时候就错了：每一帧开始的
 * 过渡都被下一帧盖掉，窗格追着指针跑而不是跟着它，永远落不稳。
 *
 * 冻结原先是 `<html>` 上的一个标记加上以它为键的规则——`:root[data-resizing] *`。读起来顺，却是拖动时
 * 最贵的一件事。在一个 8,948 条消息、屏上 8,585 个元素的真实会话里量的：
 *
 *   设 data-dock-dragging   94ms      （通配选择器）
 *   设 data-dock-dragging   44ms      （收窄到 `:root[data-…] .plume-dock-pane` 之后）
 *   设一个无关属性            0ms      （对照）
 *
 * 收窄选择器不够，中间那行就是原因。祖先上的属性仍然要对它下面的整棵子树求一遍，所以根上的标记是对整份
 * 文档提的问题，不管答案最后多具体——而一次拖动进出各要翻两三个这样的标记。抓住东西那一刻的卡顿就是它：
 * 不是布局，不是 React，是一个属性。
 *
 * 所以改成点名。`.plume-freeze` 标出拖动真正会改变几何的那些元素——窗格、侧栏所在的框、高度跟着放得下
 * 多少走的折叠组——这里只给它们加标记，样式引擎经类索引就能找到，不用遍历任何东西。
 */

/** 拖动时要定住的：窗格，以及任何要求跟它们一起定住的东西。 */
const FREEZABLE = ".plume-dock-pane, .plume-freeze";

/**
 * 用属性，不用类，而且这不是风格问题。
 *
 * 这些元素的 `className` 归 React 管，它渲染的字符串一变就整条重写。手加上去的类会被这次重写悄悄抹掉，
 * 它正定住的窗格就在手势中途被放开——然后缓动进一个本该直接跳过去的布局，又一次错误的漂移。
 *
 * React 不碰它没被给过的属性，所以这个属性活得过渲染。
 */
const FROZEN = "data-plume-frozen";

/**
 * 把会动的部分定住，交回解冻的办法。
 *
 * 元素在开始时收集一次。一次拖动就几百毫秒，这期间集合不变：停靠区重排是挪已经存在的窗格，这正是窗格放下
 * 之后还留着自己的终端的原因。
 *
 * 所以还不存在的窗格不归这里管，这是有意的——需要它的只有「采用一份保存的布局」这一种情况，那里用根上的
 * 标记，代价也只在那里值得付。
 *
 * 带引用计数，因为日常使用里会有两次重叠：把侧栏的边拖得够远会改变窗口内容区的大小，而窗口缩放也会冻结。
 * 没有计数的话，第一次释放会在第二次拖动中途解冻，这正是它要防的抖动。
 */
let held = 0;
let frozen: Element[] = [];

/**
 * 拒绝拖动本来会开始的文字选择。
 *
 * `user-select: none` 是显而易见的办法，在这里却是错的：这个属性会继承，设在 `<html>` 或 `<body>`
 * ——正文之上的任何地方——会让它下面每个元素继承来的样式都失效。在真实会话里量到每次拖动 49ms，
 * 就为了表达一个被拒绝的事件白给就能说清的事。
 */
const refuseSelection = (event: Event) => event.preventDefault();

export function freezeMotion(): () => void {
	if (held === 0) {
		frozen = [...document.querySelectorAll(FREEZABLE)];
		for (const element of frozen) {
			// 分隔条或窗口缩放立即接管，包括正在合成器里飞的那一段。
			for (const surface of [element, ...element.querySelectorAll(":scope > [data-dock-motion], :scope > .plume-dock-chrome [data-dock-heading]")]) {
				for (const motion of surface.getAnimations()) {
					if (motion.id === "plume-dock-geometry") motion.finish();
				}
			}
			element.setAttribute(FROZEN, "");
		}
		document.addEventListener("selectstart", refuseSelection);
	}
	held++;

	let released = false;
	return () => {
		// 幂等：StrictMode 下 effect 的清理可能跑两次，而一次在组件卸载时结束的拖动，否则会为一次冻结减两次。
		if (released) return;
		released = true;
		held--;
		if (held > 0) return;
		for (const element of frozen) element.removeAttribute(FROZEN);
		frozen = [];
		document.removeEventListener("selectstart", refuseSelection);
	};
}
