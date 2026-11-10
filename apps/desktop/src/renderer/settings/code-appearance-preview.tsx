/** 双主题共用一份可编辑样例和语法解析，排版改变时固定视口不推走设置控件。 */
import { type CodeThemeSpec, IconButton, OverlayScrollbar, Textarea, useI18n } from "@plume/ui";
import { RotateCcw } from "@plume/ui/icons";
import type { Language } from "@codemirror/language";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { loadFenceLanguage, sharedHighlightStyle, tokenize, type Token } from "../markdown/highlight.ts";

export interface CodeTypography {
	fontFamily: string;
	fontSize: number;
	lineHeight: number;
	/** em，跟着字号缩放。 */
	letterSpacing: number;
}

// i18n-exempt: 样例注释用于展示代码字体的中文回退和注释配色，不是界面文案。
const SAMPLE = `// 把名字招呼一下
function greet(name: string): string {
  const times = 2;
  return \`Hello, \${name}!\`.repeat(times);
}`;
const DIFF_ROWS: Record<number, "add" | "remove"> = { 2: "remove", 3: "add" };

export function CodeAppearancePreview({ lightTheme, darkTheme, type }: { lightTheme: CodeThemeSpec; darkTheme: CodeThemeSpec; type: CodeTypography }) {
	const { t } = useI18n();
	const [draft, setDraft] = useState<string | null>(null);
	const [language, setLanguage] = useState<Language | null>(null);
	useEffect(() => {
		let live = true;
		void loadFenceLanguage("ts").then((loaded) => {
			if (live) setLanguage(loaded);
		});
		return () => {
			live = false;
		};
	}, []);
	const code = draft ?? SAMPLE;
	// 只解析一次再分行，多行注释、模板字符串的颜色不会在换行处丢失。
	const lines = useMemo(() => splitLines(language ? tokenize(code, language, sharedHighlightStyle()) : [{ text: code, className: "" }]), [code, language]);
	const typography = {
		"--plume-code-font": type.fontFamily,
		"--plume-code-size": `${type.fontSize}px`,
		"--plume-code-line-height": String(type.lineHeight),
		"--plume-code-tracking": `${type.letterSpacing}em`,
	} as CSSProperties;
	return (
		<div className="@container" style={typography}>
			<div className="grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-2">
				{[lightTheme, darkTheme].map((theme) => (
					<CodeSnippetBox
						key={theme.mode}
						theme={theme}
						label={t(theme.mode === "light" ? "codePreview.light" : "codePreview.dark")}
						code={code}
						lines={lines}
						stock={draft === null}
						onDraft={setDraft}
					/>
				))}
			</div>
		</div>
	);
}

// 两层每一个影响字符位置的属性都必须相同，否则光标会偏离底下的字。
const METRICS: CSSProperties = {
	fontFamily: "var(--plume-code-font)",
	fontSize: "var(--plume-code-size)",
	fontWeight: 400,
	lineHeight: "var(--plume-code-line-height)",
	letterSpacing: "var(--plume-code-tracking)",
	whiteSpace: "pre",
	tabSize: 2,
};

function CodeSnippetBox({
	theme,
	label,
	code,
	lines,
	stock,
	onDraft,
}: {
	theme: CodeThemeSpec;
	label: string;
	code: string;
	lines: Token[][];
	stock: boolean;
	onDraft: (next: string | null) => void;
}) {
	const { t } = useI18n();
	const body = useRef<HTMLDivElement>(null);
	const palette = {
		"--plume-code-bg": theme.background,
		"--plume-code-fg": theme.foreground,
		"--plume-diff-add": theme.addedBg,
		"--plume-diff-remove": theme.removedBg,
		...Object.fromEntries(Object.entries(theme.tokens ?? {}).map(([name, color]) => [`--plume-syntax-${name}`, color])),
		// 预览里的辅助文字和滚动条也取自己的前景，不继承窗口此刻的深浅色。
		"--plume-ink": "var(--plume-code-fg)",
		"--plume-ink-faint": "var(--plume-code-fg)",
		"--plume-line-soft": "color-mix(in srgb, var(--plume-code-fg) 10%, transparent)",
		"--plume-card-hover": "color-mix(in srgb, var(--plume-code-fg) 5%, transparent)",
		"--plume-elevated": "color-mix(in srgb, var(--plume-code-fg) 8.5%, transparent)",
		backgroundColor: "var(--plume-code-bg)",
		color: "var(--plume-code-fg)",
		colorScheme: theme.mode,
	} as CSSProperties;
	return (
		<div className="min-w-0 overflow-hidden rounded-lg border border-line-soft" style={palette} data-code-preview={theme.mode}>
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-3 py-1.5 text-caption">
				<span className="font-medium opacity-60">{label}</span>
				<div className="flex min-w-0 items-center gap-1.5">
					{!stock && <IconButton size="xs" label={t("codePreview.restore")} onClick={() => onDraft(null)} icon={<RotateCcw size={11} strokeWidth={2} />} />}
					<span className="min-w-0 break-words opacity-60">{theme.labelKey ? t(theme.labelKey) : theme.label}</span>
				</div>
			</div>
			<div className="plume-scroll-host relative">
				<div ref={body} className="plume-scroll relative overflow-auto py-2" style={{ height: 168 }}>
					<div className="relative w-max min-w-full px-3" style={METRICS}>
						<div aria-hidden>
							{lines.map((line, index) => {
								const diff = stock ? DIFF_ROWS[index + 1] : undefined;
								return (
									<div
										key={index}
										className="-mx-3 px-3"
										style={diff ? { backgroundColor: diff === "add" ? "var(--plume-diff-add)" : "var(--plume-diff-remove)" } : undefined}
									>
										{line.length === 0
											? "\u200b"
											: line.map((piece, at) => (
													<span key={at} className={piece.className}>
														{piece.text}
													</span>
												))}
									</div>
								);
							})}
						</div>
						<Textarea
							value={code}
							onChange={(event) => onDraft(event.target.value)}
							spellCheck={false}
							wrap="off"
							aria-label={t("codePreview.editable", { label })}
							className="absolute inset-0 m-0 h-full w-full resize-none overflow-hidden border-0 bg-transparent px-3 py-0 text-transparent"
							style={{ ...METRICS, caretColor: "var(--plume-code-fg)" }}
						/>
					</div>
				</div>
				<OverlayScrollbar viewport={body} orientation="vertical" />
				<OverlayScrollbar viewport={body} orientation="horizontal" />
			</div>
		</div>
	);
}

function splitLines(pieces: Token[]): Token[][] {
	const lines: Token[][] = [[]];
	for (const piece of pieces) {
		for (const [index, text] of piece.text.split("\n").entries()) {
			if (index > 0) lines.push([]);
			if (text) lines[lines.length - 1]!.push({ text, className: piece.className });
		}
	}
	return lines;
}
