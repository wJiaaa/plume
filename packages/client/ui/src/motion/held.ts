import { useLayoutEffect, useState } from "react";

/**
 * 一句话至少挂多久才换下一句。
 *
 * 一段探索里 read、grep 常常一两百毫秒就来一次，来一次换一句的话，字还没读完就滚走了，整行一直在抖。
 * 650ms 是 OpenClaude Desktop（照官方 Claude 桌面端）的取值。它必须比滚进来的那段动画（`DURATION.slow`）
 * 长，否则上一句还没落定下一句就开始滚。
 */
export const HOLD_MS = 650;

/**
 * `key` 换了之后，返回的那个至少要在屏幕上待满 `ms` 才跟着换。
 *
 * 待满以前新来的几个 key 不排队：到点时直接换成那一刻最新的那个，中间的跳过。要的是每一句都读得完，
 * 不是每一句都出现过。
 *
 * 用布局副作用换，不用普通副作用：已经待满的那一下当场换掉，不先把旧的那句再画一帧。
 */
export function useHeldKey(key: string, ms = HOLD_MS): string {
	// 起点是挂上的那一刻：挂上时显示的那一句也要待满，不是一来就能被换掉。
	const [shown, setShown] = useState(() => ({ key, at: performance.now() }));
	useLayoutEffect(() => {
		if (shown.key === key) return;
		const swap = () => setShown({ key, at: performance.now() });
		const remaining = shown.at + ms - performance.now();
		if (remaining <= 0) {
			swap();
			return;
		}
		const timer = setTimeout(swap, remaining);
		return () => clearTimeout(timer);
	}, [key, shown, ms]);
	return shown.key;
}
