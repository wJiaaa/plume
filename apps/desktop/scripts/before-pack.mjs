/**
 * electron-builder 的 `beforePack`：在复制 `extraResources` 之前，备好正在打的平台和架构要带的二进制。
 *
 * 只能挂一个脚本，所以三件事在这里排队：ripgrep（`fetch-ripgrep.mjs`）；内置插件，按目标裁掉别的平台的
 * 原生模块（`stage-resources.mjs`）；插件 SDK 里 esbuild、tsc 的二进制包（`packages/sdk/plugin-sdk/scripts/stage.mjs`
 * 按目标挑那一份，整理进 `.stage/plugin-sdk/`）。按 electron-builder
 * 给的架构挑，不按跑打包的这台机器：一次打两个架构时每个架构各调一次，各自的那份在复制资源之前换上。
 * 任何一步失败都让打包失败——缺了它们的安装包能装能用，只是悄悄退回了慢的路，或者写插件时才发现跑不起来。
 */

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { BUILDER_ARCH, beforePack as fetchRipgrepForBuild } from "./fetch-ripgrep.mjs";

const desktop = resolve(import.meta.dirname, "..");

export function beforePack(context) {
	fetchRipgrepForBuild(context);
	const target = `${context.electronPlatformName}-${BUILDER_ARCH[context.arch]}`;
	// 先放插件（会清掉整个 .stage），再放 SDK。
	execFileSync(process.execPath, [join(desktop, "scripts", "stage-resources.mjs"), target], { stdio: "inherit" });
	execFileSync(process.execPath, [resolve(desktop, "../../packages/sdk/plugin-sdk/scripts/stage.mjs"), join(desktop, ".stage", "plugin-sdk"), target], {
		stdio: "inherit",
	});
}
