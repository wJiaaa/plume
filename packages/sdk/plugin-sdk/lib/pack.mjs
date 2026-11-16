/**
 * 打出一份能交给别人的插件：先构建，再把发给插件的文件（manifest.mjs 的 SHIPPED）复制进 `<输出目录>/<目录名>/`，
 * 不带源码和 node_modules。拿到的人在 Plume 的插件市场「创建插件 › 从本地上传」里选这个文件夹。
 *
 * 发到市场必须写齐的说明（版本号、显示名、说明）缺了不拦，返回给命令行提示：交给熟人用不一定要写全。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { buildPlugin } from "./build.mjs";
import { DIR_NAME, manifestProblems, SHIPPED } from "./manifest.mjs";

/**
 * @param {string} source 插件目录
 * @param {string} [out] 输出目录，缺省插件目录下的 release/
 * @returns {Promise<{ dir: string, problems: string[] }>} 打出的文件夹、缺了的说明
 */
export async function packPlugin(source, out) {
	const dir = resolve(source);
	const key = basename(dir);
	if (!DIR_NAME.test(key)) throw new Error(`目录名 ${key} 不行：只能用小写字母、数字和连字符`);
	const target = join(resolve(out ?? join(dir, "release")), key);
	const inside = relative(dir, target);
	// 输出放在插件目录里时只能在 release/ 这类不发出去的目录下，放进 dist/ 会把自己复制进自己。
	if (inside === "" || SHIPPED.includes(inside.split(sep)[0] ?? "")) throw new Error(`输出目录不能是插件目录本身或 ${SHIPPED.join("、")}`);
	await buildPlugin(dir);
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	for (const name of SHIPPED) {
		if (existsSync(join(dir, name))) cpSync(join(dir, name), join(target, name), { recursive: true });
	}
	return { dir: target, problems: manifestProblems(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))) };
}
