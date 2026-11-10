/**
 * 只有外观页用的几个控件：颜色、滑块、主题缩略图，和配色预设。
 *
 * 颜色当文字编辑，能解析了才生效，半截的 `#33` 不会在打到 `#339CFF` 的路上把窗口重画一遍。
 * 缩略图是画出来的而不是截图：用户刚打的强调色也要能画进去。
 *
 * 这个文件里有色值（缩略图的两套样子、预设、色块上的黑白字），登记在 scripts/check-styles.mjs 的例外里：
 * 它们画的是“浅色长什么样”“深色长什么样”，和此刻的主题无关，不能用跟着主题变的 token。
 */

import { ColorField, NumberField } from "@plume/ui";
export { ColorField, Slider } from "@plume/ui";
import type { AppearancePatch } from "../../shared/appearance.ts";

/** 配色预设：只给强调色和深色的一对底色、字色，浅色那一对不动。第一个就是默认配色。 */
export const PRESETS: { id: string; label: string; patch: AppearancePatch }[] = [
	{ id: "plume", label: "Plume", patch: { accent: "#339CFF", darkBackground: "#171717", darkForeground: "#D4D4D4" } },
	{ id: "graphite", label: "Graphite", patch: { accent: "#8E8E93", darkBackground: "#1C1C1E", darkForeground: "#F2F2F7" } },
	{ id: "moss", label: "Moss", patch: { accent: "#3ECF8E", darkBackground: "#121614", darkForeground: "#E6F2EC" } },
	{ id: "ember", label: "Ember", patch: { accent: "#FF8B3D", darkBackground: "#1A1412", darkForeground: "#F5E9E2" } },
];

export function ColorRow({
	label,
	value,
	onChange,
	readOnly = false,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	readOnly?: boolean;
}) {
	return (
		<div data-appearance-color="" data-readonly={readOnly} className="flex items-center justify-between border-b border-line-soft px-4 py-3 last:border-b-0">
			<span className="text-body text-ink">{label}</span>
			<ColorField value={value} onChange={onChange} label={label} readOnly={readOnly} />
		</div>
	);
}

/** 像素尺寸复用数字框，单位固定显示在旁边。 */
export function PixelField({
	value,
	min,
	max,
	onChange,
	label,
	name,
}: {
	value: number;
	min: number;
	max: number;
	onChange: (value: number) => void;
	label: string;
	name?: string;
}) {
	return (
		<div className="flex items-center gap-2">
			<NumberField value={value} min={min} max={max} onChange={onChange} label={label} name={name} width={88} />
			<span className="text-detail text-ink-faint">px</span>
		</div>
	);
}

/** 应用外壳的缩略图，三个主题选项一眼认得出。 */
export function ThemePreview({ variant, accent }: { variant: "system" | "light" | "dark"; accent: string }) {
	const light = { shell: "#f5f5f5", card: "#ffffff", bar: "#e2e2e2", line: "#d6d6d6" };
	const dark = { shell: "#2b2b2b", card: "#1d1d1d", bar: "#3a3a3a", line: "#454545" };

	// 返回标记的函数而不是组件：只被调用、不被挂载，React 不会重挂它的子树。
	const half = (c: typeof light, clip?: string) => (
		<g clipPath={clip}>
			<rect x="0" y="0" width="120" height="80" fill={c.shell} />
			<rect x="0" y="0" width="40" height="80" fill={c.bar} />
			<rect x="46" y="10" width="64" height="5" rx="2.5" fill={c.line} />
			<rect x="46" y="22" width="64" height="48" rx="5" fill={c.card} />
			<rect x="52" y="30" width="34" height="4" rx="2" fill={c.line} />
			<rect x="52" y="40" width="46" height="4" rx="2" fill={c.line} />
			<rect x="52" y="50" width="28" height="4" rx="2" fill={accent} opacity="0.85" />
		</g>
	);

	/*
	 * 跟随系统那张沿对角线分开，不从中间竖着切：竖切时浅色那半边大半是灰的侧栏，眼睛落在的卡片又在深色那边，
	 * 整张看着就是深色。对角线让分界本身成为看得见的东西，卡片的两个角各在一边。
	 */
	return (
		<svg viewBox="0 0 120 80" className="w-full rounded-xs" aria-hidden>
			<defs>
				<clipPath id={`theme-half-${variant}`}>
					<polygon points="0,0 120,0 0,80" />
				</clipPath>
			</defs>
			{variant === "light" && half(light)}
			{variant === "dark" && half(dark)}
			{variant === "system" && (
				<>
					{half(dark)}
					{half(light, `url(#theme-half-${variant})`)}
					<line x1="120" y1="0" x2="0" y2="80" stroke={light.line} strokeWidth="0.75" opacity="0.5" />
				</>
			)}
		</svg>
	);
}
