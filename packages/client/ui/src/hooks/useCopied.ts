import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 复制键按下之后那个对钩：亮一会儿，自己变回去。
 *
 * 没有这一下，复制和没复制在屏幕上长得一模一样——剪贴板是个看不见的地方，人会忍不住再按一次。
 * 各处各写一份的话，停留时长各不相同，有的卸载时不清定时器、有的压根不变回去。
 *
 * 只管对钩，不管怎么写剪贴板：渲染进程里有的走 `navigator.clipboard`，有的走主进程，而 `ui/`
 * 不调 service。写成功了再 `mark`，写失败就别亮。
 *
 * `T` 是「亮的是哪一个」：同一页上有两枚复制键（链接和口令）时，亮的只该是按下的那枚。
 */
export function useCopied<T = true>() {
	const [copied, setCopied] = useState<T | null>(null);
	const timer = useRef<number | undefined>(undefined);

	// 框可能在对钩变回去之前就被卸掉——报错界面重载就是——留着的定时器会写一个不存在的组件。
	useEffect(() => () => window.clearTimeout(timer.current), []);

	const mark = useCallback((which: T) => {
		setCopied(() => which);
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setCopied(null), CONFIRM_MS);
	}, []);
	const reset = useCallback(() => {
		window.clearTimeout(timer.current);
		setCopied(null);
	}, []);

	return { copied, mark, reset };
}

/** 对钩停留多久：够看见，短于「这是不是卡住了」。 */
const CONFIRM_MS = 1600;
