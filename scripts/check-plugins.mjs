/**
 * 插件检查（`pnpm check` 的一部分）：写插件只靠 skill `skills/plume-plugin` 和公开接口，这里查两头都守住了；
 * 反过来，本体也不按名字认具体插件。
 *
 * 1. 内置插件（packages/builtin/*）和只给冒烟用的测试插件（packages/testing/*）只引用公开接口：规则和插件作者的 `plume-plugin check` 是同一份（插件 SDK 的 lib/lint/imports.mjs），
 *    另外允许 `packages/infra/` 下的通用库（不懂 agent 业务，构建时打进插件），同样要在 package.json 里声明。
 *    从 `@plume/ui` 引用的值只能是给插件用的名单里的（见规则 3）。市场插件在插件仓库里，由它自己的检查管。
 * 2. skill 跟得上接口：`PluginContext`、`UiContext` 的每个成员和 `Hooks` 的每个钩子名，skill 里都要提到
 *    （写成 `ctx.成员`、`ui.成员`、钩子名）；skill 里写的 `ctx.x`、`ui.x`、`hook("x"` 也必须真的存在。
 *    只查名字在不在，参数和语义变了还得人改 skill。
 * 3. 组件清单跟得上代码：`@plume/ui` 给插件用的名字列在 packages/client/ui/plugin-api.json（这就是它对插件公开的范围），
 *    插件从 `@plume/ui` 引用的值只能是这些名字，名单里的名字 `@plume/ui` 都要真的导出。skill 的 references/components.md
 *    由这份名单、源码里的签名和注释、`@plume/styles` 的类名组合生成，和代码对不上就失败，`--fix` 重新生成。
 * 4. 本体的代码里不出现插件名；5. 本体不按名字认插件的工具、提示词段和送达标签（基本的文件和命令工具除外）。
 * 6. 内置插件不按名字认别的插件：源码和带给模型的技能里不出现别的内置插件、市场插件的插件名和它们的工具名、段名。
 *    名单、匹配方式和例外在 scripts/check-core-names.mjs，规则的来由见 spec/domain/plugin-primitives.md。
 *
 *   node scripts/check-plugins.mjs          # 检查
 *   node scripts/check-plugins.mjs --fix    # 另外重新生成 references/components.md
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { importProblems, stripComments } from "../packages/sdk/plugin-sdk/lib/lint/imports.mjs";
import { nameProblems } from "./check-core-names.mjs";

const root = resolve(import.meta.dirname, "..");
const SKILL = join(root, "skills/plume-plugin");
const UI_SRC = join(root, "packages/client/ui/src");
const UI_API = join(root, "packages/client/ui/plugin-api.json");
const STYLES_SRC = join(root, "packages/client/styles/src/index.ts");
const COMPONENTS_DOC = join(SKILL, "references/components.md");
const UI_PUBLIC = new Set(JSON.parse(readFileSync(UI_API, "utf8")).flatMap((group) => group.names));
const BUILTIN = join(root, "packages/builtin");
/** 只给冒烟用的测试插件，和内置插件按同一套规则查。 */
const TESTING = join(root, "packages/testing");
/** packages/infra/ 下的通用库：不懂 agent 业务，插件可以声明了打包进去。 */
const INFRA = new Set(
	readdirSync(join(root, "packages/infra"))
		.map((name) => join(root, "packages/infra", name, "package.json"))
		.filter((file) => existsSync(file))
		.map((file) => JSON.parse(readFileSync(file, "utf8")).name),
);

const problems = [];
const report = (file, message) => problems.push(`  ${relative(root, file)}：${message}`);

function walk(dir, exts, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (["node_modules", "dist"].includes(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, exts, out);
		else if (exts.some((ext) => name.endsWith(ext))) out.push(path);
	}
	return out;
}

