/**
 * 插件仓库里市场插件的源码。工具评测（test/tool-eval）和界面块审计（interface-audit.ts）看的是插件在真实模型、真实会话里的表现，
 * 直接用插件的源码。插件仓库是单独的仓库，这几个命令要设 PLUME_PLUGINS_DIR=<插件仓库>/plugins 才能跑；`pnpm check` 不碰它们。
 *
 * 只在运行时按路径加载，不写静态 import：没有插件仓库时本仓库的检查、构建都和它无关。取到的模块没有类型。
 */

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** `path` 相对插件仓库的 plugins/，比如 `memory/src/extract.ts`。 */
export async function pluginSource(path: string): Promise<any> {
	const dir = process.env.PLUME_PLUGINS_DIR;
	if (!dir) throw new Error(`要用插件仓库里的 ${path}：设 PLUME_PLUGINS_DIR=<插件仓库>/plugins`);
	return await import(pathToFileURL(join(resolve(dir), path)).href);
}
