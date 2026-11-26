/**
 * 插件的样式规则（插件检查 `plume-plugin check` 和 Plume 自己的 `pnpm check:styles` 用的是这同一份，约定见 Plume 仓库的 spec/tech/styling.md）：
 *
 * 默认只拦真正会出事故的两项（让第三方插件可以自由设计样式，@plume/ui 和 var(--plume-*) 作为推荐选项）：
 * - 插件类名：插件单独构建，产品扫不到插件自己写的类名，className 里不能有 Tailwind 类，用 @plume/styles 导出的组合或自己写的 CSS 类。
 * - 全局样式：插件的样式表直接挂在主文档里，CSS 选择器要带上自己的类 / ID 或放进 `@scope (.前缀)`，不能写裸标签、通配符或 `:root` 污染宿主和其他插件。
 *
 * 严格模式（`{ strict: true }`，Plume 本体仓库的内置插件 / 模板，或外部插件显式开启 `plume-plugin check --strict-style`）额外查设计系统一致性：
 * - 色值：代码里不写色值（#rrggbb、rgb()……），用 @plume/styles 的组合或 var(--plume-*)。确实和主题无关的文件
 *   （画在 canvas 上只认字面色值、画在别人的页面上……）在文件里写一行带 `color-exempt` 的注释，写明原因，整个文件不查色值。
 * - 时长、行内样式：CSS 里的过渡时长只用 var(--plume-t-*)；行内 style 里的颜色、圆角、字号、字体、阴影、过渡只取 var(--plume-*)。
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

/** 不包含 DOM 选择器的 at-rule：块内是关键帧或描述符，跳过不查。 */
const NON_SELECTOR_AT_RULES = new Set([
	"keyframes",
	"-webkit-keyframes",
	"-moz-keyframes",
	"font-face",
	"property",
	"page",
	"counter-style",
	"font-feature-values",
	"position-try",
]);

/** 跳过从 start 开始的字符串字面量（`"` 或 `'`），返回闭合引号之后的位置。 */
function skipQuoted(text, start, end) {
	const quote = text[start];
	let i = start + 1;
	while (i < end) {
		if (text[i] === "\\") i += 2;
		else if (text[i] === quote) return i + 1;
		else i++;
	}
	return end;
}

/** 从 open（`(`、`[` 或 `{`）找到配对的闭合符号位置；找不到返回 end。 */
function findMatching(text, open, closeChar, end) {
	const openChar = text[open];
	let depth = 0;
	for (let i = open; i < end; i++) {
		const ch = text[i];
		if (ch === '"' || ch === "'") {
			i = skipQuoted(text, i, end) - 1;
		} else if (ch === "\\") {
			i++;
		} else if (ch === openChar) {
			depth++;
		} else if (ch === closeChar && --depth === 0) {
			return i;
		}
	}
	return end;
}

/** 按顶层逗号切分选择器列表，保留每一段在原文里的起始偏移。 */
function splitSelectors(text, baseOffset) {
	const out = [];
	let paren = 0;
	let bracket = 0;
	let start = 0;
	const push = (from, to) => {
		const raw = text.slice(from, to);
		const lead = raw.length - raw.trimStart().length;
		const value = raw.trim();
		if (value) out.push({ index: baseOffset + from + lead, value });
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' || ch === "'") i = skipQuoted(text, i, text.length) - 1;
		else if (ch === "\\") i++;
		else if (ch === "(") paren++;
		else if (ch === ")" && paren > 0) paren--;
		else if (ch === "[") bracket++;
		else if (ch === "]" && bracket > 0) bracket--;
		else if (ch === "," && paren === 0 && bracket === 0) {
			push(start, i);
			start = i + 1;
		}
	}
	push(start, text.length);
	return out;
}

/**
 * 单个复杂选择器是否已限定作用域（不会波及宿主或其他插件）：
 * 需包含至少一个不在 `:not()` / `:has()` 内的类选择器（`.x`）或 ID 选择器（`#x`），
 * 或是全分支皆受限定的 `:is()` / `:where()` / `:matches()`，或是按名字隔离的 `::highlight(...)`。
 */
function isScopedSelector(selector) {
	const trimmed = selector.trim();
	if (!trimmed) return true;
	if (/^::highlight\([^)]+\)$/.test(trimmed)) return true;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === '"' || ch === "'") {
			i = skipQuoted(trimmed, i, trimmed.length) - 1;
		} else if (ch === "\\") {
			i++;
		} else if (ch === "[") {
			// 属性选择器里可能出现带 `.` 或 `#` 的值（如 [href="a.b"]），不算类或 ID 锚点。
			i = findMatching(trimmed, i, "]", trimmed.length);
		} else if (ch === "." || ch === "#") {
			const next = trimmed[i + 1];
			if (next && (/[a-zA-Z_-]|[^\x00-\x7f]/.test(next) || next === "\\")) return true;
		} else if (ch === ":") {
			const pseudo = trimmed.slice(i).match(/^::?([\w-]+)\(/);
			if (!pseudo) continue;
			const open = i + pseudo[0].length - 1;
			const close = findMatching(trimmed, open, ")", trimmed.length);
			const name = pseudo[1].toLowerCase();
			if (name === "is" || name === "where" || name === "matches") {
				const inner = trimmed.slice(open + 1, close);
				const branches = splitSelectors(inner, 0);
				if (branches.length > 0 && branches.every((branch) => isScopedSelector(branch.value))) return true;
			}
			// `:not(...)`、`:has(...)` 及其他函数伪类内部不视作目标元素的限定锚点，整体跳过。
			i = close;
		}
	}
	return false;
}

