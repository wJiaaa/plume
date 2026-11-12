/**
 * 界面入口：转录里怎么说 `recall`。它搜的是这个会话的转录，不是工作区里的文件，所以工具定义上不声明种类（`kind` 说的是对文件、命令做的活，
 * 收窄工具表的插件按它挑工具）；在转录里归成自己起名的一类，和读、搜、改、跑命令那几类接成一段「探索」。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { Search } from "@plume/ui/icons";
import { MESSAGES } from "./messages.ts";

export default {
	name: "plume.compaction",
	apply(ui) {
		ui.toolLine("recall", {
			verb: (locale) => MESSAGES[locale].recallVerb,
			subject: (args) => (typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined),
			group: "recall",
			icon: Search,
		});
	},
} satisfies UiPlugin;
