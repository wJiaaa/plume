import {
	Button,
	DARK_CODE_THEMES,
	findCodeTheme,
	InlineSelect,
	LIGHT_CODE_THEMES,
	NumberField,
	Segmented,
	Text,
	Toggle,
	useI18n,
	withHanFallback,
} from "@plume/ui";
import { RotateCcw } from "@plume/ui/icons";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { type Appearance, type AppearancePatch, CODE_DEFAULTS, resetAppearancePatch } from "../../shared/appearance.ts";
import { tokenValue, useDark } from "../appearance-settings.ts";
import { ColorField, PixelField } from "./appearance-controls.tsx";
import { CodeAppearancePreview } from "./code-appearance-preview.tsx";
import { codeFontMenu, fontAvailable, matchCodeFont, queryInstalledFonts, type LocalFonts } from "./code-fonts.ts";
import { Card, SectionTitle, TextInput } from "./controls.tsx";
import { readableInk } from "./readable-ink.ts";

const CUSTOM_FONT = "__custom__";

export function CodeAppearanceSettings({ appearance, patch }: { appearance: Appearance; patch: (patch: AppearancePatch) => void }) {
	const { t } = useI18n();
	const dark = useDark();
	const [customFont, setCustomFont] = useState(false);
	const [fontDraft, setFontDraft] = useState<string | null>(null);
	const [localFonts, setLocalFonts] = useState<LocalFonts | null>(null);
	useEffect(() => {
		let live = true;
		void queryInstalledFonts().then((found) => {
			if (live) setLocalFonts(found);
		});
		return () => {
			live = false;
		};
	}, []);

	const font = appearance.codeFont ?? tokenValue("font-mono");
	const fontSize = appearance.codeFontSize ?? Number.parseFloat(tokenValue("code-size"));
	const lineHeight = appearance.codeLineHeight ?? Number.parseFloat(tokenValue("code-line-height"));
	const letterSpacing = appearance.codeLetterSpacing ?? Number.parseFloat(tokenValue("code-tracking"));
	// CSS token 的换行不属于字体名，匹配菜单时先折叠；用户手写的栈原样保留。
	const currentFont = matchCodeFont(appearance.codeFont ?? font.replace(/\s+/g, " "));
	const fontOptions = codeFontMenu(localFonts, currentFont);
	const lightTheme = findCodeTheme(appearance.codeLightTheme ?? CODE_DEFAULTS.codeLightTheme, "light");
	const darkTheme = findCodeTheme(appearance.codeDarkTheme ?? CODE_DEFAULTS.codeDarkTheme, "dark");
	const inlineBg =
		(dark ? appearance.inlineCodeDarkBg : appearance.inlineCodeLightBg) ?? (dark ? CODE_DEFAULTS.inlineCodeDarkBg : CODE_DEFAULTS.inlineCodeLightBg);
	const savedInlineFg = dark ? appearance.inlineCodeDarkFg : appearance.inlineCodeLightFg;
	const inlineFg = savedInlineFg ?? (dark ? CODE_DEFAULTS.inlineCodeDarkFg : CODE_DEFAULTS.inlineCodeLightFg);
	const inlineFgIsAuto = savedInlineFg === undefined || inlineFg.toUpperCase() === readableInk(inlineBg).toUpperCase();

	return (
		<section>
			<div className="flex items-baseline justify-between gap-x-3">
				<SectionTitle>{t("appearance.codeSection")}</SectionTitle>
				<Button
					size="xs"
					variant="subtle"
					className="mb-3"
					onClick={() => {
						setCustomFont(false);
						setFontDraft(null);
						patch(resetAppearancePatch(appearance, true));
					}}
					icon={<RotateCcw size={13} strokeWidth={1.8} aria-hidden />}
				>
					{t("appearance.resetDefaults")}
				</Button>
			</div>
			<Card className="@container min-w-0 space-y-4 p-4" data-plume-code-appearance="">
				<CodeRow
					title={t("appearance.lightSyntax")}
					detail={t("appearance.lightSyntaxDetail")}
					control={
						<InlineSelect
							ariaLabel={t("appearance.lightSyntax")}
							value={lightTheme.id}
							onChange={(codeLightTheme) => patch({ codeLightTheme })}
							options={LIGHT_CODE_THEMES.map((theme) => ({ value: theme.id, label: theme.labelKey ? t(theme.labelKey) : theme.label }))}
						/>
					}
				/>
				<CodeRow
					title={t("appearance.darkSyntax")}
					detail={t("appearance.darkSyntaxDetail")}
					control={
						<InlineSelect
							ariaLabel={t("appearance.darkSyntax")}
							value={darkTheme.id}
							onChange={(codeDarkTheme) => patch({ codeDarkTheme })}
							options={DARK_CODE_THEMES.map((theme) => ({ value: theme.id, label: theme.labelKey ? t(theme.labelKey) : theme.label }))}
						/>
					}
				/>
				<CodeRow
					title={t("appearance.inlineCode")}
					detail={t("appearance.inlineCodeDetail")}
					control={
						<div className="min-w-0 max-w-full overflow-x-auto">
							<Segmented
								value={appearance.inlineCode ?? CODE_DEFAULTS.inlineCode}
								onChange={(inlineCode) => patch({ inlineCode })}
								options={[
									{ value: "app", label: t("appearance.inlineCodeApp") },
									{ value: "syntax", label: t("appearance.inlineCodeSyntax") },
									{ value: "custom", label: t("appearance.custom") },
								]}
							/>
						</div>
					}
				/>
				{appearance.inlineCode === "custom" && (
					<div className="flex flex-col gap-3 border-t border-line-soft pt-3">
						<div className="flex items-center justify-between gap-3">
							<Text size="label">{t(dark ? "appearance.inlineCodeDarkBg" : "appearance.inlineCodeLightBg")}</Text>
							<ColorField
								label={t(dark ? "appearance.inlineCodeDarkBg" : "appearance.inlineCodeLightBg")}
								value={inlineBg}
								onChange={(value) => {
									// 只有字色还没手改时才跟随底色；不另存会和颜色失步的自动标记。
									const followed = inlineFgIsAuto ? readableInk(value) : inlineFg;
									patch(dark ? { inlineCodeDarkBg: value, inlineCodeDarkFg: followed } : { inlineCodeLightBg: value, inlineCodeLightFg: followed });
								}}
							/>
						</div>
						<div className="flex items-center justify-between gap-3">
							<Text size="label">
								{t(dark ? "appearance.inlineCodeDarkFg" : "appearance.inlineCodeLightFg")}
								{inlineFgIsAuto && (
									<Text size="caption" tone="faint" className="ml-2">
										{t("appearance.inlineCodeFollowsBg")}
									</Text>
								)}
							</Text>
							<ColorField
								label={t(dark ? "appearance.inlineCodeDarkFg" : "appearance.inlineCodeLightFg")}
								value={inlineFg}
								onChange={(value) => patch(dark ? { inlineCodeDarkFg: value } : { inlineCodeLightFg: value })}
							/>
						</div>
					</div>
				)}
				<CodeRow
					title={t("appearance.inlineCodeBorder")}
					detail={t("appearance.inlineCodeBorderDetail")}
					control={
						<Toggle
							checked={appearance.inlineCodeBorder ?? CODE_DEFAULTS.inlineCodeBorder}
							onChange={(inlineCodeBorder) => patch({ inlineCodeBorder })}
							ariaLabel={t("appearance.inlineCodeBorder")}
						/>
					}
				/>
				<div className="markdown rounded-lg border border-line-soft bg-shell px-3 py-2.5">
					<p>
						{t("codePreview.inlineSentence")
							.split("`")
							.map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>))}
					</p>
				</div>
				<div className="pt-2">
					<CodeAppearancePreview
						lightTheme={lightTheme}
						darkTheme={darkTheme}
						type={{ fontFamily: withHanFallback(font), fontSize, lineHeight, letterSpacing }}
					/>
				</div>
				<CodeRow
					title={t("appearance.codeFont")}
					detail={t("appearance.codeFontDetail")}
					control={
						<div className="flex min-w-0 max-w-full">
							<InlineSelect
								ariaLabel={t("appearance.codeFont")}
								value={customFont ? CUSTOM_FONT : (currentFont?.stack ?? CUSTOM_FONT)}
								onChange={(next) => {
									if (next === CUSTOM_FONT) {
										setCustomFont(true);
										return;
									}
									setCustomFont(false);
									setFontDraft(null);
									patch({ codeFont: next });
								}}
								options={[
									...fontOptions.map((option) => {
										const name = option.labelKey ? t(option.labelKey) : option.label;
										return { value: option.stack, label: fontAvailable(option, localFonts) ? name : t("appearance.fontNotInstalled", { name }) };
									}),
									{ value: CUSTOM_FONT, label: t("appearance.custom") },
								]}
							/>
						</div>
					}
				/>
				{(customFont || !currentFont) && (
					<CodeRow
						title={t("appearance.customStack")}
						detail={t("appearance.fontStack")}
						control={
							<TextInput
								value={fontDraft ?? font}
								onChange={(codeFont) => {
									setCustomFont(true);
									setFontDraft(codeFont);
									patch({ codeFont: codeFont.trim() ? codeFont : null });
								}}
								onBlur={() => setFontDraft(null)}
								mono
								aria-label={t("appearance.customStack")}
								placeholder={'"Fira Code", ui-monospace, Menlo, monospace'}
								className="w-full min-w-0 @md:w-[260px]"
							/>
						}
					/>
				)}
				<CodeRow
					title={t("appearance.codeFontSize")}
					detail={t("appearance.codeFontSizeDetail")}
					control={
						<PixelField
							value={fontSize}
							min={10}
							max={20}
							onChange={(codeFontSize) => patch({ codeFontSize })}
							label={t("appearance.codeFontSize")}
							name="codeFontSize"
						/>
					}
				/>
				<CodeRow
					title={t("appearance.lineHeightSection")}
					detail={t("appearance.lineHeightDetail")}
					control={
						<div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 overflow-x-auto">
							<Segmented
								value={String(lineHeight)}
								onChange={(height) => patch({ codeLineHeight: Number(height) })}
								options={[
									{ value: "1.4", label: t("appearance.compact") },
									{ value: "1.6", label: t("common.standard") },
									{ value: "1.8", label: t("appearance.relaxed") },
									{ value: "2", label: t("appearance.widest") },
								]}
							/>
							<NumberField
								value={lineHeight}
								min={1}
								max={3}
								step={0.05}
								width={72}
								label={t("appearance.lineHeight")}
								name="codeLineHeight"
								onChange={(codeLineHeight) => patch({ codeLineHeight })}
							/>
						</div>
					}
				/>
				<CodeRow
					title={t("appearance.trackingSection")}
					detail={t("appearance.trackingDetail")}
					control={
						<div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 overflow-x-auto">
							<Segmented
								value={String(letterSpacing)}
								onChange={(spacing) => patch({ codeLetterSpacing: Number(spacing) })}
								options={[
									{ value: "-0.02", label: t("appearance.tighten") },
									{ value: "0", label: t("common.default") },
									{ value: "0.02", label: t("appearance.loosen") },
									{ value: "0.04", label: t("appearance.wider") },
								]}
							/>
							<NumberField
								value={letterSpacing}
								min={-0.1}
								max={0.2}
								step={0.01}
								width={72}
								label={t("appearance.tracking")}
								name="codeLetterSpacing"
								onChange={(codeLetterSpacing) => patch({ codeLetterSpacing })}
							/>
						</div>
					}
				/>
			</Card>
		</section>
	);
}

// 代码设置共用卡片内边距，行间用顶部细线；说明比控件字号小一档，不套普通设置行的整行留白。
function CodeRow({ title, detail, control }: { title: ReactNode; detail: ReactNode; control: ReactNode }) {
	return (
		<div
			data-settings-row
			className="flex flex-col gap-3 border-t border-line-soft pt-3 first:border-t-0 first:pt-0 @md:flex-row @md:items-center @md:justify-between"
		>
			<div className="min-w-0 flex-1">
				<Text as="div" size="label" weight="medium">
					{title}
				</Text>
				<Text as="div" size="caption" tone="muted">
					{detail}
				</Text>
			</div>
			<div className="flex min-w-0 max-w-full shrink-0 items-center">{control}</div>
		</div>
	);
}
