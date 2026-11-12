/**
 * plume.web 的逻辑入口，跑在 agent 进程：注册 `web_search`、`web_fetch` 两个工具，搜索设置经 ctx.serve 开给设置分区。
 *
 * 设置（选哪家、各家的 key）在插件数据目录的 `search.json`，每次搜索现读；key 经 `ctx.secrets` 加密后落盘，
 * 只在这个进程里解开用，界面只知道填没填。
 */

import { join } from "node:path";
import type { Plugin } from "@plume/contract";
import { KEY_IDS, PROVIDER_IDS, type KeyId, type SearchKeys, type WebApi } from "./api.ts";
import { defaultSearchProviders } from "./search/defaults.ts";
import { createSearchRegistry } from "./search/index.ts";
import { settingsFile, viewOf } from "./settings.ts";
import { webFetchTool } from "./web-fetch.ts";
import { webSearchTool } from "./web-search.ts";

const isKeyId = (value: unknown): value is KeyId => typeof value === "string" && (KEY_IDS as readonly string[]).includes(value);

export default {
	name: "plume.web",
	apply(ctx) {
		const settings = settingsFile(join(ctx.dataDir, "search.json"), ctx.secrets);

		// 要 key 的后端读这一份；每次搜索前从文件现读、换成最新的。
		let keys: SearchKeys = {};
		const registry = createSearchRegistry(defaultSearchProviders(() => keys));

		ctx.tools.register(
			webSearchTool(registry, async () => {
				const current = await settings.read();
				keys = current.keys;
				return current.provider;
			}),
		);
		ctx.tools.register(webFetchTool());

		const api: WebApi = {
			settings: async () => viewOf(await settings.read()),
			async setProvider(provider) {
				if (provider !== null && !(PROVIDER_IDS as readonly string[]).includes(provider)) throw new Error(`unknown search provider: ${provider}`);
				return viewOf(await settings.update((current) => ({ ...current, provider })));
			},
			async setKey(which, key) {
				if (!isKeyId(which) || typeof key !== "string") throw new Error("invalid search key update");
				// 两头的空白是粘贴带进来的，不是 key 的一部分；空串就是清掉。
				const cleaned = key.trim();
				return viewOf(
					await settings.update((current) => {
						const next = { ...current.keys };
						if (cleaned) next[which] = cleaned;
						else delete next[which];
						return { ...current, keys: next };
					}),
				);
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
