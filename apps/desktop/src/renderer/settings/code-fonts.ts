/** 代码字体存完整 CSS 字体栈；菜单列出预设和本机等宽字体，也保留自定义输入。 */

import type { MessageKey } from "@plume/ui";

export interface CodeFontOption {
	label: string;
	/** 保存完整字体栈，首选字体缺失时仍有回退。 */
	stack: string;
	/** 仅描述性名称需要翻译，由选择器按当前语言显示。 */
	labelKey?: MessageKey;
	/** 首选字体，用于检查安装状态和展示样例。 */
	family: string;
}

export const CODE_FONTS: CodeFontOption[] = [
	// 默认字体栈。
	{
		label: "System monospace",
		labelKey: "codeFonts.systemMono",
		family: "ui-monospace",
		stack:
			'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace',
	},
	{
		label: "JetBrains Mono",
		family: "JetBrains Mono",
		stack: '"JetBrains Mono", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{
		label: "SF Mono",
		family: "SF Mono",
		stack: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{ label: "Menlo", family: "Menlo", stack: 'Menlo, ui-monospace, "SF Mono", "PingFang SC", monospace' },
	{ label: "Monaco", family: "Monaco", stack: 'Monaco, Menlo, ui-monospace, "PingFang SC", monospace' },
	{
		label: "Fira Code",
		family: "Fira Code",
		stack: '"Fira Code", "Fira Mono", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{
		label: "Cascadia Code",
		family: "Cascadia Code",
		stack: '"Cascadia Code", "Cascadia Mono", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{
		label: "Source Code Pro",
		family: "Source Code Pro",
		stack: '"Source Code Pro", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{
		label: "IBM Plex Mono",
		family: "IBM Plex Mono",
		stack: '"IBM Plex Mono", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{
		label: "Roboto Mono",
		family: "Roboto Mono",
		stack: '"Roboto Mono", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{ label: "Consolas", family: "Consolas", stack: 'Consolas, ui-monospace, Menlo, "PingFang SC", monospace' },
];

/** 本机字体使用与预设相同的回退栈。 */
function installedStack(family: string): string {
	return `"${family}", ui-monospace, Menlo, "PingFang SC", monospace`;
}

const INSTALLED_STACK = new RegExp('^"([^"]+)", ui-monospace, Menlo, "PingFang SC", monospace$');

export interface LocalFonts {
	/** 全部已安装字体，用于检查预设是否可用。 */
	families: Set<string>;
	/** 预设之外的等宽字体，已按菜单顺序排列。 */
	extra: CodeFontOption[];
}

/**
 * 查询本机字体；API 不可用、权限拒绝或列表为空时返回 null，避免误报预设缺失。
 * API 不提供等宽标记，用字宽和句点高度排除比例字体、缺少拉丁字形的字体及符号字体。
 */
export async function queryInstalledFonts(): Promise<LocalFonts | null> {
	const query = (window as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
	if (!query) return null;
	let faces: { family: string }[];
	try {
		faces = await query();
	} catch {
		return null;
	}
	if (faces.length === 0) return null;
	const families = new Set(faces.map((face) => face.family));
	const ctx = document.createElement("canvas").getContext("2d");
	if (!ctx) return { families, extra: [] };
	const named = new Set(CODE_FONTS.map((option) => option.family));
	const extra = [...families]
		// 引号会提前截断保存的字体名。
		.filter((family) => !named.has(family) && !family.includes('"') && isMonospace(ctx, family))
		.sort((a, b) => a.localeCompare(b))
		.map((family) => ({ label: family, family, stack: installedStack(family) }));
	return { families, extra };
}

function isMonospace(ctx: CanvasRenderingContext2D, family: string): boolean {
	// 用比例字体兜底，避免缺少拉丁字形的字体借等宽回退通过检测。
	ctx.font = `16px "${family}", serif`;
	const narrow = ctx.measureText("iiiiiiiiii").width;
	if (narrow === 0) return false;
	if (Math.abs(narrow - ctx.measureText("WWWWWWWWWW").width) > 0.5) return false;
	if (Math.abs(narrow - ctx.measureText("..........").width) > 0.5) return false;
	return ctx.measureText(".").actualBoundingBoxAscent < ctx.measureText("H").actualBoundingBoxAscent * 0.4;
}

/** document.fonts.check 不能判断本机安装状态；拿不到列表时仍允许选择。 */
export function fontAvailable(option: CodeFontOption, local: LocalFonts | null): boolean {
	// 通用字体关键字始终可用。
	if (option.family.startsWith("ui-")) return true;
	return local ? local.families.has(option.family) : true;
}

/** 菜单只列可用预设和本机等宽字体，但保留当前项供界面标注缺失状态。 */
export function codeFontMenu(local: LocalFonts | null, current: CodeFontOption | null): CodeFontOption[] {
	const options = [...CODE_FONTS.filter((font) => fontAvailable(font, local) || font.stack === current?.stack), ...(local?.extra ?? [])];
	// 字体已卸载或查询尚未返回时，当前选择仍留在菜单中。
	if (current && !options.some((font) => font.stack === current.stack)) options.push(current);
	return options;
}

/** 匹配预设或本机字体的固定栈；手写的其他栈返回 null。 */
export function matchCodeFont(stack: string): CodeFontOption | null {
	const normalised = stack.trim();
	const preset = CODE_FONTS.find((option) => option.stack === normalised);
	if (preset) return preset;
	// 固定栈不依赖本机列表，字体卸载后仍能识别原来的选择。
	const family = INSTALLED_STACK.exec(normalised)?.[1];
	return family ? { label: family, family, stack: installedStack(family) } : null;
}
