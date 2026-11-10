/**
 * 样式检查（`pnpm check` 的一部分）：把 spec/tech/styling.md 里的约定变成能失败的检查。
 *
 * 1. 依赖 token 的类名（颜色、字号、圆角、阴影、字体、动效曲线）必须真能生成样式。Tailwind 自带的色板、字号、圆角
 *    已经清空，写了 `text-sm`、`bg-gray-100` 或打错字不会报错，只是没有样式；这里用产品的样式入口编译每个类名来查。
 * 2. 颜色、字号、圆角、阴影、字体不写任意值（`text-[13px]`、`bg-[#fff]`），要用就先加 token。布局的任意值不管。
 * 3. 代码里不写色值（#rrggbb、rgb()……）：颜色只在 theme.css 里定义，其他地方用 token 类或 var(--plume-*)。
 * 4. @plume/contract/ui 的 SkinToken 和 theme.css 里的 token 一一对应。
 * 5. 插件单独构建，产品扫不到插件自己写的类名：插件的 className 里不能有 Tailwind 类，用 @plume/styles 导出的组合。
 *    插件自己的 CSS 只管布局：字号、行高、字距、字体、字重、圆角、阴影只能是单个 var(--plume-*) 或 inherit 这类关键字。
 *    文字用 @plume/ui 的 Text，档位改了插件跟着变；在 CSS 里照着 calc 抄一份档位，theme.css 一改就漂开。
 * 6. 过渡时长只用 --plume-t-* 三档（`duration-150`、`transition: 200ms` 不行）：减少动态效果靠统一压时长，手写的数跟着不变。
 * 7. 行内 style 里的颜色、圆角、字号、字体、阴影、过渡只能取 var(--plume-*)，不写字面量。
 * 8. 次要文字（ink-muted、ink-faint）在每一种实色的面上对比度够：muted ≥ 4.5:1，faint ≥ 3:1，浅色深色都算。
 *    直接按 theme.css 里的声明算 color-mix，不另抄一份公式。
 * 9. 按下不缩放、不位移（`active:scale-95`、`active:translate-y-px`）：按下的反馈是底色深一档。
 *
 * 只看字符串字面量里的内容，注释不查。例外写在下面的 ALLOWED_COLORS 里，每条带原因。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { compile } from "@tailwindcss/node";
import { MARKET_DIR } from "./market.mjs";

const root = resolve(import.meta.dirname, "..");
const rendererDir = join(root, "apps/desktop/src/renderer");
const themeFile = join(root, "packages/client/styles/src/theme.css");
const skinFile = join(root, "packages/contract/src/ui.ts");

/** 产品的 Tailwind 扫描的目录（见 apps/desktop/src/renderer/styles.css 的 @source），规则 1–3 都查。 */
const SCANNED = ["apps/desktop/src/renderer", "packages/client"];
/** 不经 Tailwind 的代码：只查规则 3。 */
const OTHER = ["apps/desktop/src/main", "apps/desktop/src/preload"];
/** 插件：查规则 3 和 5。市场插件在旁边的插件仓库里（scripts/market.mjs）。插件 SDK 的模板就是仓库外插件的起点，和插件按同一套规则查。 */
const PLUGINS = [MARKET_DIR, "packages/builtin", "packages/sdk/plugin-sdk/template"];

