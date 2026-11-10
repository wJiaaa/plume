/** 行内代码的字色保留底色色相，分别试深浅两头，选择达到 WCAG AA 后更清楚的一头。 */
export function readableInk(background: string): string {
	const rgb = parseHex(background);
	if (!rgb) return toHex({ r: 26, g: 28, b: 31 });
	const { h, s } = toHsl(rgb);
	// 比终点而不是起点：中间调的饱和色，两头起点很接近，能达到的对比度却差得很远。
	const deep = settle(rgb, { h, s: Math.min(s * 1.6, 0.85), l: 0.12 }, -0.03);
	const pale = settle(rgb, { h, s: Math.min(s * 0.9, 0.35), l: 0.93 }, 0.03);
	return toHex(contrast(rgb, deep) >= contrast(rgb, pale) ? deep : pale);
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

interface Hsl {
	h: number;
	s: number;
	l: number;
}

function parseHex(hex: string): Rgb | null {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!match?.[1]) return null;
	const value = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
	return {
		r: Number.parseInt(value.slice(0, 2), 16),
		g: Number.parseInt(value.slice(2, 4), 16),
		b: Number.parseInt(value.slice(4, 6), 16),
	};
}

function toHex({ r, g, b }: Rgb): string {
	return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

/** 从协调的深浅色起步，达到正文 AA 的 4.5:1 就停，不为追求纯黑白丢掉色相。 */
function settle(background: Rgb, from: Hsl, step: number): Rgb {
	let ink = fromHsl(from);
	for (let l = from.l; contrast(background, ink) < 4.5 && l > 0 && l < 1;) {
		l = Math.max(0, Math.min(1, l + step));
		ink = fromHsl({ ...from, l });
	}
	return ink;
}

function contrast(a: Rgb, b: Rgb): number {
	const [bright, dim] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (bright! + 0.05) / (dim! + 0.05);
}

function relativeLuminance({ r, g, b }: Rgb): number {
	// sRGB 先解伽马再加权；HSL 亮度不能代替人眼看到的亮度。
	const channel = (value: number) => {
		const v = value / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function toHsl({ r, g, b }: Rgb): Hsl {
	const red = r / 255;
	const green = g / 255;
	const blue = b / 255;
	const max = Math.max(red, green, blue);
	const min = Math.min(red, green, blue);
	const l = (max + min) / 2;
	const delta = max - min;
	if (delta === 0) return { h: 0, s: 0, l };
	const s = delta / (1 - Math.abs(2 * l - 1));
	const h = max === red ? 60 * (((green - blue) / delta) % 6) : max === green ? 60 * ((blue - red) / delta + 2) : 60 * ((red - green) / delta + 4);
	return { h: (h + 360) % 360, s, l };
}

function fromHsl({ h, s, l }: Hsl): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return { r: Math.round((r! + m) * 255), g: Math.round((g! + m) * 255), b: Math.round((b! + m) * 255) };
}
