/**
 * 会话背景图的几种重绘：网点、字符、印刷网点、扫描线。
 *
 * 纯像素运算，不碰 DOM：输入是解码好的 RGBA 和亮度，输出是同尺寸的 RGBA，画布和编码留给调用方。
 *
 * 算法移植自 MonoCode（https://github.com/hardbeat920/monocode，MIT License，
 * Copyright (c) 2026 Nick）的 `newThreadBackgroundEffects.worker.ts`。
 */

import type { ChatBackgroundEffect } from "../shared/appearance.ts";

export interface BackdropSource {
	width: number;
	height: number;
	/** RGBA，`width * height * 4`。 */
	pixels: Uint8ClampedArray;
	/** 每个像素的亮度，`width * height`。 */
	luma: Uint8Array;
}

/**
 * 处理之前先缩到这个边长以内。
 *
 * 背景是 `cover` 铺满一个窗格，2048 已经够 Retina 屏上的一整扇窗；再大只是让每种效果多算几倍像素。
 */
export const BACKDROP_MAX_EDGE = 2048;

/** 要在渲染进程里逐像素重绘的那几种。`none` 用原图，`haze` 是 CSS 的模糊，都不经过这里。 */
export function redrawn(effect: ChatBackgroundEffect): effect is "dither" | "ascii" | "halftone" | "scanlines" {
	return effect !== "none" && effect !== "haze";
}

/**
 * 结果和深浅色有没有关系。
 *
 * 字符、网点、扫描线的「纸」是黑或白，跟着主题换；网点重绘只调原图自己的颜色，深浅都是同一张。
 * 缓存键据此决定要不要带上主题，免得切一次主题就白算一遍。
 */
export function themed(effect: ChatBackgroundEffect): boolean {
	return effect === "ascii" || effect === "halftone" || effect === "scanlines";
}

export function lumaOf(pixels: Uint8ClampedArray): Uint8Array {
	const luma = new Uint8Array(pixels.length / 4);
	for (let i = 0; i < luma.length; i += 1) {
		const o = i * 4;
		luma[i] = Math.round(px(pixels, o) * 0.2126 + px(pixels, o + 1) * 0.7152 + px(pixels, o + 2) * 0.0722);
	}
	return luma;
}

export function redraw(source: BackdropSource, effect: "dither" | "ascii" | "halftone" | "scanlines", light: boolean): Uint8ClampedArray {
	switch (effect) {
		case "dither":
			return dither(source);
		case "ascii":
			return ascii(source, light);
		case "halftone":
			return halftone(source, light);
		case "scanlines":
			return scanlines(source, light);
	}
}

/** 下标都是按宽高算出来的，一定在范围里；noUncheckedIndexedAccess 下读数组用它，省得每处都判 undefined。 */
function px(array: ArrayLike<number>, index: number): number {
	return array[index] as number;
}

function at(source: BackdropSource, x: number, y: number): number {
	const sx = Math.max(0, Math.min(source.width - 1, Math.floor(x)));
	const sy = Math.max(0, Math.min(source.height - 1, Math.floor(y)));
	return sy * source.width + sx;
}

const BAYER = [
	[0, 8, 2, 10],
	[12, 4, 14, 6],
	[3, 11, 1, 9],
	[15, 7, 13, 5],
];

/** 2×2 一格，按 4×4 Bayer 阈值决定这一格是提亮到饱和还是压到近黑。 */
function dither(source: BackdropSource): Uint8ClampedArray {
	const { width, height, pixels } = source;
	const out = new Uint8ClampedArray(pixels.length);
	for (let y = 0; y < height; y += 2) {
		for (let x = 0; x < width; x += 2) {
			const base = at(source, x + 1, y + 1) * 4;
			const r = px(pixels, base);
			const g = px(pixels, base + 1);
			const b = px(pixels, base + 2);
			const peak = Math.max(r, g, b);
			const bright = peak / 255 > (px(BAYER[(y / 2) % 4] as number[], (x / 2) % 4) + 0.5) / 16;
			const gain = bright ? 255 / Math.max(peak, 1) : 0.08;
			const color = [Math.round(r * gain), Math.round(g * gain), Math.round(b * gain), px(pixels, base + 3)];
			for (let dy = 0; dy < Math.min(2, height - y); dy += 1) {
				for (let dx = 0; dx < Math.min(2, width - x); dx += 1) out.set(color, ((y + dy) * width + x + dx) * 4);
			}
		}
	}
	return out;
}