/** 允许出现的色值：文件 → 值 → 原因。 */
const ALLOWED_COLORS = {
	"../plume-plugins/plugins/preview/test/interaction.test.ts": { "*": "校验页面提供的十六进制色值，不是界面主题颜色" },
	"../plume-plugins/plugins/review/src/review.ts": { "#123": "审阅流程正文里举例的 PR 编号，不是颜色" },
	"apps/desktop/src/main/smoke-preview.ts": { "*": "冒烟页面的设计旋钮初值，用来验证用户选色，不是宿主界面的固定颜色" },
	"packages/client/ui/src/inputs/ColorField.tsx": { "*": "色块底色来自用户输入，字色按亮度选择黑白，不跟随主题" },
	"packages/client/styles/src/theme.css": { "*": "token 就定义在这里" },
	"packages/client/ui/src/lib/code/themes.ts": { "*": "代码主题是独立配色表，用户选中后写进代码 token；预览需要同时画出深浅两套原色" },
	"apps/desktop/src/renderer/settings/readable-ink.ts": { "*": "从用户的行内代码底色计算同色相且满足对比度的字色，结果作为设置值而非固定界面颜色" },
	"apps/desktop/src/renderer/settings/appearance-controls.tsx": {
		"*": "外观页的主题缩略图画的是“浅色”“深色”各自的样子、配色预设是种子色值本身、色块上的字只在黑白里选，都和此刻的主题无关，不能用跟着主题变的 token",
	},
	"apps/desktop/src/renderer/settings/models/ProviderAvatar.tsx": {
		"*": "供应商头像的色相由名字算出，同一个供应商始终是同一个颜色，不在种子推导的色阶里；字色往 ink 混，浅深主题都读得清",
	},
	"apps/desktop/src/renderer/models/ModelIcon.tsx": {
		"*": "模型品牌标是各家官方发布的矢量和配色，是商标本身，不跟皮肤变",
	},
	"../plume-plugins/plugins/usage/src/ModelIcon.tsx": {
		"*": "使用统计插件自带的一份模型品牌标，同上：各家官方发布的矢量和配色，是商标本身，不跟皮肤变",
	},
	"packages/client/ui/src/fileIcon.tsx": {
		"*": "文件类型图标的颜色是编辑器里通行的约定（TS 蓝、JS 黄……），不跟皮肤变，也不在种子推导的色阶里；浅深两套各给一个值",
	},
	"apps/desktop/src/renderer/composer/attachments/FileKindIcon.tsx": {
		"*": "附件门类图标的颜色是通行的约定（Word 蓝、Excel 绿、PDF 红），不跟主题和皮肤变，也不在种子推导的色阶里",
	},
	"../plume-plugins/plugins/terminal/src/look.ts": {
		"*": "xterm 画在 canvas 上，只认字面色值：十六个 ANSI 槽是程序说的「红」「绿」，不能映射成 token；读不到 CSS 变量时的底色、字色兜底同理",
	},
	"../plume-plugins/plugins/terminal/src/TerminalSearch.tsx": {
		"*": "xterm 的查找高亮只认 #RRGGBB，用不了 CSS 变量；琥珀色在浅深两种主题下各一组，匹配到的字还读得清",
	},
	"../plume-plugins/plugins/ssh/src/look.ts": {
		"*": "SSH 插件的终端同样是 xterm，画在 canvas 上只认字面色值：ANSI 槽和读不到 CSS 变量时的兜底，理由同 plugins/terminal/src/look.ts",
	},
	"../plume-plugins/plugins/ssh/src/TerminalSearch.tsx": {
		"*": "SSH 插件终端的查找高亮同样只认 #RRGGBB，理由同 plugins/terminal/src/TerminalSearch.tsx",
	},
	"../plume-plugins/plugins/browser/src/page-scripts.ts": {
		"*": "选取元素时的框和标签画在网页里（闭合的 shadow root），底下是网页自己的颜色，和 Plume 的主题、皮肤无关，页面里也读不到 Plume 的 token",
	},
	"../plume-plugins/plugins/screenshot/src/screenshot.css": {
		"*": "截图浮层、放大镜、钉图窗口压在别的应用的屏幕上，底下什么颜色都可能有：深色玻璃加白字和压暗都是固定的，跟主题和皮肤变就会在某些屏幕上看不见；SVG 遮罩只认黑白",
	},
	"../plume-plugins/plugins/skin-studio/src/presets.ts": { "*": "工坊的预设皮肤是持久化配色数据，供缩略图预览和 ui.skin 应用，不是固定界面色" },
	"../plume-plugins/plugins/skin-studio/src/palette.ts": { "*": "按皮肤的强调色选择黑或白的字，确保强调色实底上的文字可读" },
	"packages/client/ui/src/avatar/art.ts": {
		"*": "智能体头像的颜料：身体和眼睛是这幅画自己的颜色，亮暗主题、皮肤换了都不该跟着变",
	},
	"apps/desktop/src/main/smoke-skin-studio.ts": { "*": "真实 Electron 换肤验收中的输入和期望色值，用来核对皮肤覆盖与恢复，不是产品配色" },
	"apps/desktop/src/main/smoke.ts": {
		"#00000000": "冒烟断言毛玻璃开关改变了 Electron 窗口底色，不是界面配色",
		"#0d1117": "冒烟断言所选 GitHub Dark 主题的原色已写入 token，不能拿待测 token 自己作期望值",
		"#D6C300": "冒烟通过颜色输入框写入的用户自定义色，用来检查预览及存盘值",
	},
	"apps/desktop/src/main/index.ts": {
		"#171717": "窗口在页面加载前的底色，主进程读不到 CSS 变量，和 theme.css 的默认深色背景同步",
		"#f8f8f8": "同上，默认浅色背景",
		"#00000000": "毛玻璃窗口的底色必须全透明，Electron 只认色值字符串",
	},
	"packages/client/ui/src/overlay/Overlay.tsx": {
		"#000000": "遮罩持有的颜色（scrims.ts），用来压暗系统画在页面外的窗口按钮，要的是 #rrggbb 字符串；和 overlay.css 里 --plume-shade 画的遮罩是同一个黑",
	},
	"packages/client/styles/src/ui/image.css": {
		"*": "标注工具条、看图器的按钮压在任意图片（截图浮层里是别的应用的屏幕）上，永远是深色玻璃加白字；选中框、手柄是固定的天蓝，画布底是白纸。跟主题、皮肤变的面色压在图上会看不见",
	},
	"packages/client/ui/src/image/Annotator.tsx": {
		"*": "五种画笔颜色是画进图片里的数据，保存出去的图不能因为换了主题、皮肤而变色",
	},
	"packages/client/ui/src/image/AnnotateToolbar.tsx": {
		"*": "画笔颜色和文字底色是画进图片里的数据（色块、色名表按色值对应），和 Annotator.tsx 的 COLOURS 是同一组值",
	},
	"packages/client/ui/src/image/paint.ts": {
		"*": "canvas 只认字面色值：文字的白描边、步骤标号的白边和白字是画进图片的，不跟主题变",
	},
	"packages/client/ui/src/image/AnnotateCanvas.tsx": {
		"rgba(": "正在输入的文字的白描边，和 paint.ts 画上去的那道一致，不然文字落定时会变样",
	},
	"apps/desktop/src/renderer/image/ImageViewer.tsx": {
		"#000000": "看图器的遮罩持有的颜色（scrims.ts），压暗系统画在页面外的窗口按钮，要 #rrggbb 字符串；和 bg-shade/72 是同一个黑",
	},
};

