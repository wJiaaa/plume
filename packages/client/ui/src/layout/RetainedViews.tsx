import { Activity, useEffect, useLayoutEffect, useRef, useState } from "react";

import { motionReduced } from "../motion/reduced.ts";
import { DURATION, EASING } from "../motion/tokens.ts";

/** 留住少数几个看过的页面；藏起来的页面暂停 effect，保留局部状态。 */
export function RetainedViews<T extends string>({
	active,
	render,
	limit = 3,
	pageClassName = "plume-page-enter",
	slide,
}: {
	active: T;
	render: (key: T) => React.ReactNode;
	limit?: number;
	/** 到达时的类。不同的页面可以换一种更长的淡入加升起。 */
	pageClassName?: string;
	/**
	 * 标签，按标签条上的顺序：每次切换，新页面从它所在的那一侧滑进来并淡入，而不是一帧之内换掉。
	 *
	 * 用 Web Animations API 在布局 effect 里播，不用类。用类的话——见下面 `seen` 的注释——从 `display: none`
	 * 回来的页面会先在终点画一帧，动画才接上。布局 effect 在页面显示之后、任何东西画出来之前跑，所以谁看到的
	 * 第一帧都已经是滑入的第一帧。回到一个页面也播：标签条是来回切的地方，只在第一次有动画的切换，第二次读起来
	 * 就像坏了。
	 */
	slide?: readonly T[];
}) {
	const [recent, setRecent] = useState<T[]>([active]);
	/*
	 * 这一页是头一回露面，还是回来了。
	 *
	 * `Activity` 收起一页用的是 `display: none`，内容、滚动位置、局部状态全留着。所以回到一个
	 * 看过的章节，它本来就在那里——该做的是恢复，不是重演一遍进场。不分的话，回去时内容先
	 * 画在终点、下一帧被拽回起点再滑回来，逐帧量是 44 → 50 → 44，一次掉头，人眼看见的就是「内容
	 * 跳了一下」。
	 *
	 * 在 effect 里记，不在 render 里记：render 期间写这个 ref，严格模式的第二遍就会把「头一回」
	 * 吃掉，动画一次也播不出来。
	 */
	const seen = useRef<Set<T>>(new Set([active]));
	const fresh = !seen.current.has(active);
	useEffect(() => {
		seen.current.add(active);
	}, [active]);
	const pages = useRef(new Map<T, HTMLDivElement>());
	/** 上过屏的页面元素。再次轮到它时，它是从 `display: none` 里回来的，而不是新挂上的。 */
	const shownBefore = useRef(new WeakSet<HTMLDivElement>());
	const previous = useRef(active);
	useLayoutEffect(() => {
		const from = previous.current;
		previous.current = active;
		const page = pages.current.get(active);
		if (!page) return;
		const returning = shownBefore.current.has(page);
		shownBefore.current.add(page);
		if (from === active) return;
		const frame = returning ? requestAnimationFrame(() => finishReplayedAnimations(page)) : 0;
		const stop = () => cancelAnimationFrame(frame);
		if (!slide || motionReduced()) return stop;
		// 从新标签所在的那一侧来：沿着标签条往右，页面就从右边进来。
		const direction = Math.sign(slide.indexOf(active) - slide.indexOf(from)) || 1;
		page.animate(
			[
				{ opacity: 0, transform: `translateX(${direction * 14}px)` },
				{ opacity: 1, transform: "none" },
			],
			{ duration: DURATION.base, easing: EASING.out },
		);
		return stop;
	}, [active, slide]);
	let keys = recent;
	if (recent[recent.length - 1] !== active) {
		keys = [...recent.filter((key) => key !== active), active].slice(-limit);
		setRecent(keys);
	}
	const shown = [active, ...keys.filter((key) => key !== active)];
	return (
		<>
			{shown.map((key) => (
				<Activity key={key} mode={key === active ? "visible" : "hidden"}>
					<div
						ref={(node) => {
							if (node) pages.current.set(key, node);
							else pages.current.delete(key);
						}}
						className={`${pageClassName} flex min-h-0 min-w-0 flex-1 flex-col`}
						data-view={key}
						data-active={key === active ? "true" : "false"}
						data-fresh={key === active && fresh ? "true" : "false"}
					>
						{render(key)}
					</div>
				</Activity>
			))}
		</>
	);
}

/**
 * 回来的那一页，里面的 CSS 动画不重演。
 *
 * `display: none` 一撤，页面里挂着动画 class 的元素按规范会把动画从头再播一遍。那些动画说的都是
 * 「刚刚发生」：回复写完时底下那行操作从 0 长到 24px、排队的消息展开、头像做一次表情。回到一段
 * 早就在那里的对话，什么也没刚发生——可那一行每次切回都重新长一遍，整条回复跟着跳 38px。
 *
 * 在下一帧画出来之前做，不在显示它的那次提交里做。藏着的页面不跟 store 同步（订阅也是 effect，
 * 跟着一起拆了），离开期间写完的回复要等回来、订阅重新挂上才补进来——那是紧跟着的另一次提交，
 * 当场处理会漏掉它，而它同样是在补账，不是此刻发生的事。两次提交都落在第一帧之前，逐帧量过。
 *
 * 页面自己那层（`pageClassName`）不算：那是换页本身的到达动画，每次换页都该有。转圈、呼吸这种
 * 没有终点的照常跑——它们也没法跳到终点，`finish()` 会抛错。
 */
export function finishReplayedAnimations(page: HTMLElement): void {
	for (const animation of page.getAnimations({ subtree: true })) {
		// 只认 CSS 动画：`animate()` 起的（比如上面的滑入）不会因为 display 而重播。
		if (!("animationName" in animation)) continue;
		const effect = animation.effect as KeyframeEffect | null;
		if (!effect || effect.target === page) continue;
		if (Number.isFinite(effect.getComputedTiming().endTime)) animation.finish();
	}
}
