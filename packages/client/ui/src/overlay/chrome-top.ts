/**
 * 窗口顶上有多少属于窗口自己的标题栏（`--plume-chrome-top`，有标题栏时由布局设在根元素上）。
 * macOS 没有这一条，是 0。
 *
 * 浮起来的面停在它下面。只按窗口边缘留距离的话，从对话顶部附近一行往上打开的预览会铺到工具栏上：
 * 盖住标题、按钮，以及 macOS 上拖动窗口的那一条。
 */
export function chromeTop(): number {
	if (typeof document === "undefined" || !document.documentElement) return 0;
	const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--plume-chrome-top"));
	return Number.isFinite(value) && value > 0 ? value : 0;
}