/** 取值来自 theme 的工具类前缀。只有它们会因为 token 清空而悄悄失效，也只有它们禁止任意值。 */
const THEMED = [
	"text",
	"bg",
	"border",
	"border-[trblxyse]",
	"divide",
	"ring",
	"ring-offset",
	"outline",
	"fill",
	"stroke",
	"accent",
	"caret",
	"decoration",
	"from",
	"via",
	"to",
	"rounded",
	"rounded-[trblse]{1,2}",
	"shadow",
	"inset-shadow",
	"drop-shadow",
	"font",
	"leading",
	"tracking",
	"ease",
];
const VARIANTS = String.raw`(?:[^\s:]+:)*!?-?`;
const THEMED_CLASS = new RegExp(String.raw`^${VARIANTS}(?:${THEMED.join("|")})-`);
const ARBITRARY_VALUE = new RegExp(String.raw`^${VARIANTS}(?:${THEMED.join("|")})-\[`);
const ARBITRARY_PROPERTY =
	/^(?:[^\s:]+:)*\[(?:color|background|background-color|border-color|outline-color|fill|stroke|font|font-size|font-family|line-height|letter-spacing|border-radius|box-shadow)\s*:/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
/** 时长类名：数字和不取 --plume-t-* 的任意值不行；duration-[var(--plume-t-base)]、duration-(--plume-t-base) 可以。 */
const DURATION_CLASS = /^(?:[^\s:]+:)*duration-(?:\d|\[(?!var\(--plume-t-))/;
/** 按下时的缩放、位移（规则 9）。 */
const PRESS_MOTION = /^(?:[^\s:]+:)*active:-?(?:scale|translate)-/;
/** CSS 里的过渡时长。0.01ms 是减少动态效果那条规则本身。 */
const CSS_TRANSITION = /transition(?:-duration)?\s*:([^;]*)/g;
const TIME_LITERAL = /(?<![\w.-])(?!0\.01ms)\d*\.?\d+m?s\b/;
/** 行内 style 里只能取 var(--plume-*) 的属性；只看字面量值，类型注解不算。 */
const INLINE_STYLE =
	/\b(color|background|backgroundColor|borderColor|borderRadius|fontSize|lineHeight|letterSpacing|fontFamily|boxShadow|transition|transitionDuration)\s*:\s*(-?\d[\w.%]*|"[^"\n]*"|'[^'\n]*'|`[^`]*`)/g;
const INLINE_OK = /var\(--plume-|^["'`](?:transparent|inherit|currentColor|none)["'`]$/;
/** 插件 CSS 里归 token 和组件管的属性（规则 5）：值只能是单个 var(--plume-*) 或关键字，calc 拼档位也不行。 */
const PLUGIN_CSS_TYPE = /(?<![\w-])(font|font-size|line-height|letter-spacing|font-family|font-weight|border-radius|box-shadow)\s*:\s*([^;}]+)/g;
const PLUGIN_CSS_OK = /^(?:var\(--plume-[\w-]+\)|inherit|initial|unset|normal|none|0)$/;

const problems = [];
const report = (file, index, text, rule, message) => {
	const line = text.slice(0, index).split("\n").length;
	problems.push(`${relative(root, file)}:${line}  [${rule}] ${message}`);
};

async function filesUnder(dir, extensions) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await filesUnder(path, extensions)));
		else if (extensions.includes(extname(entry.name))) out.push(path);
	}
	return out;
}