/** 从 `@plume/ui` 引用的值（`import type` 和 `type X` 是类型，不算）。 */
function uiValueImports(text) {
	const names = [];
	for (const match of stripComments(text).matchAll(/\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@plume\/ui["']/g)) {
		if (match[1]) continue;
		for (const part of match[2]
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean)) {
			if (!part.startsWith("type ")) names.push(part.split(/\s+as\s+/)[0]);
		}
	}
	return names;
}

// 规则 1：内置插件（和测试插件）只引用公开接口。
for (const pluginDir of [BUILTIN, TESTING].flatMap((group) => readdirSync(group).map((name) => join(group, name)))) {
	if (!existsSync(join(pluginDir, "package.json"))) continue;
	for (const { file, message } of importProblems(pluginDir, { allow: INFRA })) report(file, message);
	for (const file of walk(join(pluginDir, "src"), [".ts", ".tsx"])) {
		for (const imported of uiValueImports(readFileSync(file, "utf8"))) {
			if (!UI_PUBLIC.has(imported))
				report(
					file,
					`@plume/ui 的 ${imported} 不在给插件用的名单里（packages/client/ui/plugin-api.json），可用的见 skills/plume-plugin/references/components.md`,
				);
		}
	}
}

// 规则 2：skill 跟得上接口。
/** interface 的成员名：顶层缩进一个制表符的属性和方法。 */
function members(file, name) {
	const text = readFileSync(file, "utf8");
	const start = text.indexOf(`export interface ${name} {`);
	if (start < 0) {
		report(file, `找不到 interface ${name}`);
		return [];
	}
	const body = stripComments(text.slice(start, text.indexOf("\n}", start)));
	return [...body.matchAll(/^\t(?:readonly\s+)?([\w$]+)\??\s*[:(<]/gm)].map((match) => match[1]);
}

const pluginFile = join(root, "packages/contract/src/plugin.ts");
const uiFile = join(root, "packages/contract/src/ui.ts");
const api = { ctx: new Set(members(pluginFile, "PluginContext")), ui: new Set(members(uiFile, "UiContext")) };
/** 钩子名：Hooks 的键带点，写成字符串。 */
const hooks = new Set();
{
	const text = readFileSync(pluginFile, "utf8");
	const start = text.indexOf("export interface Hooks {");
	for (const match of text.slice(start, text.indexOf("\n}", start)).matchAll(/^\t"([\w.]+)"\s*:/gm)) hooks.add(match[1]);
	if (hooks.size === 0) report(pluginFile, "找不到 Hooks 的钩子名");
}

const skillFiles = walk(SKILL, [".md"]);
if (skillFiles.length === 0) report(SKILL, "skill 不在了");
const skillText = skillFiles.map((file) => readFileSync(file, "utf8")).join("\n");

for (const [owner, names] of Object.entries(api)) {
	for (const member of names) {
		if (!new RegExp(`\\b${owner}\\.${member}\\b`).test(skillText))
			report(SKILL, `没提到 ${owner}.${member}（${owner === "ctx" ? "PluginContext" : "UiContext"} 里有）`);
	}
}
for (const hook of hooks) if (!skillText.includes(hook)) report(SKILL, `没提到钩子 ${hook}`);

/** 文件名里的 `ui.tsx`、`ui.mjs` 不算成员。 */
const FILE_EXT = new Set(["ts", "tsx", "mjs", "js", "css", "md"]);
for (const file of skillFiles) {
	const text = readFileSync(file, "utf8");
	for (const match of text.matchAll(/(?<![\w/.-])(ctx|ui)\.([\w$]+)/g)) {
		const [, owner, member] = match;
		if (!FILE_EXT.has(member) && !api[owner].has(member))
			report(file, `${owner}.${member} 不存在（${owner === "ctx" ? "PluginContext" : "UiContext"} 里没有）`);
	}
	for (const match of text.matchAll(/\bhook\(\s*"([\w.]+)"/g)) if (!hooks.has(match[1])) report(file, `钩子 ${match[1]} 不存在`);
}

// 规则 3：组件清单跟得上代码。
/** 一个模块对外导出的名字：自己声明的、`export { … }`、`export { … } from`、`export * from`（递归）。 */
function exportsOf(file, seen = new Set()) {
	const names = new Set();
	if (seen.has(file) || !existsSync(file)) return names;
	seen.add(file);
	const code = stripComments(readFileSync(file, "utf8"));
	for (const match of code.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|enum)\s+([\w$]+)/gm)) names.add(match[1]);
	for (const match of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
		for (const part of match[1]
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry && !entry.startsWith("type ")))
			names.add(part.split(/\s+as\s+/).at(-1));
	}
	for (const match of code.matchAll(/^export\s*\*\s*from\s*["'](\.[^"']+)["']/gm))
		for (const name of exportsOf(resolve(dirname(file), match[1]), seen)) names.add(name);
	return names;
}

