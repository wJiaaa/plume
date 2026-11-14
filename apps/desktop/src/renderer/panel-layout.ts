import type { CSSProperties } from "react";
import { panelHeightFor, panelWidthFor } from "./layout.ts";

/** 对话和面板内容共用几何，开合时保持内容尺寸。 */
export function panelGeometry(options: {
	width: number;
	height: number;
	preferred: number;
	share: number;
	compact: boolean;
	maximized: boolean;
	shown: boolean;
}) {
	const { width, height, preferred, share, compact, maximized, shown } = options;
	const single = compact || maximized;
	const stacked = !single && width < 420 + 300 + 4 && height >= 260 + 150 + 4;
	const arrangement = single ? "single" : stacked ? "column" : "row";
	const panelWidth = single || stacked ? width : panelWidthFor(preferred, width - 4, 0);
	const panelHeight = stacked ? panelHeightFor(share, height) : height;
	const chat: CSSProperties = {
		right: shown && !single && !stacked ? panelWidth + 4 : 0,
		bottom: shown && stacked ? panelHeight + 4 : 0,
	};
	/*
	 * 收起时面板挪到工作区外面，挪的是 `right`、`bottom`，不是 `translate`：对话那一栏开合时改的也是 `right`、`bottom`，
	 * 两边同在主线程的同一次布局里走，每一帧都贴着。用 `translate` 的话面板在合成线程上滑，长对话重排慢时对话跟不上，
	 * 两张卡片之间会裂开一道缝、一帧一帧地追。
	 */
	const hidden = !shown && !single;
	const panel: CSSProperties = {
		width: single || stacked ? "100%" : panelWidth,
		height: stacked ? panelHeight : "100%",
		right: hidden && !stacked ? -(panelWidth + 4) : 0,
		bottom: hidden && stacked ? -(panelHeight + 4) : 0,
	};
	return { single, stacked, arrangement, panelWidth, panelHeight, chat, panel };
}
