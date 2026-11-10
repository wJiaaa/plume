/**
 * Windows、Linux 上系统画在页面右上角的最小化、最大化、关闭，颜色由页面交给主进程（main/window-overlay.ts）。
 *
 * 底色取那条带子此刻真画出来的颜色，不另算一遍：主题、用户配色、皮肤都能改它，从画出来的地方量才不会两边对不上——
 * 对不上的后果是带子右端浮出一块深浅不同的补丁。符号色取 `ink-muted`。遮罩（对话框、看图器）压暗整个窗口时，系统按钮
 * 不在页面里、盖不住，所以把颜色和遮罩混一遍再送，遮罩走了再送回原样（见 @plume/ui 的 scrims.ts）。
 */

import { heldScrims, onScrimsChange } from "@plume/ui";
import { type RefObject, useEffect } from "react";
import { useAppearance, useManagedSkin } from "./appearance-settings.ts";
import { type OverlayColors, tintedOverlay, toHex } from "./window-overlay-colors.ts";

/**
 * 带子挂着时一直替它报颜色。`header` 是带子本身，`symbol` 是一个藏着的、字色为符号色的元素。
 * 主题跟系统变、外观设置、皮肤（样式表进出 `<head>`）、遮罩，任何一样变了都重量一次，只在颜色真变了时送。
 */
export function useWindowOverlay(header: RefObject<HTMLElement | null>, symbol: RefObject<HTMLElement | null>): void {
	const appearance = useAppearance();
	const skin = useManagedSkin();
	useEffect(() => {
		let base: OverlayColors | undefined;
		let sent = "";
		let frame = 0;
		const send = () => {
			if (!base) return;
			const colors = tintedOverlay(base, heldScrims());
			const key = `${colors.color} ${colors.symbolColor}`;
			if (key === sent) return;
			sent = key;
			window.plume.setWindowOverlay(colors);
		};
		const measure = () => {
			frame = 0;
			const color = header.current && cssToHex(getComputedStyle(header.current).backgroundColor);
			const symbolColor = symbol.current && cssToHex(getComputedStyle(symbol.current).color);
			if (!color || !symbolColor) return;
			base = { color, symbolColor };
			send();
		};
		const later = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		measure();
		const dark = matchMedia("(prefers-color-scheme: dark)");
		dark.addEventListener("change", later);
		const sheets = new MutationObserver(later);
		sheets.observe(document.head, { childList: true, subtree: true, characterData: true });
		const stopScrims = onScrimsChange(send);
		return () => {
			cancelAnimationFrame(frame);
			dark.removeEventListener("change", later);
			sheets.disconnect();
			stopScrims();
		};
	}, [header, symbol, appearance, skin]);
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * 计算出来的颜色写成 `#rrggbb`。token 是 `color-mix()` 推出来的，计算值可能是 `color(srgb …)` 一类 Electron 的
 * `setTitleBarOverlay` 不认的写法，所以在一像素的画布上涂一下再读回来。
 */
function cssToHex(css: string): string | undefined {
	probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	if (!probe) return undefined;
	probe.clearRect(0, 0, 1, 1);
	probe.fillStyle = css;
	probe.fillRect(0, 0, 1, 1);
	const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
	// 透明的带子（皮肤没给底色）说明不了按钮该画在什么上面，不送，留着上一次的。
	return a === 0 ? undefined : toHex({ r, g, b });
}
