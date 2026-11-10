/**
 * 插件带的原生模块给哪些平台、架构：构建时带上这几份，打包时再按安装包的目标裁掉别的。
 *
 * 预编译的原生模块有两种发法：一个平台一个包、在 package.json 里写 `os`、`cpu`（koffi 的 `@koromix/koffi-<平台>-<架构>`），
 * 或者一个包里放 `prebuilds/<平台>-<架构>/`（node-pty）。插件构建出来的 dist/ 会进安装包、进插件市场，用它的机器
 * 不一定是构建它的那台：Plume 一次打 mac 的 arm64 + x64、Windows 的 x64 + arm64，只带构建机那一份的话，另一个架构的
 * 安装包里终端、沙箱都起不来。所以构建时这几份都带（装了才带：pnpm 的 supportedArchitectures 装齐，仓库外的插件只有
 * 本机那份也照样能构建），打包时 apps/desktop 的 stage-resources.mjs 用 `trimNative` 只留目标那一份。
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Plume 发安装包的平台和架构，按 Node 的 `process.platform`-`process.arch` 写；加上构建机自己。 */
export const TARGETS = [...new Set([`${process.platform}-${process.arch}`, "darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"])];

/** package.json 的 `os` / `cpu` 这一项容不容得下 value：没写是都行，`!x` 是除了 x，`any` 是都行。 */
export function fits(list, value) {
	if (!Array.isArray(list) || list.length === 0) return true;
	if (list.includes(`!${value}`)) return false;
	const wanted = list.filter((entry) => !entry.startsWith("!"));
	return wanted.length === 0 || wanted.includes(value) || wanted.includes("any");
}

/** 这个包能不能在 target（`<平台>-<架构>`）上用。 */
export function forTarget(manifest, target) {
	const [platform, arch] = target.split("-");
	return fits(manifest.os, platform) && fits(manifest.cpu, arch);
}

/**
 * 把一个 node_modules 裁成只给 target 用的：`os`、`cpu` 不合的包整个删掉，`prebuilds/` 下别的平台、架构的目录删掉。
 * 返回删掉了哪些（相对 dir 的路径），给打包日志用。
 */
export function trimNative(dir, target) {
	const removed = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(current, entry.name);
			if (entry.name === "prebuilds") {
				for (const prebuilt of readdirSync(path, { withFileTypes: true })) {
					if (!prebuilt.isDirectory() || prebuilt.name === target) continue;
					rmSync(join(path, prebuilt.name), { recursive: true, force: true });
					removed.push(join(path, prebuilt.name).slice(dir.length + 1));
				}
				continue;
			}
			const manifest = join(path, "package.json");
			if (existsSync(manifest) && !forTarget(JSON.parse(readFileSync(manifest, "utf8")), target)) {
				rmSync(path, { recursive: true, force: true });
				removed.push(path.slice(dir.length + 1));
				continue;
			}
			walk(path);
		}
	};
	if (existsSync(dir)) walk(dir);
	return removed;
}
