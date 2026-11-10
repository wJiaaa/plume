/**
 * 让插件项目找到 SDK：在它的 node_modules 里建几个链接，指到这份 SDK（随 Plume 应用发的那份，或仓库里这份）。
 *
 * 不经 npm：插件的 tsconfig 写 `"extends": "@plume/plugin-sdk/tsconfig.json"`，`types` 写 `["node"]`，
 * 这几个名字靠链接解析到 SDK 自带的副本上，插件的写法和仓库里的一样。
 * Plume 挪了位置，或者用 npm 装了别的包（npm 会删掉它不认识的链接），重新跑一次 `plume-plugin link`。
 */

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const sdk = resolve(import.meta.dirname, "..");
const require = createRequire(join(sdk, "package.json"));

/** 链进插件 node_modules 的包 → 它在 SDK 这边的目录。 */
function targets() {
	return {
		"@plume/plugin-sdk": sdk,
		"@types/node": dirname(require.resolve("@types/node/package.json")),
		"@types/react": dirname(require.resolve("@types/react/package.json")),
	};
}

/** @param {string} target 插件目录 */
export function linkSdk(target) {
	const dir = resolve(target);
	for (const [name, source] of Object.entries(targets())) {
		const path = join(dir, "node_modules", name);
		// 已有的（旧链接，或者 npm 装的真目录）换掉：用的必须是这份 SDK。
		if (existsSync(path) || isLink(path)) rmSync(path, { recursive: true, force: true });
		mkdirSync(dirname(path), { recursive: true });
		// Windows 上建目录链接要管理员权限，junction 不用。
		symlinkSync(source, path, process.platform === "win32" ? "junction" : "dir");
	}
}

function isLink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}
