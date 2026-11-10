/**
 * 插件的样式规则（插件检查 `plume-plugin check` 和 Plume 自己的 `pnpm check:styles` 用的是这同一份，约定见 Plume 仓库的 spec/tech/styling.md）：
 *
 * - 色值：代码里不写色值（#rrggbb、rgb()……），用 @plume/styles 的组合或 var(--plume-*)。确实和主题无关的文件
 *   （画在 canvas 上只认字面色值、画在别人的页面上……）在文件里写一行带 `color-exempt` 的注释，写明原因，整个文件不查色值。
 * - 时长、行内样式：CSS 里的过渡时长只用 var(--plume-t-*)；行内 style 里的颜色、圆角、字号、字体、阴影、过渡只取 var(--plume-*)。
 * - 插件类名：插件单独构建，产品扫不到插件自己写的类名，className 里不能有 Tailwind 类，用 @plume/styles 导出的组合。
 * - 插件 CSS 只管布局：字号、行高、字距、字体、字重、圆角、阴影只能是单个 var(--plume-*) 或 inherit 这类关键字。
 *
 * 只看字符串字面量（CSS 文件看全文），注释不查。
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
/** CSS 里的过渡时长。0.01ms 是减少动态效果那条规则本身。 */
const CSS_TRANSITION = /transition(?:-duration)?\s*:([^;]*)/g;
const TIME_LITERAL = /(?<![\w.-])(?!0\.01ms)\d*\.?\d+m?s\b/;
/** 行内 style 里只能取 var(--plume-*) 的属性；只看字面量值，类型注解不算。 */
const INLINE_STYLE =
	/\b(color|background|backgroundColor|borderColor|borderRadius|fontSize|lineHeight|letterSpacing|fontFamily|boxShadow|transition|transitionDuration)\s*:\s*(-?\d[\w.%]*|"[^"\n]*"|'[^'\n]*'|`[^`]*`)/g;
const INLINE_OK = /var\(--plume-|^["'`](?:transparent|inherit|currentColor|none)["'`]$/;
/** 插件 CSS 里归 token 和组件管的属性：值只能是单个 var(--plume-*) 或关键字，calc 拼档位也不行。 */
const PLUGIN_CSS_TYPE = /(?<![\w-])(font|font-size|line-height|letter-spacing|font-family|font-weight|border-radius|box-shadow)\s*:\s*([^;}]+)/g;
const PLUGIN_CSS_OK = /^(?:var\(--plume-[\w-]+\)|inherit|initial|unset|normal|none|0)$/;
/** 整个文件不查色值的标记，写在注释里，后面跟原因。 */
const COLOR_EXEMPT = /\bcolor-exempt\b/;

/** 字符串字面量的内容和位置；模板字符串里的 ${…} 换成空格（里面的字面量会被单独取到）。 */
export function stringLiterals(text) {
	const out = [];
	const pattern = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
	for (const match of text.matchAll(pattern)) {
		const body = match[1] ?? match[2] ?? match[3] ?? "";
		out.push({ index: match.index, body: match[3] === undefined ? body : body.replace(/\$\{[^}]*\}/g, " ") });
	}
	return out;
}

/** 去掉注释，保留换行，行号不变。字符串里的 // 不动。 */
export function stripComments(text, css) {
	const pattern = css ? /\/\*[\s\S]*?\*\//g : /\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
	return text.replace(pattern, (match) => (match.startsWith("/") ? match.replace(/[^\n]/g, " ") : match));
}

/**
 * 写死的色值。返回 `{ index, value }`，index 是在原文里的位置。
 * @param {string} text
 * @param {boolean} css
 */
export function colorLiterals(text, css) {
	const code = stripComments(text, css);
	const chunks = css ? [{ index: 0, body: code }] : stringLiterals(code);
	const found = [];
	for (const { index, body } of chunks) for (const match of body.matchAll(COLOR_LITERAL)) found.push({ index: index + match.index, value: match[0] });
	return found;
}

/**
 * 行内 style 和 CSS 里的过渡时长。返回 `{ index, rule, message }`。
 * @param {string} text
 * @param {boolean} css
 */
