/**
 * 动效该不该停住。
 *
 * 放在这里而不是和主题放在一起，因为这是**动画**要问的事，而动画都在 `motion` 里。它只读文档，不读别的——
 * 没有 store、没有设置模块——所以 `@plume/ui` 里的组件用它不必伸手到某个功能里去。
 *
 * 给 CSS 表达不了的那些动画问的：此刻是不是关掉了动效。
 *
 * 样式表自己的动画由全局的 `:root[data-reduce-motion]` 规则管，可一段一步步走过中间字符串的改写是状态，
 * 不是样式——没有时长可以压短，只有帧可以不跑。在要用的那一刻读，不订阅：这些都是一次性的动画，已经开始的
 * 那个可以跑完。
 */
export function motionReduced(): boolean {
	const setting = document.documentElement.dataset.reduceMotion;
	if (setting === "on") return true;
	if (setting === "off") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
