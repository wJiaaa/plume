import { useEffect, useRef, useState } from "react";

import { motionReduced } from "./reduced.ts";
import { typingFrames } from "../lib/typing.ts";

/**
 * 一个字在屏幕上停多久，下一个才动。
 *
 * 够慢，改写读得出是改写而不是闪烁；够快，在它变成一件要等的事之前就结束了。`typingFrames` 限了步数，
 * 所以这也是「最长能有多久」的答案：26 × 26ms。
 */
const FRAME_MS = 26;

/**
 * 一个字符串一个字一个字地改写成下一个。
 *
 * 返回这一帧该显示的东西。第一个值不演——原来那里什么都没有，谈不上替换——关掉动效时的任何变化也不演。
 *
 * 做成 hook 而不是组件，因为这段字通常另有去处：侧栏把它交给 `ScrollText`，由它量字符串决定这一行悬停时
 * 滚不滚。交给它一个渲染好的元素，就是在量一个正在动的目标。
 */
export function useTypedText(text: string): string {
	const [shown, setShown] = useState(text);
	const target = useRef(text);
	/*
	 * 下一次改写从哪开始：最近一次放上屏幕的值，包括落定的那一下。
	 *
	 * 不是 `shown`。在 effect 里它是排下这次 effect 的那次渲染的值，而改写到一半来了第二个标题时，那次渲染
	 * 早于下面的落定——于是下一次改写从上上个标题开始。屏幕上这一行先落到较新的标题，然后开始删那个较旧的，
	 * 旧的又闪了回来。
	 */
	const onScreen = useRef(text);
	const show = (value: string) => {
		onScreen.current = value;
		setShown(value);
	};

	useEffect(() => {
		if (text === target.current) return;
		target.current = text;

		if (motionReduced()) {
			show(text);
			return;
		}

		const frames = typingFrames(onScreen.current, text);
		let index = 0;
		const timer = window.setInterval(() => {
			show(frames[index] ?? text);
			index += 1;
			if (index >= frames.length) window.clearInterval(timer);
		}, FRAME_MS);

		return () => {
			window.clearInterval(timer);
			/*
			 * 落到正在打向的那个值上，而不是 interval 停下的地方。
			 *
			 * 改写到一半来了**更新的**标题时会跑到这里。把打了一半的字符串留在状态里，下一次改写就会从一个从来
			 * 不是真标题的前缀开始；要是更新的值恰好是同一个，就从它自己的截断开始。
			 */
			show(text);
		};
		// 只有新目标才重新开始改写：它每设一帧就重跑一遍的话会把动画重启，而 `show` 写的东西都不该触发重跑。
		// oxlint-disable-next-line exhaustive-deps
	}, [text]);

	return shown;
}
