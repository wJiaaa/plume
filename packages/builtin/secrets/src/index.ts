/**
 * plume.secrets：作为服务 `secrets` 给别的插件加解密密钥，钥匙在本插件的数据目录（`vault.key`）。
 * 要换一种存钥匙的办法（系统钥匙串、硬件密钥）就装一个提供 `secrets` 服务的插件：非内置的提供方优先。
 * 换了提供方，旧钥匙加密的密文它解不开，用它的插件会把那些值当成要重新填。
 */

import type { Plugin } from "@plume/contract";
import { MESSAGES } from "./messages.ts";
import { createSealer } from "./sealer.ts";

export default {
	name: "plume.secrets",
	apply(ctx) {
		ctx.provide(
			"secrets",
			createSealer(ctx.dataDir, () => MESSAGES[ctx.locale()]),
		);
	},
} satisfies Plugin;
