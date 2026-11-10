/**
 * 插件检查里类型检查之外的规则：只引用公开接口（imports.mjs）、样式（styles.mjs）、不写死中文（i18n.mjs）。
 * `plume-plugin check` 和插件仓库的检查用 lintPlugin；Plume 自己的检查脚本按规则分别引用这几个模块。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chineseFindings } from "./i18n.mjs";
import { importProblems } from "./imports.mjs";
import { pluginStyleProblems, pluginTailwind } from "./styles.mjs";

// 一次查很多个插件时先编译一次 Tailwind，作为 isTailwind 传给每次 lintPlugin。
export { pluginTailwind };

/** dir 下扩展名在 exts 里的文件，跳过 node_modules、dist、out 和 skip 里的目录名。 */
function files(dir, exts, skip = [], out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (["node_modules", "dist", "out", ...skip].includes(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) files(path, exts, skip, out);
		else if (exts.some((ext) => name.endsWith(ext))) out.push(path);
	}
	return out;
}

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

/**
 * @typedef {{ file: string, line?: number, rule: string, message: string }} Problem
 * @param {string} pluginDir
 * @param {{ isTailwind?: (candidate: string) => boolean }} [options] isTailwind 缺省用 SDK 带的 Tailwind 和 theme.css
 * @returns {Promise<Problem[]>}
 */
export async function lintPlugin(pluginDir, options = {}) {
	const isTailwind = options.isTailwind ?? (await pluginTailwind());
	const problems = importProblems(pluginDir).map(({ file, message }) => ({ file, rule: "引用", message }));
	for (const file of files(pluginDir, [".ts", ".tsx", ".css"])) {
		const text = readFileSync(file, "utf8");
		for (const { index, rule, message } of pluginStyleProblems(file, text, isTailwind)) problems.push({ file, line: lineAt(text, index), rule, message });
	}
	// 测试写给开发者看，文案在 src/messages.ts 里本来就是两种语言：都不查中文。
	for (const file of files(pluginDir, [".ts", ".tsx"], ["test"])) {
		if (relative(pluginDir, file).replaceAll("\\", "/") === "src/messages.ts") continue;
		for (const { line, text } of chineseFindings(readFileSync(file, "utf8")))
			problems.push({ file, line, rule: "中文", message: `${text}：界面文案放进 src/messages.ts，按语言取（useI18n()、ctx.locale()）` });
	}
	return problems;
}

/** 一条问题写成一行，路径相对 base。 */
export function formatProblem({ file, line, rule, message }, base) {
	return `${relative(base, file)}${line ? `:${line}` : ""}  [${rule}] ${message}`;
}
