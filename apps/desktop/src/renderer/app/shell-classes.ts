import { hasHeaderBar } from "../../shared/window-chrome.ts";

// 窗口底色上放侧栏，旁边是一张浮起的正文卡片，离窗口边和侧栏各 4px。macOS 上窗口底下是系统材质，
// 底色是半透明的一层，从侧栏和卡片四周的缝里透出来；卡片是实色的。
//
// 顶行：侧栏顶行和卡片里的标题栏都是 44px，比窗口顶边低 5px（见 shared/window-chrome.ts），红绿灯、侧栏开关在同一条线上。
// 这两行可以拖动窗口，里面能点的东西标 no-drag。Electron 按文档顺序合成拖拽区，排在后面的 drag 会把前面挖的洞重新盖上，
// 所以浮在顶行上的侧栏开关和拖宽度的把手放在最后。

export const DRAG = "[app-region:drag]";
export const NO_DRAG = "[app-region:no-drag]";
/**
 * Windows、Linux 上窗口顶上另有一条带子（`WindowHeader`），拖窗口、侧栏开关、系统按钮都在它上面。卡片里的标题栏就只是
 * 卡片的一行，不拖窗口：在那里拖等于在 Windows 的标题栏上拖，右键弹系统菜单、双击最大化、拖到屏幕边就贴边。
 */
export const HEADER_BAR = hasHeaderBar(window.plume.platform);
/** 卡片里的标题栏：有那条带子时不拖窗口。 */
export const CARD_DRAG = HEADER_BAR ? "" : DRAG;
/** 侧栏、面板区收起和展开时的动画。拖宽度和窗口缩放时不加，否则每一帧都在追上一帧。 */
export const SLIDE_MOTION = "transition-[width,translate] ease-out";
