/**
 * 一个走到新值、而不是直接到达新值的数。
 *
 * token 数不是一下一下跳的——是一块一块落的。用量按消息上报，于是总数停着不动，然后一下子跳几万，
 * 格式化到一位小数之后，读起来像在两个不相干的数之间闪。数怎么都是对的；缺的是「第二个数是从第一个来的」
 * 这种感觉。
 *
 * 所以插值的是*显示*，值本身不插。这里不对上报的数做任何取整或平滑——目标永远是真实的数，也永远会到达。
 * 唯一编出来的是两个数之间的那段路。
 *
 * 有意不做成通用的动画工具。它给一步一步到达、又想看起来连续的读数用；会变的文字用 `RollingText`，
 * 真的每秒跳一次的值直接渲染就好。
 */

import { useEffect, useRef, useState } from "react";
import { motionReduced } from "../motion/reduced.ts";
import { cancelTick, requestTick } from "../motion/ticker.ts";

/** 长到读得出是在动，短到一连串更新不会排起队。 */
const TRAVEL_MS = 520;

export function useCountUp(
	target: number,
	ms = TRAVEL_MS,
	options?: {
		/**
		 * 变小时是否也走过去，而不是直接设上。
		 *
		 * 默认关，这里要紧的正是默认值：一轮之内累计数只会增长，往*下*数会显示读数从未有过的值。只在一种
		 * 情形下打开：下降和上升一样真实——同一个数按不同的时段重算，90 天 → 7 天是一个真的更小的数，
		 * 两者之间的走动正说明这两个读数是同一样东西。
		 */
		bidirectional?: boolean;
	},
): number {
	const [shown, setShown] = useState(target);
	const frame = useRef(0);
	const bidirectional = options?.bidirectional ?? false;
	/**
	 * 下一段路从哪儿起。
	 *
	 * 每帧更新而不是从 state 里读，两个原因：依赖 `shown` 的 effect 会被自己的输出重启；半路来了一个
	 * 新目标，应该从数实际走到的地方接着走，而不是弹回上一段的起点。
	 */
	const from = useRef(target);

	useEffect(() => {
		cancelTick(frame.current);

		/*
		 * 往下不是一段路，是换了一场对话。
		 *
		 * 一轮之内计数只会增长；它下降是因为这一轮结束了或换了会话。给它做动画，就是让数穿过它从未有过
		 * 的值往*下*数，对发生了什么说了假话。
		 *
		 * `bidirectional` 是例外，而且很窄：同一个读数按不同的时段重算。那时更小的数不是另一场对话——是
		 * 同一场对话，问的是更短的一段时间。
		 */
		if ((!bidirectional && target <= from.current) || target === from.current || motionReduced()) {
			from.current = target;
			setShown(target);
			return;
		}

		const begin = from.current;
		const started = performance.now();
		const step = (now: number) => {
			/*
			 * 两头都夹住，下面那头不是理论上的。
			 *
			 * 帧回调带的时间戳是*这一帧*开始的时刻，不是回调运行的时刻。主线程忙的时候——比如在排两百行
			 * diff——启动这段路的 effect 远在那一刻之后才运行，于是第一次回调的时间戳早于 `started`，
			 * `progress` 是负的。立方之后往回冲：去 200 的路上会走出 0 → −31 → −11 → 27，读起来是数坏了，
			 * 而不是在数。
			 */
			const progress = Math.min(1, Math.max(0, (now - started) / ms));
			// 和这里其他减速落定的东西同一条曲线——见 `--plume-e-out`。
			const eased = 1 - (1 - progress) ** 3;
			const value = begin + (target - begin) * eased;
			from.current = value;
			setShown(value);
			if (progress < 1) frame.current = requestTick(step);
		};

		// 按拍走，不按帧：运行行上的 token 数和正文同时在动，见 `ticker.ts`。
		frame.current = requestTick(step);
		return () => cancelTick(frame.current);
	}, [target, ms, bidirectional]);

	return shown;
}
