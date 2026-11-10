/**
 * 供应商名字的首字母放在一个着色的方块上，让列表有东西对齐。
 *
 * 供应商是中转和网关，名字随主人起——「公司」、`commandcode`——没有 ModelIcon 那样可查的品牌，剩下的就是一个字母；
 * 色相由名字算出，同一个供应商重启后还是那个颜色。字色往 ink 混而不是按主题各挑一个：ink 在浅色主题是深的、
 * 在深色主题是浅的，一个表达式两边都读得清。
 */

import type { CSSProperties } from "react";

export function ProviderAvatar({ name, size, className = "" }: { name: string; size: "sm" | "lg"; className?: string }) {
	const hue = [...name].reduce((sum, char) => (sum * 31 + (char.codePointAt(0) ?? 0)) % 360, 7);
	const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
	return (
		<span
			aria-hidden
			className={`grid shrink-0 place-items-center font-semibold ${size === "sm" ? "h-5 w-5 rounded-md text-caption" : "h-9 w-9 rounded-lg text-title"} ${className}`}
			// 色相经 --plume-avatar-hue 传进去：它是这个头像自己的变量，不是主题 token。
			style={
				{
					"--plume-avatar-hue": hue,
					background: "hsl(var(--plume-avatar-hue) 65% 52% / 0.14)",
					color: "color-mix(in srgb, hsl(var(--plume-avatar-hue) 65% 52%) 72%, var(--color-ink))",
				} as CSSProperties
			}
		>
			{initial}
		</span>
	);
}