export function inlineProblems(text, css) {
	const code = stripComments(text, css);
	const found = [];
	if (css) {
		for (const match of code.matchAll(CSS_TRANSITION)) {
			const time = match[1].match(TIME_LITERAL);
			if (time) found.push({ index: match.index, rule: "时长", message: `${time[0]}：过渡时长用 var(--plume-t-quick / base / slow)` });
		}
		return found;
	}
	for (const match of code.matchAll(INLINE_STYLE)) {
		if (!INLINE_OK.test(match[2]))
			found.push({
				index: match.index,
				rule: "行内样式",
				message: `${match[1]}: ${match[2]}：行内样式的颜色、圆角、字号、字体、阴影、过渡只取 var(--plume-*)`,
			});
	}
	return found;
}

/**
 * 插件一个源文件的样式问题。返回 `{ index, rule, message }`。
 * @param {string} file 路径，按扩展名分 CSS 和代码
 * @param {string} text
 * @param {(candidate: string) => boolean} isTailwind 这个类名 Tailwind 生成得了样式
 */
export function pluginStyleProblems(file, text, isTailwind) {
	const css = extname(file) === ".css";
	const found = [];
	if (!COLOR_EXEMPT.test(text)) {
		for (const { index, value } of colorLiterals(text, css))
			found.push({ index, rule: "色值", message: `${value}：颜色跟着主题和皮肤走，用 @plume/styles 的组合或 var(--plume-*)` });
	}
	found.push(...inlineProblems(text, css));
	for (const match of stripComments(text, css).matchAll(/className=(?:"([^"]*)"|\{\s*"([^"]*)"\s*\}|\{\s*`([^`]*)`\s*\})/g)) {
		const body = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
		for (const candidate of body.split(/\s+/).filter(Boolean)) {
			if (isTailwind(candidate))
				found.push({
					index: match.index,
					rule: "插件类名",
					message: `${candidate}：插件单独构建，产品扫不到它自己写的 Tailwind 类，用 @plume/styles 导出的组合`,
				});
		}
	}
	if (css) {
		for (const match of stripComments(text, true).matchAll(PLUGIN_CSS_TYPE)) {
			if (!PLUGIN_CSS_OK.test(match[2].trim()))
				found.push({
					index: match.index,
					rule: "插件样式",
					message: `${match[1]}: ${match[2].trim()}：插件 CSS 只管布局，文字用 @plume/ui 的 Text，圆角、阴影取单个 var(--plume-*)`,
				});
		}
	}
	return found;
}

/**
 * 问一个类名能不能生成样式。compiler 是 Tailwind 的 compile() 的结果；build 是增量的：输出变长了说明这个类名有效。
 * @param {{ build(candidates: string[]): string }} compiler
 * @returns {(candidate: string) => boolean}
 */
export function tailwindProbe(compiler) {
	let last = compiler.build([]);
	const known = new Map();
	return (candidate) => {
		if (!known.has(candidate)) {
			const next = compiler.build([candidate]);
			known.set(candidate, next !== last);
			last = next;
		}
		return known.get(candidate);
	};
}

/**
 * 和产品一样的 Tailwind：Tailwind 本身加 Plume 的 theme.css（SDK 的 dist/theme.css，生成类型声明时复制进来）。
 * 产品清空了 Tailwind 自带的色板、字号，带上 theme.css 才和产品认的类名一致。
 */
export async function pluginTailwind() {
	const require = createRequire(import.meta.url);
	const { compile } = await import("tailwindcss");
	const tailwind = dirname(require.resolve("tailwindcss/package.json"));
	const theme = resolve(import.meta.dirname, "../../dist/theme.css");
	const compiler = await compile('@import "tailwindcss" source(none);\n@import "plume-theme";', {
		base: tailwind,
		async loadStylesheet(id, base) {
			const path = id === "tailwindcss" ? join(tailwind, "index.css") : id === "plume-theme" ? theme : resolve(base, id);
			return { path, base: dirname(path), content: await readFile(path, "utf8") };
		},
	});
	return tailwindProbe(compiler);
}
