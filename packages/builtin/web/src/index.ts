/**
 * plume.web 的逻辑入口，跑在 agent 进程：注册 `web_search`、`web_fetch` 两个工具，搜索设置经 ctx.serve 开给设置分区。
 *
 * 设置（选哪家、各家的 key）在插件数据目录的 `search.json`，每次搜索现读；key 经服务 `secrets` 加密后落盘，
 * 只在这个进程里解开用，界面只知道填没填。
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Plugin } from "@plume/contract";
import { KEY_IDS, PROVIDER_IDS, type KeyId, type SearchKeys, type WebApi } from "./api.ts";
import { registerDefaultSearchProviders } from "./search/defaults.ts";
import { createSearchRegistry } from "./search/index.ts";
import { settingsFile, viewOf } from "./settings.ts";
import { webFetchTool } from "./web-fetch.ts";
import { webSearchTool } from "./web-search.ts";

/** 各家申请 key 的页面。界面只传是哪一家，打开的地址只能是这几个。 */
const SIGNUP: Record<KeyId, string> = {
	tavily: "https://tavily.com",
	deepseek: "https://platform.deepseek.com/api_keys",
	brave: "https://brave.com/search/api/",
	exa: "https://exa.ai",
};

/**
 * 在系统浏览器里打开。界面入口拿不到 shell，由这边交给系统的打开命令。Windows 上不经 cmd 的 `start`：网址里的 `&`
 * 会被它当成命令分隔符；`url.dll` 的 FileProtocolHandler 把整条网址原样交给系统的默认浏览器。
 */
function openInBrowser(url: string): Promise<void> {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
				: ["xdg-open", [url]];
	return new Promise((resolve, reject) => {
		execFile(command, args as string[], (error) => (error ? reject(error) : resolve()));
	});
}

const isKeyId = (value: unknown): value is KeyId => typeof value === "string" && (KEY_IDS as readonly string[]).includes(value);

export default {
	name: "plume.web",
	inject: ["secrets"],
	apply(ctx) {
		const settings = settingsFile(join(ctx.dataDir, "search.json"), ctx.use("secrets"));

		// 要 key 的后端读这一份；每次搜索前从文件现读、换成最新的。
		let keys: SearchKeys = {};
		const registry = createSearchRegistry();
		registerDefaultSearchProviders(registry, () => keys);

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
			async openSignup(which) {
				if (!isKeyId(which)) throw new Error("invalid search provider");
				await openInBrowser(SIGNUP[which]);
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
