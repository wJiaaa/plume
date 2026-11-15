/**
 * 窗口外壳的几何：主进程定红绿灯位置、系统按钮那条带子和要不要毛玻璃，预加载脚本按它给页面打标记，界面按它排顶行。
 * 三边量的是同一样东西，所以数只写在这里。不引用 Electron，三个进程都能引用。
 */

/**
 * 标题栏的高度：会话窗口、面板窗口贴顶的标题栏，页面里的 `PageTopRow` 都是这么高，红绿灯在这一行里居中。
 * 主窗口顶上那一条矮一些，见 `MAIN_TOOLBAR_HEIGHT`。
 */
export const TOP_ROW_HEIGHT = 44;

/**
 * 主窗口顶上那一条的高度：红绿灯、后退、前进、侧栏开关、对话的标题、面板区的标签都在这一行，活动栏、侧栏、对话和面板区从它下面开始。
 * 这一行里已经没有哪张卡片的标题栏，不用和 `TOP_ROW_HEIGHT` 一样高；40 让 28px 的按钮上下各空 6px、14pt 的红绿灯落在 y=13。
 */
export const MAIN_TOOLBAR_HEIGHT = 40;

/**
 * Windows、Linux 窗口顶上那条横贯的带子，也是交给系统画最小化、最大化、关闭的高度（`titleBarOverlay.height`）。
 * 32 是 Windows 标准标题栏按钮的高度。和上面两个分开：那两个是按 macOS 红绿灯居中定的，拿去给系统按钮，
 * 按钮会比桌面上别的窗口大一圈；带子和按钮必须是同一个数，矮了按钮探出带子，高了上下各浮一段空白。
 */
export const NATIVE_HEADER_HEIGHT = 32;

/** 侧栏、对话、面板区连成的那一块离窗口右边、底边的距离（不含描边）；左边贴着活动栏，顶边贴着顶行。 */
export const CARD_INSET = 4;

/**
 * 顶行左端从哪里开始放东西。三颗灯从 x=16 起、到 x=76 止，第一个按钮从 86 开始，和绿灯之间留出一段；
 * 贴得再近，按钮会读成第四颗灯。全屏或没有红绿灯时，用窗口其他边的 12px。
 */
export const TRAFFIC_LIGHTS_END = 86;
export const TOOLBAR_EDGE = 12;
/** 顶行里图标按钮的边长：后退、前进、侧栏开关。 */
export const TOOLBAR_BUTTON = 28;

/**
 * 这个平台的窗口顶上要不要单独一条带子。macOS 不要：红绿灯在左上角，卡片的标题栏本身就是窗口的顶行。
 * Windows、Linux 要：系统按钮在右上角，正压在卡片自己的控件上；一条横贯的带子把左端的侧栏开关和右端的
 * 系统按钮收进同一行，卡片整体下移，不再和窗口抢那一行。
 */
export function hasHeaderBar(platform: string): boolean {
	return platform !== "darwin";
}

/** macOS 红绿灯摆在哪：灯高 14pt（含描边），在 `rowHeight` 高的顶行里居中。 */
export function trafficLights(rowHeight: number): { x: number; y: number } {
	return { x: 16, y: (rowHeight - 14) / 2 };
}

/**
 * 新建窗口时和平台外壳有关的那几项，主窗口、会话窗口、面板窗口共用；`rowHeight` 是这扇窗顶行的高度，红绿灯在里面居中
 * （主窗口 `MAIN_TOOLBAR_HEIGHT`，会话窗口、面板窗口 `TOP_ROW_HEIGHT`）。macOS 只留红绿灯；别处隐藏系统标题栏，
 * 由系统把三颗按钮画在页面右上角（`titleBarOverlay`）。`color` 是此刻的窗口底色：页面还没画，整扇窗就是这个颜色；
 * 页面画出带子后把带子的底色和按钮的颜色送过来（`plume:window:overlay`），稳态归页面那一边管。
 * 符号色这里不给，交给 Electron 按底色取对比色，免得主进程再抄一遍调色公式。
 */
export function windowChrome(
	platform: string,
	color: string,
	rowHeight: number,
): { titleBarStyle: "hiddenInset" | "hidden"; trafficLightPosition?: { x: number; y: number }; titleBarOverlay?: { color: string; height: number } } {
	if (platform === "darwin") return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLights(rowHeight) };
	return { titleBarStyle: "hidden", titleBarOverlay: { color, height: NATIVE_HEADER_HEIGHT } };
}

/**
 * 要不要毛玻璃。macOS 的窗口底层是系统材质，页面在上面铺一层半透明的底色；其他平台没有对应的材质，照旧不透明。
 * 主进程据此建窗口，预加载脚本据此给页面打 data-vibrancy，两边不会一边开一边没开。
 */
export function hasVibrancy(platform: string): boolean {
	return platform === "darwin";
}
