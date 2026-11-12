/**
 * plume.environment 的逻辑入口：只为环境卡片的子会话一节列出某个会话下面的子会话（界面入口拿不到会话列表）。
 * 卡片本身、开关和别的插件加的节都在界面入口（`ui.tsx`）。
 */

import type { Plugin } from "@plume/contract";
import type { EnvironmentApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";

export default {
	name: "plume.environment",
	apply(ctx) {
		const api: EnvironmentApi = {
			async children(id) {
				const missing = () => new Error(MESSAGES[ctx.locale()].missingSession);
				if (typeof id !== "string" || !id) throw missing();
				const all = await ctx.sessions.list();
				if (!all.some((entry) => entry.id === id)) throw missing();
				return all.filter((entry) => entry.parentId === id);
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
