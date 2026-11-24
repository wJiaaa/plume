/**
 * plume.environment 的逻辑入口：环境卡片的内容都在界面入口（`ui.tsx`）和各插件登记的 `ui.environmentSection` 里，
 * 这里保留最小插件入口供宿主注册。
 */

import type { Plugin } from "@plume/contract";

export default {
	name: "plume.environment",
	apply() {},
} satisfies Plugin;
