/**
 * 界面入口：转录里怎么说 `recall`。它搜的是这个会话的转录，和搜项目内容归成一类（`kind: "search"`），连着做时并进同一段「探索」。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { MESSAGES } from "./messages.ts";

export default {
	name: "plume.compaction",
	apply(ui) {
		ui.toolLine("recall", {
			verb: (locale) => MESSAGES[locale].recallVerb,
			subject: (args) => (typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined),
			kind: "search",
		});
	},
} satisfies UiPlugin;