/**
 * 从 start 开始的一段声明的源码。函数到函数体的 `{` 为止（只要签名）；interface 到配对的 `}`；其余到顶层的 `;`。
 * 只数括号，不认字符串：被摘的都是组件签名和类名组合，括号在字符串里也是成对的。
 */
function declarationText(text, start, kind) {
	let depth = 0;
	let params = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (char === "(" || char === "[") {
			depth++;
			if (char === "(") params = true;
		} else if (char === ")" || char === "]") depth--;
		else if (char === "{") {
			if (kind === "function" && depth === 0 && params) return text.slice(start, i).trimEnd();
			depth++;
		} else if (char === "}") {
			depth--;
			if (kind === "interface" && depth === 0) return text.slice(start, i + 1);
		} else if (char === ";" && depth === 0 && kind !== "function" && kind !== "interface") return text.slice(start, i + 1);
	}
	return text.slice(start);
}

/** 紧挨在 start 前面的 `/** … *\/` 注释。文件开头的那段是整个文件的说明，不算。 */
function docBefore(text, start) {
	const before = text.slice(0, start).trimEnd();
	const at = before.lastIndexOf("/**");
	return before.endsWith("*/") && at > 0 ? before.slice(at) : "";
}

/**
 * 注释只留第一段：第一段写怎么用，后面的段落写为什么这样做，给维护组件的人看（约定见 spec/tech/components.md）。
 * 只剩一行的写回一行的 `/** … *\/`。
 */
function firstParagraphs(code) {
	return code.replace(/^([ \t]*)\/\*\*\n([\s\S]*?)\n[ \t]*\*\/$/gm, (_, indent, body) => {
		const lines = body.split("\n");
		const end = lines.findIndex((line) => /^\s*\*\s*$/.test(line));
		const kept = end < 0 ? lines : lines.slice(0, end);
		if (kept.length === 1) return `${indent}/** ${kept[0].replace(/^\s*\*\s?/, "")} */`;
		return [`${indent}/**`, ...kept, `${indent} */`].join("\n");
	});
}

/** 按顶层的逗号切开（括号和字符串里的不算）。 */
function splitTopLevel(text) {
	const parts = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quote) {
			if (char === "\\") i++;
			else if (char === quote) quote = "";
		} else if (`"'\``.includes(char)) quote = char;
		else if ("([{".includes(char)) depth++;
		else if (")]}".includes(char)) depth--;
		else if (char === "," && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts.map((part) => part.trim()).filter(Boolean);
}

