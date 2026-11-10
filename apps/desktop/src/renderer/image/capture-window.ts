import type { UiContext } from "@plume/contract/ui";

let captures = 0;
const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** 浮动导航和通知不属于被复制的内容；跨进程截图前让合成器画完隐藏后的两帧。 */
export const captureWindow: UiContext["captureWindow"] = async (rect) => {
	captures++;
	document.documentElement.setAttribute("data-capturing-window", "");
	try {
		await paint();
		await paint();
		return await window.plume.captureWindow(rect);
	} finally {
		if (--captures === 0) document.documentElement.removeAttribute("data-capturing-window");
	}
};
