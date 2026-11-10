/**
 * 已经接上的外观偏好。只在界面里生效，记在 localStorage 里，和侧栏偏好一样；以后有了应用设置再挪过去。
 */

const FONT_SMOOTHING_KEY = "plume.fontSmoothing";

/**
 * 字体平滑：打开时用 macOS 原生的灰度抗锯齿（-webkit-font-smoothing: antialiased，见 styles.css），
 * 字形和系统里的其他应用一致；关着用 Chromium 默认的渲染。默认关。
 * 只有 macOS 认这个属性，其他平台上切了屏幕上也没有变化，所以设置页只在 macOS 上显示这一项。
 */
export function readFontSmoothing(): boolean {
	return localStorage.getItem(FONT_SMOOTHING_KEY) === "on";
}

export function setFontSmoothing(on: boolean): void {
	localStorage.setItem(FONT_SMOOTHING_KEY, on ? "on" : "off");
	applyFontSmoothing(on);
}

export function applyFontSmoothing(on: boolean): void {
	document.documentElement.toggleAttribute("data-font-smoothing", on);
}