/** 字符串字面量的内容和位置；模板字符串里的 ${…} 换成空格（里面的字面量会被单独取到）。 */
function stringLiterals(text) {
	const out = [];
	const pattern = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
	for (const match of text.matchAll(pattern)) {
		const body = match[1] ?? match[2] ?? match[3] ?? "";
		out.push({ index: match.index, body: match[3] === undefined ? body : body.replace(/\$\{[^}]*\}/g, " ") });
	}
	return out;
}

/** 去掉注释，保留换行，行号不变。字符串里的 // 不动。 */
function stripComments(text, css) {
	const pattern = css ? /\/\*[\s\S]*?\*\//g : /\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
	return text.replace(pattern, (match) => (match.startsWith("/") ? match.replace(/[^\n]/g, " ") : match));
}

/** 用产品的样式入口编译，问每个类名能不能生成样式。build 是增量的：输出变长了说明这个类名有效。 */
async function tailwind() {
	const entry = join(rendererDir, "styles.css");
	const compiler = await compile(await readFile(entry, "utf8"), { base: dirname(entry), onDependency() {} });
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

function checkColors(file, text) {
	const allowed = ALLOWED_COLORS[relative(root, file)] ?? {};
	if (allowed["*"]) return;
	const css = extname(file) === ".css";
	const code = stripComments(text, css);
	const chunks = css ? [{ index: 0, body: code }] : stringLiterals(code);
	for (const { index, body } of chunks) {
		for (const match of body.matchAll(COLOR_LITERAL)) {
			if (allowed[match[0]]) continue;
			report(file, index + match.index, text, "色值", `${match[0]}：颜色只在 theme.css 里定义，这里用 token 类或 var(--plume-*)`);
		}
	}
}

/** 行内 style 和 CSS 里的过渡时长（规则 6、7）。 */
function checkInline(file, text) {
	const css = extname(file) === ".css";
	const code = stripComments(text, css);
	if (css) {
		for (const match of code.matchAll(CSS_TRANSITION)) {
			const time = match[1].match(TIME_LITERAL);
			if (time) report(file, match.index, text, "时长", `${time[0]}：过渡时长用 var(--plume-t-quick / base / slow)`);
		}
		return;
	}
	// 主题表的 background 是待选的配色数据，不是 JSX 行内样式；色值许可仍由上面的表单独管理。
	if (relative(root, file) === "packages/client/ui/src/lib/code/themes.ts") return;
	for (const match of code.matchAll(INLINE_STYLE)) {
		if (!INLINE_OK.test(match[2]))
			report(file, match.index, text, "行内样式", `${match[1]}: ${match[2]}：行内样式的颜色、圆角、字号、字体、阴影、过渡只取 var(--plume-*)`);
	}
}

// ── 规则 8：按 theme.css 的声明算颜色 ───────────────────────────────

/** 取一个块里的 --plume-* 声明。 */
function declarations(block) {
	return Object.fromEntries([...stripComments(block, true).matchAll(/--plume-([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

/** 顶层逗号切分（括号里的不切）。 */
function splitTop(text, separator) {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")") depth--;
		else if (depth === 0 && text[i] === separator) {
			parts.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(text.slice(start).trim());
	return parts;
}

/** 数：0.6、52%（按 52 算）、calc(…) 里的 + 和 *、var(…)。 */
function number(expr, env) {
	expr = expr.trim();
	const variable = /^var\(--plume-([\w-]+)\)$/.exec(expr);
	if (variable) return number(env[variable[1]] ?? "", env);
	const calc = /^calc\((.*)\)$/.exec(expr);
	if (calc)
		return splitTop(calc[1].replace(/\s\+\s/g, " , "), ",").reduce(
			(sum, term) => sum + term.split(/\s\*\s/).reduce((product, factor) => product * number(factor, env), 1),
			0,
		);
	const literal = /^(-?\d*\.?\d+)%?$/.exec(expr);
	if (literal) return Number(literal[1]);
	throw new Error(`算不出数：${expr}`);
}

/** 颜色：#hex、transparent、var(…)、color-mix(in srgb, A p%, B)。返回 0–255 的 rgb 和 0–1 的 alpha。 */
function color(expr, env) {
	expr = expr.trim();
	const variable = /^var\(--plume-([\w-]+)\)$/.exec(expr);
	if (variable) return color(env[variable[1]] ?? "", env);
	if (expr === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(expr);
	if (hex) {
		const full = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
		return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16), a: 1 };
	}
	const mix = /^color-mix\(in srgb,(.*)\)$/.exec(expr);
	if (mix) {
		const [first, second] = splitTop(mix[1], ",");
		const [base, ...amount] = splitTop(first, " ").filter(Boolean);
		const a = color(base, env);
		const p = amount.length === 0 ? 50 : number(amount.join(" "), env);
		const b = color(second, env);
		const t = p / 100;
		const alpha = a.a * t + b.a * (1 - t);
		const channel = (key) => (alpha === 0 ? 0 : (a[key] * a.a * t + b[key] * b.a * (1 - t)) / alpha);
		return { r: channel("r"), g: channel("g"), b: channel("b"), a: alpha };
	}
	throw new Error(`算不出颜色：${expr}`);
}

function contrast(x, y) {
	const luminance = ({ r, g, b }) => {
		const linear = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
		return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
	};
	const [light, dark] = [luminance(x), luminance(y)].sort((a, b) => b - a);
	return (light + 0.05) / (dark + 0.05);
}

/** 次要文字坐得上去的实色面；card-hover、elevated 是半透明的薄纱，叠在这些面上，不单独算。 */
const SURFACES = ["shell", "sidebar", "card", "input", "float"];
const INK_MIN = { "ink-muted": 4.5, "ink-faint": 3 };

function checkContrast(theme) {
	const light = declarations(theme.slice(theme.indexOf(":root {"), theme.indexOf("\n}", theme.indexOf(":root {"))));
	const darkStart = theme.indexOf(":root {", theme.indexOf("@media (prefers-color-scheme: dark)"));
	const dark = { ...light, ...declarations(theme.slice(darkStart, theme.indexOf("\n\t}", darkStart))) };
	for (const [scheme, env] of [
		["浅色", light],
		["深色", dark],
	]) {
		for (const [ink, min] of Object.entries(INK_MIN)) {
			for (const surface of SURFACES) {
				const ratio = contrast(color(`var(--plume-${ink})`, env), color(`var(--plume-${surface})`, env));
				if (ratio < min)
					report(themeFile, theme.indexOf(`--plume-${ink}:`), theme, "对比度", `${scheme}：${ink} 在 ${surface} 上只有 ${ratio.toFixed(2)}:1，要 ≥ ${min}:1`);
			}
		}
	}
}

async function main() {
	const valid = await tailwind();

	// 规则 1–3：产品和渲染进程共享的库。
	for (const dir of SCANNED) {
		for (const file of await filesUnder(join(root, dir), [".ts", ".tsx", ".css"])) {
			const text = await readFile(file, "utf8");
			checkColors(file, text);
			checkInline(file, text);
			if (extname(file) === ".css") continue;
			for (const { index, body } of stringLiterals(stripComments(text, false))) {
				for (const candidate of body.split(/\s+/)) {
					if (ARBITRARY_VALUE.test(candidate) || ARBITRARY_PROPERTY.test(candidate)) {
						report(file, index, text, "任意值", `${candidate}：颜色、字号、圆角、阴影、字体用 token，没有合适的先在 theme.css 里加`);
					} else if (PRESS_MOTION.test(candidate)) {
						report(file, index, text, "按下", `${candidate}：按下不缩放、不位移，用 active:bg-elevated 这类底色变化`);
					} else if (DURATION_CLASS.test(candidate)) {
						report(file, index, text, "时长", `${candidate}：过渡时长用默认（quick）或 duration-[var(--plume-t-base)] / slow`);
					} else if (THEMED_CLASS.test(candidate) && !valid(candidate)) {
						report(file, index, text, "类名", `${candidate} 生成不了样式：不是 theme.css 里的 token，或者拼错了`);
					}
				}
			}
		}
	}

	// 规则 3：主进程、预加载脚本。
	for (const dir of OTHER) {
		for (const file of await filesUnder(join(root, dir), [".ts", ".tsx"])) checkColors(file, await readFile(file, "utf8"));
	}

	// 规则 3、5：插件。
	for (const file of (await Promise.all(PLUGINS.map((dir) => filesUnder(join(root, dir), [".ts", ".tsx", ".css"])))).flat()) {
		const text = await readFile(file, "utf8");
		checkColors(file, text);
		checkInline(file, text);
		for (const match of stripComments(text, extname(file) === ".css").matchAll(/className=(?:"([^"]*)"|\{\s*"([^"]*)"\s*\}|\{\s*`([^`]*)`\s*\})/g)) {
			const body = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
			for (const candidate of body.split(/\s+/).filter(Boolean)) {
				if (valid(candidate))
					report(file, match.index, text, "插件类名", `${candidate}：插件单独构建，产品扫不到它自己写的 Tailwind 类，用 @plume/styles 导出的组合`);
			}
		}
		if (extname(file) === ".css") {
			for (const match of stripComments(text, true).matchAll(PLUGIN_CSS_TYPE)) {
				if (!PLUGIN_CSS_OK.test(match[2].trim()))
					report(
						file,
						match.index,
						text,
						"插件样式",
						`${match[1]}: ${match[2].trim()}：插件 CSS 只管布局，文字用 @plume/ui 的 Text，圆角、阴影取单个 var(--plume-*)`,
					);
			}
		}
	}

	// 规则 4：SkinToken 和 theme.css 一一对应。推导系数（k）、动效（t、e）、阴影、控件和菜单、主输入框、对话列、窗格的尺寸不给皮肤改。
	const theme = await readFile(themeFile, "utf8");
	const rootBlock = theme.slice(theme.indexOf(":root {"), theme.indexOf("\n}", theme.indexOf(":root {")));
	const tokens = new Set(
		[...stripComments(rootBlock, true).matchAll(/--plume-([\w-]+)\s*:/g)]
			.map((match) => match[1])
			.filter((name) => !/^(?:k|k-.*|t-.*|e-.*|shadow-.*|control|menu-inset|menu-row|composer-.*|content|frame-pad|pane-chrome)$/.test(name)),
	);
	const skinText = await readFile(skinFile, "utf8");
	const union = skinText.slice(skinText.indexOf("export type SkinToken ="), skinText.indexOf(";", skinText.indexOf("export type SkinToken =")));
	const skin = new Set([...union.matchAll(/"([\w-]+)"/g)].map((match) => match[1]));
	for (const name of tokens)
		if (!skin.has(name))
			report(skinFile, skinText.indexOf("export type SkinToken ="), skinText, "SkinToken", `少了 "${name}"（theme.css 里有 --plume-${name}）`);
	for (const name of skin)
		if (!tokens.has(name))
			report(skinFile, skinText.indexOf("export type SkinToken ="), skinText, "SkinToken", `多了 "${name}"（theme.css 里没有 --plume-${name}）`);

	// 规则 8
	checkContrast(theme);

	if (problems.length > 0) {
		console.error(`样式检查没通过（规则见 spec/tech/styling.md 和 scripts/check-styles.mjs）：\n\n${problems.join("\n")}\n`);
		process.exit(1);
	}
	console.log("✓ 样式检查通过");
}

await main();
