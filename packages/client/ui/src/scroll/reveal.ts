/**
 * 一列一行一行往后加的东西（工具卡片里的调用），新来的行从底下露出来，而不是一下子多出一截。
 *
 * 为什么不让每一行自己做高度过渡：一行隔两三百毫秒来一行时，每一行各走一条从零起步、自己停下的曲线，贴底跟随
 * 照着挪，上面整页的速度就是这些曲线排成一串——来一行顶一下、停一下。用过 340ms 的 `--plume-e-out`，量到每来一行
 * 一次「停住后猛顶」、帧间速度差 60px，人看到的是贴着底部一抖一抖。换成缓进缓出也只是把每一顶磨圆，照样一行一顿。
 *
 * 所以整列只有一个露出量：还藏在下沿以下的高度。新行整行挂上，它的高度加进露出量，再由两级串起来的临界阻尼弹簧
 * （同 `useFollowBottom` 的追赶）收回到零。来一行时两级一起加上这一截，位置、速度、加速度都不跳，行接着行连成一条
 * 平稳的长高。露出量画成这一列的负下外边距：外面那张卡片裁着溢出，卡片就只露到这么高。
 *
 * 每一帧多露出来的那一截经 `REVEAL_EVENT` 告诉贴底跟随，它当帧跟着挪：上面的内容平平地往上走，卡片下面的运行行
 * 一动不动。只说这一截而不是「我在长」：同一帧里别的长高（正文又写了一行）照样交给它的弹簧追。
 */

import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { motionReduced } from "../motion/reduced.ts";
import { windowMinimized } from "../motion/ticker.ts";
import { advance, type Spring } from "./spring.ts";

/** 行露出时每帧发一次、往上冒泡，`detail` 是这一帧多露出来的高度（px）。贴底跟随在滚动面上听，见 `useFollowBottom`。 */
export const REVEAL_EVENT = "plume:reveal-rows";

/**
 * 前一级弹簧的时间常数（毫秒），后一级取它的一半。离线按一行 33px 模拟过：隔 270ms 来一行时上移速度在 1.1–2.7px/帧
 * 之间连着变、不落到零；单独一行约半秒露完，和原来的 340ms 过渡加上淡入差不多。再软，最后一行露完拖得太久；再硬，
 * 行与行之间又会停住（50ms 时最低落到 0.56px/帧）。
 */
const REVEAL_TAU = 70;

/**
 * 给这一列挂上露出：返回的 ref 放在行的直接父元素上，它的子元素和 `keys` 按顺序一一对应；外面要有一层裁着溢出。
 * 挂上时已有的行原样出现，之后才来的露出来。减少动态效果、窗口最小化时直接出现。
 */
export function useRevealRows<T extends HTMLElement>(keys: readonly string[]): RefObject<T | null> {
	const body = useRef<T>(null);
	const seen = useRef<Set<string> | null>(null);
	/** 两级弹簧（`shown` 跟着 `ramp`），眼下实际藏着的高度（取整过的，见 `hide`），在跑的那一帧。 */
	const motion = useRef({ ramp: { at: 0, speed: 0 } as Spring, shown: { at: 0, speed: 0 } as Spring, hidden: 0, frame: 0 });

	// 没有依赖：每次提交都看有没有新来的行。在布局之后、绘制之前藏起来，新行挂上的那一帧卡片一点不长。
	useLayoutEffect(() => {
		const el = body.current;
		if (!el) return;
		const known = seen.current;
		if (!known) {
			seen.current = new Set(keys);
			return;
		}
		let added = 0;
		keys.forEach((key, index) => {
			if (known.has(key)) return;
			known.add(key);
			// 藏着（`Activity`）时量到零，不用露。
			added += el.children[index]?.getBoundingClientRect().height ?? 0;
		});
		if (added <= 0 || motionReduced() || windowMinimized()) return;
		const state = motion.current;
		state.ramp.at += added;
		state.shown.at += added;
		// 新行挂上的这一帧藏起它的整个高度：卡片的高度和上一帧一样，没有长高要报。照原样加上、不重新取整到物理像素：
		// 重新取整会让卡片多出或少掉半个像素，这一截没人报，运行行每来一行就跳一个物理像素（量到过）。之后每帧照常取整。
		state.hidden = Math.min(state.hidden + added, el.getBoundingClientRect().height);
		el.style.marginBottom = `${-state.hidden}px`;
		if (state.frame) return;

		const omega = 1 / REVEAL_TAU;
		let last = 0;
		const step = (now: number) => {
			state.frame = 0;
			if (!el.isConnected) return;
			// 第一帧没有上一帧可比，按一帧算；切到后台回来的那一帧夹住，不一步跳完。
			const dt = last ? Math.min(50, Math.max(0, now - last)) : 16;
			last = now;
			advance(state.ramp, 0, omega, dt);
			advance(state.shown, state.ramp.at, 2 * omega, dt);
			const done = state.shown.at < 0.5 && state.ramp.at < 0.5;
			if (done) {
				state.ramp = { at: 0, speed: 0 };
				state.shown = { at: 0, speed: 0 };
			}
			const before = state.hidden;
			state.hidden = hide(el, state.shown.at, before);
			if (before !== state.hidden) el.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true, detail: before - state.hidden }));
			if (!done) state.frame = requestAnimationFrame(step);
		};
		state.frame = requestAnimationFrame(step);
	});

	useEffect(() => {
		const state = motion.current;
		return () => cancelAnimationFrame(state.frame);
	}, []);

	return body;
}

/**
 * 把下面 `hidden` 这么高藏到外层的裁剪之外；不超过这一列自己的高度。返回实际藏了多少。
 *
 * 每帧只改整像素：浏览器拿取过整的内容高度定最大滚动位置，跟着底部时位置就夹在那里。露出量每帧带着不同的小数，
 * 真正的末尾和夹住的位置每帧差得不一样，卡片下面的运行行在两个物理像素之间来回跳（取整到物理像素时量到 44.1–45.2px
 * 之间晃、一停一跳 47 次）。小数部分只在新行挂上时变一次（见上面），之后整像素地收。
 */
function hide(el: HTMLElement, hidden: number, current: number): number {
	const want = Math.min(hidden, el.getBoundingClientRect().height);
	// 收完了：连那点小数一起放掉。
	const amount = want <= 0 ? 0 : Math.max(0, current - Math.round(current - want));
	el.style.marginBottom = amount > 0 ? `${-amount}px` : "";
	return amount;
}
