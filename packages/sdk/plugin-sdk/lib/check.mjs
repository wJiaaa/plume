/**
 * 检查一个插件：先用 SDK 自带的 TypeScript 做类型检查（插件作者的机器上不用另装），再跑插件规则（lint/）。
 * 独立项目的 SDK 链接不在了先链上：npm 装一个包就会删掉它们，类型检查只会报找不到 tsconfig，看不出该做什么。
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { ensureLinked } from "./link.mjs";
import { formatProblem, lintPlugin } from "./lint/index.mjs";

const require = createRequire(import.meta.url);

/**
 * @param {string} target 插件目录（有 tsconfig.json）
 * @returns {Promise<boolean>} 通过没有；报错直接打到终端
 */
export async function checkPlugin(target) {
	const dir = resolve(target);
	if (ensureLinked(dir)) console.log("node_modules 里指向 SDK 的链接不在了（npm 装包时会删掉它们），已重新链上");
	const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
	// 在插件目录里跑，报错里的路径相对插件目录（src/ui.tsx），不是一长串 ../。
	const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { stdio: "inherit", cwd: dir });
	const problems = await lintPlugin(dir);
	if (problems.length > 0) console.error(`插件规则没通过：\n\n${problems.map((problem) => `  ${formatProblem(problem, dir)}`).join("\n")}\n`);
	return result.status === 0 && problems.length === 0;
}