/** 多行解构的参数只留有默认值的和 `...rest` 写成一行：其余的名字后面的类型里都有，再列一遍是重复。 */
function compactParams(signature) {
	const open = signature.match(/^export\s+(?:async\s+)?function\s+[\w$]+(?:<[^\n(]*>)?\(\{\n/);
	if (!open) return signature;
	const from = open[0].length - 2;
	let depth = 0;
	let end = from;
	for (; end < signature.length; end++) {
		if ("({[".includes(signature[end])) depth++;
		else if (")}]".includes(signature[end]) && --depth === 0) break;
	}
	const kept = splitTopLevel(signature.slice(from + 1, end))
		.filter((entry) => entry.startsWith("...") || /^[\w$]+(?:\s*:\s*[\w$]+)?\s*=/.test(entry))
		// `surface: kind = "menu"` 里的 `kind` 是组件内部的名字，调用方只认 `surface`。
		.map((entry) => entry.replace(/^([\w$]+)\s*:\s*[\w$]+\s*=/, "$1 ="));
	const params = kept.length > 0 ? `{ ${kept.join(", ")} }` : "props";
	return `${signature.slice(0, from)}${params}${signature.slice(end + 1)}`;
}

/** 签名里只用到 `keyof typeof X` 的常量：类型只取它的键，值（类名串）换成 `…`，键上的注释留着。 */
function keysOnly(declaration) {
	const lines = declaration.split("\n");
	if (lines.length < 3) return declaration;
	const body = lines
		.slice(1, -1)
		.filter((line) => /^\t(?:\/\*\*|\*\/| \*|[\w$"']+\s*:)/.test(line))
		.map((line) => line.replace(/^(\t[\w$"']+\s*:).*$/, "$1 …,"));
	return [lines[0], ...body, lines.at(-1)].join("\n");
}

/** 只有字符串的数组写成一行。 */
function inlineStrings(declaration) {
	return declaration.replace(/\[\n((?:\t"[^"\n]*",\n)+)\]/, (_, items) => `[${items.trim().split(/,\s*/).filter(Boolean).join(", ")}]`);
}

const uiFiles = walk(UI_SRC, [".ts", ".tsx"]).map((file) => ({ file, text: readFileSync(file, "utf8") }));
const uiExports = exportsOf(join(UI_SRC, "index.tsx"));
/** 已经摘过的同文件常量和类型（`文件:名字`）：几个函数共用一个类型时只在第一处列出。 */
const described = new Set();

/** 一个公开名字的说明：注释、签名，以及签名里（层层）用到的同文件常量（`keyof typeof X`）、类型和借参数的组件。 */
function describe(name) {
	if (!uiExports.has(name)) report(UI_API, `${name}：@plume/ui 没有导出它`);
	const pattern = new RegExp(`^export\\s+(?:async\\s+)?(function|const|class)\\s+${name}\\b`, "m");
	const hits = uiFiles.filter(({ text }) => pattern.test(text));
	if (hits.length !== 1) {
		report(UI_API, `${name}：在 packages/client/ui/src 里找到 ${hits.length} 处声明，要正好一处`);
		return "";
	}
	const { file, text } = hits[0];
	const match = text.match(pattern);
	const signature = declarationText(text, match.index, match[1]);
	const related = [];
	const earlier = [];
	const seen = new Set([name]);
	/** 摘过的声明里再用到的同文件类型也摘上（`PopoverProps` 里的 `Anchor`）。 */
	const pending = [signature];
	const relate = (ref, found, kind, shape = (declaration) => declaration) => {
		if (!found || seen.has(ref)) return;
		seen.add(ref);
		if (described.has(`${file}:${ref}`)) earlier.push(`\`${ref}\``);
		else {
			described.add(`${file}:${ref}`);
			const declaration = declarationText(text, found.index, kind);
			related.push(shape(declaration));
			pending.push(declaration);
		}
	};
	while (pending.length > 0) {
		const code = stripComments(pending.shift());
		for (const [, ref] of code.matchAll(/keyof typeof ([\w$]+)/g))
			relate(ref, text.match(new RegExp(`^(?:export\\s+)?const\\s+${ref}\\b`, "m")), "const", keysOnly);
		for (const ref of new Set([...code.matchAll(/\b([A-Z][\w$]*)\b/g)].map((hit) => hit[1]))) {
			const found = text.match(new RegExp(`^(?:export\\s+)?(type|interface)\\s+${ref}\\b`, "m"));
			relate(ref, found, found?.[1]);
		}
		// `Parameters<typeof DialogFrame>` 这类借同文件组件的参数：把那个组件的签名也列上，不然看不到有哪些参数。
		for (const [, ref] of code.matchAll(/\btypeof ([A-Z][\w$]*)/g))
			relate(ref, text.match(new RegExp(`^(?:export\\s+)?function\\s+${ref}\\b`, "m")), "function", compactParams);
	}
	const doc = docBefore(text, match.index);
	const own = match[1] === "function" ? compactParams(signature) : inlineStrings(signature);
	const code = firstParagraphs([doc ? `${doc}\n${own}` : own, ...related].join("\n\n"));
	return [`### \`${name}\``, "", "```tsx", code, "```", ...(earlier.length > 0 ? ["", `${earlier.join("、")} 见上文。`] : []), ""].join("\n");
}

/** 这几个类名组合是组件的外观，插件用组件，这一页不列。 */
const COMPONENT_LOOKS = { button: "Button", iconButton: "IconButton", code: "CodeBlock" };

function componentsDoc() {
	const groups = JSON.parse(readFileSync(UI_API, "utf8"));
	const styles = readFileSync(STYLES_SRC, "utf8");
	const exported = [...styles.matchAll(/^export\s+const\s+([\w$]+)/gm)];
	for (const look of Object.keys(COMPONENT_LOOKS))
		if (!exported.some((match) => match[1] === look))
			report(STYLES_SRC, `${look}：@plume/styles 没有导出它（scripts/check-plugins.mjs 的 COMPONENT_LOOKS 跟着改）`);
	const combos = exported
		.filter((match) => !(match[1] in COMPONENT_LOOKS))
		.map((match) => {
			const code = firstParagraphs([docBefore(styles, match.index), declarationText(styles, match.index, "const")].filter(Boolean).join("\n"));
			return `### \`${match[1]}\`\n\n\`\`\`ts\n${code}\n\`\`\`\n`;
		});
	const looks = Object.entries(COMPONENT_LOOKS);
	return [
		"# 组件和类名组合",
		"",
		"<!-- 由 `node scripts/check-plugins.mjs --fix` 从源码生成，不要手改。名单在 packages/client/ui/plugin-api.json。 -->",
		"",
		"界面入口能用的 `@plume/ui` 组件和 `@plume/styles` 类名组合，就是这一页列出的这些；`@plume/ui` 的其他导出是产品内部用的，`pnpm check:plugins` 会拦。签名和注释摘自源码：解构的参数只留有默认值的（其余的看后面的类型），`keyof typeof` 的常量只列键，注释只取第一段。",
		"",
		"怎么选：文字一律用 `Text`（字号档位自带行高、字距和字重，不在 CSS 里写字号）；按钮、输入框、开关、菜单、对话框用对应组件；工具卡片的外框用 `Card`。组件不够时用下面的类名组合，再不够才写自己的样式（见 [style-i18n.md](style-i18n.md)）。",
		"",
		...groups.flatMap((group) => [`## ${group.title}`, "", ...group.names.map(describe)]),
		"## `@plume/styles` 的类名组合",
		"",
		'`import { text, card } from "@plume/styles"`，拼进 `className`。产品的 Tailwind 扫描这个包，这些类一定会生成。',
		`${looks.map(([look]) => `\`${look}\``).join("、")} 是 ${looks.map(([, component]) => `\`${component}\``).join("、")} 的外观，用组件，这里不列。`,
		"",
		...combos,
	].join("\n");
}

{
	const doc = componentsDoc();
	if (process.argv.includes("--fix")) {
		writeFileSync(COMPONENTS_DOC, doc);
		console.log(`已重新生成 ${relative(root, COMPONENTS_DOC)}`);
	} else if (!existsSync(COMPONENTS_DOC) || readFileSync(COMPONENTS_DOC, "utf8") !== doc) {
		report(COMPONENTS_DOC, "和代码对不上（组件签名、注释或 plugin-api.json 改了）：node scripts/check-plugins.mjs --fix 重新生成");
	}
}

// 规则 4、5、6：本体不按名字认具体插件，内置插件不按名字认别的插件。
for (const { file, message } of nameProblems(root)) report(file, message);

if (problems.length > 0) {
	console.error(`插件检查没通过（规则见 scripts/check-plugins.mjs，写法见 skills/plume-plugin）：\n\n${problems.join("\n")}\n`);
	process.exit(1);
}
console.log("✓ 插件检查通过");
