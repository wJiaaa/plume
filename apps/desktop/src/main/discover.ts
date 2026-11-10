/**
 * 在插件目录里找插件：每个子目录一个，有逻辑入口（dist/index.mjs）的才算。只读一层，不递归。
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DIR_NAME, PLUGIN_ENTRY } from "@plumeai/plugin-sdk/manifest";
import type { PluginDir } from "../shared/protocol.ts";

export async function discoverPlugins(roots: string[], log: (message: string) => void): Promise<PluginDir[]> {
	const found: PluginDir[] = [];
	for (const root of roots) {
		let names: string[];
		try {
			names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const name of names.sort()) {
			const dir = resolve(root, name);
			if (!existsSync(join(dir, PLUGIN_ENTRY))) continue;
			if (!DIR_NAME.test(name)) {
				log(`忽略插件目录 ${dir}：目录名只能用小写字母、数字和连字符`);
				continue;
			}
			if (found.some((plugin) => plugin.key === name)) {
				log(`忽略插件目录 ${dir}：已有同名目录`);
				continue;
			}
			found.push({ key: name, dir });
		}
	}
	return found;
}
