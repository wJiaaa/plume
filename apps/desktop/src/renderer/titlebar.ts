/**
 * 窗口顶行的两端各有多少归系统。系统按钮画在页面上方，不在文档里、量不到，每个数都只能定下来：
 *
 *   macOS    红绿灯在左端，宽度固定，原生全屏时不画
 *   Windows  最小化、最大化、关闭在右端，宽度随显示缩放变
 *   Linux    和 Windows 一样的 overlay，桌面设成按钮在左时在左端
 *
 * 只按 macOS 排的话，Windows 上左端白留 86px 给不存在的红绿灯，右端什么都不让，系统按钮压在卡片的控件上：
 * 画得出来，按不动，按下去归了窗口管理器。规则单放在这里好单独测，订阅 overlay 变化的那一半是下面的 `useTitlebar`。
 */

import { useEffect, useMemo, useState } from "react";
import { TOOLBAR_EDGE, TRAFFIC_LIGHTS_END } from "../shared/window-chrome.ts";

/** overlay 开着但还没量出自己的大小时（矩形全是 0），按 100% 缩放下 Windows 三颗按钮的宽度先让着，免得这一刻关闭按钮压在控件上。 */
export const OVERLAY_FALLBACK = 138;

/**
 * `geometrychange` 等多久再读。Windows 11 上最大化、还原时它比随后的 `resize` 早大约 150ms 到，那一刻量到的是
 * 新窗口的矩形和旧窗口的宽度；过了这么久还没等来 `resize`，说明是系统自己的标题栏尺寸变了，照当时的读。
 */
const OVERLAY_SETTLE_MS = 300;

export interface TitlebarInsets {
	start: number;
	end: number;
}

/** 系统按钮在两端各占多少像素。 */
interface OverlayReserve {
	start: number;
	end: number;
}

/** `navigator.windowControlsOverlay` 里用得到的那部分。 */
interface OverlayLike {
	visible: boolean;
	getTitlebarAreaRect(): { x: number; right: number; width: number };
}

/** 顶行两端各从哪里开始放东西：`start` 是左端第一个按钮的位置，`end` 是右端要空出来的宽度。 */
export function titlebarInsets(platform: string, fullScreen: boolean, overlay: OverlayReserve): TitlebarInsets {
	// macOS 的控件都在左端，右端什么都没有。
	if (platform === "darwin") return { start: fullScreen ? TOOLBAR_EDGE : TRAFFIC_LIGHTS_END, end: 0 };
	// 系统按钮在哪端就让哪端：通常是右端；Linux 桌面把按钮放在左边时，顶行从它们后面开始，和 Mac 上从红绿灯后面开始一样。
	return { start: overlay.start > 0 ? overlay.start : TOOLBAR_EDGE, end: overlay.end };
}

/**
 * 系统按钮在两端各占多宽，问的是唯一知道的那个接口。`getTitlebarAreaRect` 给的是留给页面的那一段，系统占的就是它
 * 左边以前和右边以后的部分。看不见（全屏，或这个平台不画 overlay）就不用让。
 */
export function overlayReserved(overlay: OverlayLike | undefined, windowWidth: number): OverlayReserve {
	if (!overlay?.visible) return { start: 0, end: 0 };
	const rect = overlay.getTitlebarAreaRect();
	if (rect.width === 0) return { start: 0, end: OVERLAY_FALLBACK };
	return { start: Math.max(0, Math.round(rect.x)), end: Math.max(0, Math.round(windowWidth - rect.right)) };
}

/**
 * 顶行两端此刻的让位。`geometrychange` 在最大化、还原和系统标题栏尺寸变化时触发，只在挂载时读一次的话，双击一下
 * 标题栏就不对了；可只跟着它读也不对，它比 `resize` 先到，见 `OVERLAY_SETTLE_MS`。按钮的宽度不随窗口变，所以上一次的
 * 读数一直有效，等 `resize` 把两边都更新了再读；没有 `resize` 跟上来的变化，等稳了再读。
 */
export function useTitlebar(platform: string, fullScreen: boolean): TitlebarInsets {
	const overlay = navigator.windowControlsOverlay;
	const [reserved, setReserved] = useState(() => overlayReserved(overlay, window.innerWidth));
	useEffect(() => {
		if (!overlay) return;
		const update = () => {
			const next = overlayReserved(overlay, window.innerWidth);
			setReserved((previous) => (previous.start === next.start && previous.end === next.end ? previous : next));
		};
		let settle: ReturnType<typeof setTimeout> | undefined;
		const onGeometry = () => {
			clearTimeout(settle);
			settle = setTimeout(update, OVERLAY_SETTLE_MS);
		};
		const onResize = () => {
			clearTimeout(settle);
			update();
		};
		update();
		overlay.addEventListener("geometrychange", onGeometry);
		window.addEventListener("resize", onResize);
		return () => {
			clearTimeout(settle);
			overlay.removeEventListener("geometrychange", onGeometry);
			window.removeEventListener("resize", onResize);
		};
	}, [overlay]);
	return useMemo(() => titlebarInsets(platform, fullScreen, reserved), [platform, fullScreen, reserved]);
}

/** Window Controls Overlay，TypeScript 的 DOM 库里没有。窗口带着 `titleBarOverlay` 建出来时 Chromium 才给。 */
interface WindowControlsOverlay extends EventTarget {
	readonly visible: boolean;
	getTitlebarAreaRect(): DOMRect;
}

declare global {
	interface Navigator {
		readonly windowControlsOverlay?: WindowControlsOverlay;
	}
}
