/**
 * 弹层走后在屏幕上留一会儿的东西。
 *
 * 只有 Escape 和点外面能在弹层卸载前先通知到 `Popover`，所以只有这两种走法有退场。其他走法都是一帧
 * 就没了：再按一次触发按钮（切换把锚点设成 null）、选中一行（行调用 `onClose`）、离开悬停预览
 * （`setHover(null)`）。这些都是调用方说了算，而调用方大多写的是 `open && <Popover>`，当场就移除了。
 *
 * 与其教每个调用方等一等，不如让弹层走的时候留一份自己的副本，由副本来播退场。它是一张画，不是
 * 菜单：inert、对辅助技术隐藏、指针穿透、去掉文档里查找所依据的 id 和 role，动画结束时移除——
 * 动画结束一直不来，就靠计时器。
 */

import { motionReduced } from "../motion/reduced.ts";

/** 副本复制不出来的：canvas 是空白的，frame 和播放器会重新加载。 */
const UNCOPYABLE = "canvas, iframe, video, audio, object, embed";

/**
 * 退场 120ms（`.plume-pop-out`）的好几倍，给迟到的帧留余地。
 *
 * 只有 `animationend` 一直不来时才会走到这里——窗口在退场画出来之前就被隐藏了——那时它的任务是
 * 什么都别留下，而不是时间看着对。
 */
const FALLBACK_MS = 600;

/** 查找可能凭它找到副本的名字，或者会把它和真东西绑在一起的名字。 */
function strip(element: Element): void {
	for (const name of element.getAttributeNames()) {
		/*
		 * 连 `name` 一起去掉，是因为复制出来的选中的单选框一旦插入，会把同组里真的那个取消选中：
		 * 一张表单的画不能改动表单。
		 */
		if (name === "id" || name === "name" || name === "for" || name === "role" || name === "autofocus" || name.startsWith("aria-")) {
			element.removeAttribute(name);
		}
	}
}

/**
 * 趁 `card` 还在布局里时复制它，等 React 真的移除它之后再显示副本。
 *
 * 从弹层卸载时的清理函数里调用，那时 React 还没把元素摘下来，所以这里读到的滚动位置、还在进行的
 * 入场的透明度、每一条行内样式，都是屏幕上的样子。显不显示要等一个微任务：清理不一定是移除——
 * 严格模式会对留下来的组件跑它，`Activity` 被隐藏时也会——只有真的离开文档的卡片才需要替身。
 * 微任务仍在下一次绘制之前运行，所以不会有两者都不在的一帧。
 */
export function leaveAfterimage(card: HTMLElement | null): void {
	// 看不到退场的地方根本不复制：减少动态效果，或者没有动画的 DOM。
	if (!card?.isConnected || motionReduced() || typeof card.getAnimations !== "function") return;
	if (card.querySelector(UNCOPYABLE)) return;
	const computed = getComputedStyle(card);
	// 还没放好、已经淡出，或者没被渲染：没有能看见的离开。
	if (!(Number.parseFloat(computed.opacity) > 0.02) || card.getClientRects().length === 0) return;

	/*
	 * 它此刻在哪，退场就从哪开始。
	 *
	 * 关键帧只有 `to`，起点是副本自己的样式。入场还在放大途中、或者自己的退场走到一半时被关掉的菜单，
	 * 否则会先跳回完全不透明再淡出——这正是要去掉的那一闪。
	 */
	const opacity = computed.opacity;
	const transform = computed.transform;
	const descendants = card.querySelectorAll("*");
	// 副本从顶部开始；一个滚到一半时关掉的长列表，淡出时会跳一下。
	const offsets: [number, number, number][] = [];
	descendants.forEach((element, index) => {
		if (element.scrollTop || element.scrollLeft) offsets.push([index, element.scrollTop, element.scrollLeft]);
	});
	const parent = card.parentNode;
	const next = card.nextSibling;

	const ghost = card.cloneNode(true) as HTMLElement;
	strip(ghost);
	for (const element of ghost.querySelectorAll("*")) strip(element);
	ghost.removeAttribute("data-plume-popover");
	ghost.setAttribute("data-plume-popover-ghost", "");
	ghost.setAttribute("aria-hidden", "true");
	ghost.inert = true;
	ghost.style.pointerEvents = "none";
	ghost.style.opacity = opacity;
	ghost.style.transform = transform === "none" ? "" : transform;
	ghost.classList.remove("plume-pop-in");
	ghost.classList.add("plume-pop-out");

	queueMicrotask(() => {
		if (card.isConnected || !parent?.isConnected) return;
		parent.insertBefore(ghost, next?.parentNode === parent ? next : null);
		const copies = ghost.querySelectorAll("*");
		for (const [index, top, left] of offsets) {
			const copy = copies[index];
			if (!copy) continue;
			copy.scrollTop = top;
			copy.scrollLeft = left;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = () => {
			clearTimeout(timer);
			ghost.remove();
		};
		// 只认它自己的退场：副本里的转圈也会结束自己的动画，而且会冒泡上来。
		const onEnd = (event: Event) => {
			if (event.target === ghost) done();
		};
		ghost.addEventListener("animationend", onEnd);
		ghost.addEventListener("animationcancel", onEnd);
		timer = setTimeout(done, FALLBACK_MS);
		if (ghost.getAnimations().length === 0) done();
	});
}
