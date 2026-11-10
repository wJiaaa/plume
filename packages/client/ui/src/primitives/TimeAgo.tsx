/**
 * 一段会自己跟上的时长。
 *
 * 14:02 写进 DOM 的「刚刚」到 14:40 还是「刚刚」——要是没有东西在屏幕上待那么久，这算公平。一个自己会
 * 刷新的列表改变了这一点：行在底下更新，旁边的时长却不动，一行里唯一纯粹取决于时钟的部分成了唯一错的部分。
 *
 * 所有实例共用一个定时器，放在模块作用域里，只在有东西挂着时运行。一拍只重渲染这些标签——行本身按数据
 * 记忆化，数据没变——所以让六十个时长保持准确，代价是每分钟六十个文本节点。
 */

import { useSyncExternalStore } from "react";
import { useI18n } from "../i18n/index.ts";
import { exactTime, shortRelativeTime } from "../lib/relative-time.ts";

/**
 * 显示的最小单位的一半，这样什么都不会落后整整一个单位。
 *
 * 标签按分钟取整；每三十秒一拍，最坏情况是标签落后半分钟，读不出是错的。
 */
const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let now = Date.now();
let timer = 0;

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (!timer) {
		timer = window.setInterval(() => {
			now = Date.now();
			for (const each of listeners) each();
		}, TICK_MS);
	}
	return () => {
		listeners.delete(listener);
		// 屏幕上什么都没有，就没什么要保持准确的：定时器停下，而不是在窗口的整个生命期里对着一个空集合跳。
		if (listeners.size === 0 && timer) {
			window.clearInterval(timer);
			timer = 0;
		}
	};
}

export function TimeAgo({ iso, className = "" }: { iso: string; className?: string }) {
	const at = useSyncExternalStore(subscribe, () => now);
	// 在这里读，而不是交给 `activeLocale()`：周围的行是记忆化的，不这样的话切换语言要等到下一拍才到达标签。
	const { resolvedLocale } = useI18n();

	return (
		<span className={`tabular-nums ${className}`} data-plume-tip={exactTime(iso, resolvedLocale)}>
			{shortRelativeTime(iso, at)}
		</span>
	);
}
