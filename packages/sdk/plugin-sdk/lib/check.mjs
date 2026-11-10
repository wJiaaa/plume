/**
 * 类型检查一个插件：用 SDK 自带的 TypeScript，插件作者的机器上不用另装。
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * @param {string} target 插件目录（有 tsconfig.json）
 * @returns {boolean} 通过没有；报错直接打到终端
 */
export function checkPlugin(target) {
	const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
	const result = spawnSync(process.execPath, [tsc, "-p", join(resolve(target), "tsconfig.json")], { stdio: "inherit" });
	return result.status === 0;
}
