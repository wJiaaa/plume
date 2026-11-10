import { useEffect, useState } from "react";

/** 能解析的颜色统一写成 `#RRGGBB`，解析不了是 null。显示和保存都走这一个出口：不带 `#` 的值直接当 CSS 用会失效。 */
function canonical(text: string): string | null {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
	if (!match?.[1]) return null;
	const value = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
	return `#${value.toUpperCase()}`;
}

/** 色块上的字：只在黑白里选，够一枚色块读得清。 */
function contrastingInk(hex: string): string {
	const value = Number.parseInt(hex.slice(1), 16);
	const luminance = (0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)) / 255;
	return luminance > 0.6 ? "#1a1c1f" : "#ffffff";
}

/**
 * 那枚色块。里面的输入框是色块的一部分（底色就是它编辑的颜色），不是一个单独的输入框，所以不用 Input 的外观。
 */
export function ColorField({
	value,
	onChange,
	label,
	readOnly = false,
}: {
	value: string;
	onChange: (value: string) => void;
	label: string;
	readOnly?: boolean;
}) {
	const [draft, setDraft] = useState(() => canonical(value) ?? value);
	const swatch = canonical(draft);
	const valid = swatch !== null;

	// 切主题时这一行编辑的是另一个颜色；useState 只在第一次取初值。比较解析后的颜色，打字打到一半不会被改写。
	useEffect(() => {
		setDraft((now) => (!readOnly && canonical(now) === canonical(value) ? now : (canonical(value) ?? value)));
	}, [value, readOnly]);

	const background = swatch ?? "transparent";
	const ink = swatch ? contrastingInk(swatch) : undefined;
	return (
		<label className="flex h-7.5 cursor-pointer items-center gap-2 rounded-lg px-2.5 transition-colors" style={{ background, color: ink }}>
			<span className="size-3.5 rounded-full border border-current opacity-60" />
			<input
				readOnly={readOnly}
				value={draft}
				onChange={(event) => {
					setDraft(event.target.value);
					// 一能解析就生效，拖着改的时候实时看到。
					const next = canonical(event.target.value);
					if (next) onChange(next);
				}}
				onBlur={() => !valid && setDraft(canonical(value) ?? value)}
				spellCheck={false}
				aria-label={label}
				className={`w-[74px] bg-transparent font-mono text-label tracking-wide outline-none ${valid ? "" : "text-danger"}`}
			/>
		</label>
	);
}
