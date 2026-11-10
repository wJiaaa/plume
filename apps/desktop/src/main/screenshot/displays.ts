/**
 * 快照里哪一张画面是哪一块屏幕，以及那串像素属于哪个色彩空间。纯算术，不碰 Electron。
 *
 * `desktopCapturer.getSources({ types: ["screen"] })` 一次拍下所有屏幕，要从里面挑出指针所在的那一块。官方的依据是
 * `source.display_id === String(display.id)`，但 Windows 上只有走 DirectX 抓屏时 Electron 才填 `display_id`，走 GDI
 * （远程桌面、虚拟机、副屏接在另一块显卡上）时它是空串。拿「第一张」兜底，副屏上截出来的就是主屏的画面。
 * 所以按可靠程度排了几道依据，挑出来的结果带着凭的是哪一道。
 */

/** 一个屏幕源，只留挑选用得上的几项。 */
export interface ScreenSource {
	id: string;
	/** Electron 给的显示器 id；Windows 走 GDI 时是空串。 */
	display_id: string;
	/** 这张画面实际的像素尺寸。 */
	size: { width: number; height: number };
}

export interface DisplayShape {
	id: number;
	bounds: { width: number; height: number };
	scaleFactor: number;
}

export interface SourceChoice {
	index: number;
	how: "display-id" | "only-one" | "index" | "shape" | "index-mismatched" | "first";
}

/**
 * 两个长宽比算不算同一个。千分之五：画面缩放到请求的大小时按整数像素取整，末位会差一点；再松就会把 3440×1440 和 21:9 混为一谈。
 */
const ASPECT_TOLERANCE = 0.005;

function aspect(size: { width: number; height: number }): number {
	return size.height > 0 ? size.width / size.height : 0;
}

function sameShape(source: ScreenSource, display: DisplayShape): boolean {
	const wanted = aspect(display.bounds);
	const got = aspect(source.size);
	if (!(wanted > 0) || !(got > 0)) return false;
	return Math.abs(got - wanted) <= ASPECT_TOLERANCE * wanted;
}

/** 在所有屏幕的画面里挑出目标显示器那一张；一张都没有时是 null。 */
export function pickDisplaySource(sources: readonly ScreenSource[], displays: readonly DisplayShape[], targetId: number): SourceChoice | null {
	if (sources.length === 0) return null;

	// display_id 对上了。空串是「没填」，不算对上。
	const byId = sources.findIndex((source) => source.display_id !== "" && source.display_id === String(targetId));
	if (byId >= 0) return { index: byId, how: "display-id" };

	if (sources.length === 1) return { index: 0, how: "only-one" };

	const target = displays.find((display) => display.id === targetId);
	const at = displays.findIndex((display) => display.id === targetId);
	// 屏幕列表和画面列表来自同一次显示器枚举，数量相同时位次一致；位次只是约定，所以还要形状也对得上。
	const alignable = at >= 0 && sources.length === displays.length;
	if (alignable && target && sameShape(sources[at]!, target)) return { index: at, how: "index" };

	// 只有一张画面是这个形状（笔记本 16:10 外接 16:9 很常见）。
	if (target) {
		const shaped = sources.flatMap((source, index) => (sameShape(source, target) ? [index] : []));
		if (shaped.length === 1) return { index: shaped[0]!, how: "shape" };
	}

	// 位次对上、形状对不上：多半是画面被缩放进了请求的框里（所有源共用一个 thumbnailSize），仍比第一张强。
	if (alignable) return { index: at, how: "index-mismatched" };

	return { index: 0, how: "first" };
}

/**
 * canvas 认识的两个色彩空间里，这块屏幕的帧属于哪个。
 *
 * 抓回来的是显示器帧缓冲里的原始数值，属于显示器的色彩空间：Display P3 的 Mac 上把它当 sRGB 画进 canvas，
 * 浏览器会再做一次 sRGB→P3，截出来的彩色比屏幕上更艳（灰阶不受影响）。`Display.colorSpace` 是一串描述，
 * 形如 `{primaries:P3, transfer:…}`；BT.2020 归到 P3（canvas 给不了更宽的）。认不出来时按 sRGB。
 */
export function canvasColorSpace(colorSpace: string | undefined): "srgb" | "display-p3" {
	if (!colorSpace) return "srgb";
	const primaries = /primaries:\s*([A-Za-z0-9_.-]+)/.exec(colorSpace)?.[1] ?? "";
	if (/^P3/i.test(primaries) || /display[_-]?p3/i.test(primaries)) return "display-p3";
	if (/2020/.test(primaries)) return "display-p3";
	return "srgb";
}
