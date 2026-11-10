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
	const panel: CSSProperties = {
		width: single || stacked ? "100%" : panelWidth,
		height: stacked ? panelHeight : "100%",
		right: 0,
		bottom: 0,
		translate: shown || single ? "0 0" : stacked ? "0 calc(100% + 4px)" : "calc(100% + 4px) 0",
	};
	return { single, stacked, arrangement, panelWidth, panelHeight, chat, panel };
}
