/**
 * 插件只引用公开接口（插件检查 `plume-plugin check` 和 Plume 自己的 `pnpm check:plugins` 用的是这同一份）。
 * 插件 src 里的 import / export from / import() / require() 只能是
 * - 相对路径，且不出插件自己的目录；
 * - `node:*`；
 * - `@plume/contract`、`@plume/contract/ui`，而且只能 `import type` / `export type`（它只有类型，运行时从 ctx / ui 上拿）；
 * - 界面入口共享的 `react`、`react/jsx-runtime`、`@plume/ui`、`@plume/ui/icons`、`@plume/styles`；
 * - 插件自己 package.json 里声明的第三方包（及其子路径）。
 * `@plume/` 下的其他包是宿主的实现，声明了也不行。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const CONTRACT = new Set(["@plume/contract", "@plume/contract/ui"]);
const SHARED = new Set(["react", "react/jsx-runtime", "@plume/ui", "@plume/ui/icons", "@plume/styles"]);

/** 去掉注释。行注释只认行首或空白后的 `//`，字符串里的 URL 不受影响。 */
export const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/** 包名：`@scope/name/sub` → `@scope/name`，`name/sub` → `name`。 */
const packageOf = (specifier) =>
	specifier
		.split("/")
		.slice(0, specifier.startsWith("@") ? 2 : 1)
		.join("/");

/** 一个文件里的引用：{ specifier, typeOnly }。import 子句只由标识符、花括号、逗号、星号、空白组成，不会跨进代码里。 */
function imports(text) {
	const code = stripComments(text);
	const found = [];
	for (const match of code.matchAll(/\bimport\s+(type\s+)?(?:[\w$*{},\s]+?\s+from\s*)?["']([^"']+)["']/g))
		found.push({ specifier: match[2], typeOnly: Boolean(match[1]) });
	for (const match of code.matchAll(/\bexport\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[\w$,\s]*\})\s*from\s*["']([^"']+)["']/g))
		found.push({ specifier: match[2], typeOnly: Boolean(match[1]) });
	// `typeof import("x")` 只是类型，但和运行时的 import() 一样要在白名单里，按非纯类型算更严。
	for (const match of code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push({ specifier: match[1], typeOnly: false });
	return found;
}

/** dir 下的 .ts、.tsx，跳过 node_modules、dist。 */
function sourceFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (["node_modules", "dist"].includes(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sourceFiles(path, out);
		else if (/\.tsx?$/.test(name)) out.push(path);
	}
	return out;
}

/**
 * 一个插件的越界引用。返回 `{ file, message }`。
 * @param {string} pluginDir 插件目录（有 package.json 和 src/）
 * @param {{ allow?: Set<string> }} [options] allow：额外允许、声明了就能用的 `@plume/` 包（Plume 仓库里的内置插件用 packages/infra 下的通用库）
 */
export function importProblems(pluginDir, options = {}) {
	const allow = options.allow ?? new Set();
	const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
	const declared = new Set(
		Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((dep) => !dep.startsWith("@plume/") || allow.has(dep)),
	);
	const found = [];
	for (const file of sourceFiles(join(pluginDir, "src"))) {
		const report = (message) => found.push({ file, message });
		for (const { specifier, typeOnly } of imports(readFileSync(file, "utf8"))) {
			if (specifier.startsWith(".")) {
				const target = resolve(dirname(file), specifier);
				if (target !== pluginDir && !target.startsWith(pluginDir + sep)) report(`${specifier}：出了插件自己的目录`);
			} else if (specifier.startsWith("node:") || SHARED.has(specifier)) {
				// 公开的运行时模块。
			} else if (CONTRACT.has(specifier)) {
				if (!typeOnly) report(`${specifier}：只能 import type / export type，运行时的东西从 ctx / ui 上拿`);
			} else if (specifier.startsWith("@plume/") && !allow.has(packageOf(specifier))) {
				report(`${specifier}：不是公开接口，插件只能用 @plume/contract（类型）、@plume/ui、@plume/ui/icons、@plume/styles`);
			} else if (!declared.has(packageOf(specifier))) {
				report(`${specifier}：没在插件的 package.json 里声明`);
			}
		}
	}
	return found;
}
