/**
 * 检查一个插件：先用 SDK 自带的 TypeScript 做类型检查（插件作者的机器上不用另装），再跑插件规则（lint/）。
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { formatProblem, lintPlugin } from "./lint/index.mjs";

const require = createRequire(import.meta.url);

/**
 * @param {string} target 插件目录（有 tsconfig.json）
 * @returns {Promise<boolean>} 通过没有；报错直接打到终端
 */
export async function checkPlugin(target) {
	const dir = resolve(target);
	const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
	const result = spawnSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { stdio: "inherit" });
	const problems = await lintPlugin(dir);
	if (problems.length > 0) console.error(`插件规则没通过：\n\n${problems.map((problem) => `  ${formatProblem(problem, dir)}`).join("\n")}\n`);
	return result.status === 0 && problems.length === 0;
}
