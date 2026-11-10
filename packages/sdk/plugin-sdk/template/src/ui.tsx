/**
 * __NAME__ 的界面入口，跑在渲染进程：把 __TOOL__ 的结果画成一张卡片。details 认不出时用通用卡片。
 *
 * 样式只用 @plume/ui 的组件（文字用 Text）和 var(--plume-*)，不写 Tailwind 类（插件单独构建，产品扫不到）。
 */

import type { ToolCardProps, UiPlugin } from "@plume/contract/ui";
import { Card, Text, useI18n } from "@plume/ui";
import { MESSAGES } from "./messages.ts";
import { isGreeting } from "./types.ts";

function GreetingCard({ status, result, fallback }: ToolCardProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const details = result?.details;
	if (status === "failed" || !isGreeting(details)) return <>{fallback}</>;
	return (
		<Card title={text.greeting}>
			<Text as="p" size="body" tone="muted">
				{text.hello(details.name)}
			</Text>
		</Card>
	);
}

export default {
	name: "__NAME__",
	apply(ui) {
		ui.toolCard("__TOOL__", GreetingCard);
	},
} satisfies UiPlugin;
