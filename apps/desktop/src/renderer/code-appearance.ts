/** 代码主题只覆盖代码自己的 token；未选择主题时保留皮肤的配色。预览和实际正文共用。 */
import type { CodeThemeSpec } from "@plume/ui";
import { CODE_DEFAULTS, type Appearance } from "../shared/appearance.ts";

export function codePalette(appearance: Appearance, theme: CodeThemeSpec, dark: boolean): Record<string, string> {
	const values: Record<string, string> = {};
	const selected = dark ? appearance.codeDarkTheme : appearance.codeLightTheme;
	if (selected) {
		values["code-bg"] = theme.inherit ? "var(--plume-bg)" : theme.background!;
		values["code-fg"] = theme.inherit ? "var(--plume-ink)" : theme.foreground!;
		if (theme.addedBg) values["diff-add"] = theme.addedBg;
		if (theme.removedBg) values["diff-remove"] = theme.removedBg;
		for (const [name, color] of Object.entries(theme.tokens ?? {})) values[`syntax-${name}`] = color;
	}
	const mode = appearance.inlineCode ?? CODE_DEFAULTS.inlineCode;
	if (mode === "custom") {
		values["inline-code-bg"] =
			(dark ? appearance.inlineCodeDarkBg : appearance.inlineCodeLightBg) ?? (dark ? CODE_DEFAULTS.inlineCodeDarkBg : CODE_DEFAULTS.inlineCodeLightBg);
		values["inline-code-fg"] =
			(dark ? appearance.inlineCodeDarkFg : appearance.inlineCodeLightFg) ?? (dark ? CODE_DEFAULTS.inlineCodeDarkFg : CODE_DEFAULTS.inlineCodeLightFg);
	} else if (mode === "syntax") {
		values["inline-code-bg"] = "color-mix(in srgb, var(--plume-code-fg) 8%, var(--plume-code-bg))";
		values["inline-code-fg"] = "var(--plume-code-fg)";
	} else if (appearance.inlineCode === "app") {
		values["inline-code-bg"] = "var(--plume-card-hover)";
		values["inline-code-fg"] = "var(--plume-ink)";
	}
	if (appearance.inlineCodeBorder !== undefined) {
		values["inline-code-ring"] = appearance.inlineCodeBorder ? "color-mix(in srgb, var(--plume-inline-code-fg) 22%, transparent)" : "transparent";
	}
	return values;
}
