/**
 * 供应商探针的逻辑入口：数据目录里的 `providers.json`（`PluginProvider` 的数组）经 `ctx.providers.provide` 交给模型设置，
 * 设置页的改和删写回这份文件。启用时读一次，之后只认自己写的：真正的插件（如 plume.magpie）还要盯着外面改这份文件。
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin, PluginProvider } from "@plume/contract";

export default {
	name: "example.provider-probe",
	apply(ctx) {
		const file = join(ctx.dataDir, "providers.json");
		let providers: PluginProvider[] = [];
		try {
			providers = JSON.parse(readFileSync(file, "utf8")) as PluginProvider[];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") ctx.log.warn(`providers.json: ${error instanceof Error ? error.message : String(error)}`);
		}
		const write = async (next: PluginProvider[]) => {
			// 里面有 key：只给自己读写。
			await writeFile(file, JSON.stringify(next, null, 2), { mode: 0o600 });
			providers = next;
		};
		ctx.providers.provide({
			list: () => providers,
			save: (provider) => write(providers.map((item) => (item.id === provider.id ? provider : item))),
			remove: (providerId) => write(providers.filter((item) => item.id !== providerId)),
		});
	},
} satisfies Plugin;
