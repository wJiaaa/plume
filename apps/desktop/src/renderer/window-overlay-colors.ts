/**
 * 系统按钮那几样颜色在遮罩底下是什么样：纯计算，不碰 DOM，见 window-overlay.ts。
 */

import type { Scrim } from "@plume/ui";

export interface OverlayColors {
	/** 带子的底色，系统按钮画在它上面。 */
	color: string;
	/** 按钮上的符号。 */
	symbolColor: string;
}

/** 遮罩盖住这么多以上，页面几乎看不见了：按钮不再跟着变暗，否则关窗口的按钮也跟着看不见。 */
const HEAVY = 0.5;
/** 重遮罩上的符号按深色主题的样子画：带子底色往白色混这么多。 */
const HEAVY_SYMBOL = 0.6;
const WHITE = { r: 255, g: 255, b: 255 };

/** 现在这些遮罩底下，带子和按钮看起来是什么颜色。不是 `#rrggbb` 的原样留着。 */
export function tintedOverlay(colors: OverlayColors, scrims: readonly Scrim[]): OverlayColors {
	const under = (hex: string) => scrims.reduce((color, scrim) => blend(color, scrim.color, scrim.alpha), hex);
	const color = under(colors.color);
	const heavy = scrims.some((scrim) => scrim.alpha >= HEAVY);
	const base = parseHex(color);
	const symbolColor = heavy && base ? toHex(mix(base, WHITE, HEAVY_SYMBOL)) : under(colors.symbolColor);
	return { color, symbolColor };
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

function parseHex(hex: string): Rgb | undefined {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	return match ? { r: Number.parseInt(match[1]!, 16), g: Number.parseInt(match[2]!, 16), b: Number.parseInt(match[3]!, 16) } : undefined;
}

export function toHex({ r, g, b }: Rgb): string {
	return `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

/** `from` 往 `to` 混 `amount`。 */
function mix(from: Rgb, to: Rgb, amount: number): Rgb {
	return { r: from.r + (to.r - from.r) * amount, g: from.g + (to.g - from.g) * amount, b: from.b + (to.b - from.b) * amount };
}

function blend(hex: string, over: string, alpha: number): string {
	const from = parseHex(hex);
	const to = parseHex(over);
	return from && to ? toHex(mix(from, to, alpha)) : hex;
}