/** 5×7 点阵字形，按墨量从空到满。每行一个 5 位掩码，高位在左。 */
const GLYPHS = [
	[0, 0, 0, 0, 0, 0, 0],
	[0, 0, 0, 0, 0, 4, 0],
	[0, 4, 0, 0, 4, 0, 0],
	[0, 0, 0, 14, 0, 0, 0],
	[0, 0, 14, 0, 14, 0, 0],
	[0, 4, 4, 31, 4, 4, 0],
	[0, 21, 14, 31, 14, 21, 0],
	[10, 10, 31, 10, 31, 10, 10],
	[17, 2, 4, 4, 8, 16, 17],
	[14, 17, 23, 21, 23, 16, 14],
];

/** 6×8 一格画一个字符，字的颜色取这一格中心的原色，和原图六四开混合。 */
function ascii(source: BackdropSource, light: boolean): Uint8ClampedArray {
	const { width, height, pixels, luma } = source;
	const out = new Uint8ClampedArray(pixels.length);
	const paper = light ? 255 : 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const sample = at(source, Math.floor(x / 6) * 6 + 3, Math.floor(y / 8) * 8 + 4);
			const ink = light ? 255 - px(luma, sample) : px(luma, sample);
			const glyph = GLYPHS[Math.floor(Math.sqrt(ink / 255) * 9)] as number[];
			const on = x % 6 < 5 && y % 8 < 7 && (px(glyph, y % 8) & (1 << (4 - (x % 6)))) !== 0;
			const p = (y * width + x) * 4;
			const s = sample * 4;
			for (let c = 0; c < 3; c += 1) out[p + c] = px(pixels, p + c) * 0.6 + (on ? px(pixels, s + c) : paper) * 0.4;
			out[p + 3] = px(pixels, p + 3);
		}
	}
	return out;
}

/** 4×4 一格一个圆点，亮处点大，和原图六四开混合。 */
function halftone(source: BackdropSource, light: boolean): Uint8ClampedArray {
	const { width, height, pixels, luma } = source;
	const out = new Uint8ClampedArray(pixels.length);
	const paper = light ? 255 : 0;
	for (let y = 0; y < height; y += 4) {
		for (let x = 0; x < width; x += 4) {
			const level = light ? 255 - px(luma, at(source, x, y)) : px(luma, at(source, x, y));
			const radius = 2 * (0.3 + 0.7 * Math.sqrt(level / 255));
			const dot = at(source, x + 2, y + 2) * 4;
			for (let dy = 0; dy < Math.min(4, height - y); dy += 1) {
				for (let dx = 0; dx < Math.min(4, width - x); dx += 1) {
					const p = ((y + dy) * width + x + dx) * 4;
					const cover = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx - 1.5, dy - 1.5))) * (px(pixels, dot + 3) / 255);
					for (let c = 0; c < 3; c += 1) out[p + c] = px(pixels, p + c) * 0.6 + (px(pixels, dot + c) * cover + paper * (1 - cover)) * 0.4;
					out[p + 3] = px(pixels, p + 3);
				}
			}
		}
	}
	return out;
}

/** 每三行压暗（浅色主题下是提亮）一行。 */
function scanlines(source: BackdropSource, light: boolean): Uint8ClampedArray {
	const { width, height, pixels } = source;
	const out = new Uint8ClampedArray(pixels.length);
	for (let y = 0; y < height; y += 1) {
		const gain = y % 3 === 0 ? 0.52 : 1;
		for (let x = 0; x < width; x += 1) {
			const p = (y * width + x) * 4;
			for (let c = 0; c < 3; c += 1) {
				const v = px(pixels, p + c);
				out[p + c] = light ? v + (255 - v) * (1 - gain) : v * gain;
			}
			out[p + 3] = px(pixels, p + 3);
		}
	}
	return out;
}