/** 扫描 CSS 中未限定作用域的全局选择器。返回 `{ index, rule, message }`。 */
function globalStyleProblems(text) {
	const code = stripComments(text, true);
	const found = [];

	const reportGlobal = (index, selector) =>
		found.push({
			index,
			rule: "全局样式",
			message: `${selector}：插件样式直接挂在主文档里，选择器要带上自己的类名或放进 @scope (.前缀) 里，避免影响宿主和其他插件`,
		});

	function scanBlock(start, end, scoped) {
		let i = start;
		while (i < end) {
			while (i < end && /\s/.test(code[i])) i++;
			if (i >= end) break;
			const headerStart = i;
			let paren = 0;
			let bracket = 0;
			let token = "";
			while (i < end) {
				const ch = code[i];
				if (ch === '"' || ch === "'") {
					i = skipQuoted(code, i, end);
					continue;
				}
				if (ch === "\\") {
					i += 2;
					continue;
				}
				if (ch === "(") paren++;
				else if (ch === ")" && paren > 0) paren--;
				else if (ch === "[") bracket++;
				else if (ch === "]" && bracket > 0) bracket--;
				else if (paren === 0 && bracket === 0 && (ch === ";" || ch === "{")) {
					token = ch;
					break;
				}
				i++;
			}
			if (token === ";") {
				i++;
				continue;
			}
			if (token !== "{") break;

			const braceStart = i;
			const braceEnd = findMatching(code, braceStart, "}", end);
			const headerRaw = code.slice(headerStart, braceStart);
			const header = headerRaw.trim();
			i = braceEnd < end ? braceEnd + 1 : end;

			if (!header) continue;
			if (header.startsWith("@")) {
				const at = header.match(/^@([\w-]+)/)?.[1]?.toLowerCase() ?? "";
				if (NON_SELECTOR_AT_RULES.has(at)) continue;
				if (at === "scope") {
					const open = headerRaw.indexOf("(");
					if (open < 0) {
						if (!scoped) reportGlobal(headerStart, "@scope");
						scanBlock(braceStart + 1, braceEnd, scoped);
					} else {
						const close = findMatching(headerRaw, open, ")", headerRaw.length);
						const rootExpr = headerRaw.slice(open + 1, close);
						const roots = splitSelectors(rootExpr, headerStart + open + 1);
						const rootScoped = roots.length > 0 && roots.every((entry) => isScopedSelector(entry.value));
						if (!scoped && !rootScoped) {
							for (const entry of roots) if (!isScopedSelector(entry.value)) reportGlobal(entry.index, `@scope (${entry.value})`);
							if (roots.length === 0) reportGlobal(headerStart, header);
						}
						scanBlock(braceStart + 1, braceEnd, scoped || rootScoped);
					}
					continue;
				}
				scanBlock(braceStart + 1, braceEnd, scoped);
				continue;
			}

			if (!scoped) {
				for (const { index, value } of splitSelectors(headerRaw, headerStart)) {
					if (!isScopedSelector(value)) reportGlobal(index, value);
				}
			}
			// 进入普通规则块（含 CSS 原生嵌套）：外层已检查并报告，嵌套子规则继承外层作用域，不再重复报。
			scanBlock(braceStart + 1, braceEnd, true);
		}
	}

	scanBlock(0, code.length, false);
	return found;
}

/**
 * 插件一个源文件的样式问题。返回 `{ index, rule, message }`。
 * @param {string} file 路径，按扩展名分 CSS 和代码
 * @param {string} text
 * @param {(candidate: string) => boolean} isTailwind 这个类名 Tailwind 生成得了样式
 * @param {{ strict?: boolean }} [options] strict 为真时追加色值、行内样式、过渡时长和 CSS 排版/圆角/阴影约束
 */
export function pluginStyleProblems(file, text, isTailwind, options = {}) {
	const css = extname(file) === ".css";
	const strict = Boolean(options.strict);
	const found = [];
	if (strict) {
		if (!COLOR_EXEMPT.test(text)) {
			for (const { index, value } of colorLiterals(text, css))
				found.push({ index, rule: "色值", message: `${value}：颜色跟着主题和皮肤走，用 @plume/styles 的组合或 var(--plume-*)` });
		}
		found.push(...inlineProblems(text, css));
	}
	for (const match of stripComments(text, css).matchAll(/className=(?:"([^"]*)"|\{\s*"([^"]*)"\s*\}|\{\s*`([^`]*)`\s*\})/g)) {
		const body = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
		for (const candidate of body.split(/\s+/).filter(Boolean)) {
			if (isTailwind(candidate))
				found.push({
					index: match.index,
					rule: "插件类名",
					message: `${candidate}：插件单独构建，产品扫不到它自己写的 Tailwind 类，用 @plume/styles 导出的组合或自己写的 CSS 类`,
				});
		}
	}
	if (css) {
		found.push(...globalStyleProblems(text));
		if (strict) {
			for (const match of stripComments(text, true).matchAll(PLUGIN_CSS_TYPE)) {
				if (!PLUGIN_CSS_OK.test(match[2].trim()))
					found.push({
						index: match.index,
						rule: "插件样式",
						message: `${match[1]}: ${match[2].trim()}：插件 CSS 只管布局，文字用 @plume/ui 的 Text，圆角、阴影取单个 var(--plume-*)`,
					});
			}
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
