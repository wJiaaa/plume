/**
 * 「由某插件代答」那一行：这次调用的审批卡或等人给数据的卡，是代管这个会话的插件替人答的（`ToolResultMessage.answeredBy`）。
 * 一直显示，不藏到悬停或展开里：人回头看记录，要分得清哪一张是自己点的、哪一张是插件转来的答复。
 */

import { formatList, useI18n } from "@plume/ui";
import { Plug } from "@plume/ui/icons";
import { usePluginDisplayName } from "../market/store.ts";

export function AnsweredBy({ plugins }: { plugins: readonly string[] }) {
	const { t } = useI18n();
	const displayName = usePluginDisplayName();
	if (plugins.length === 0) return null;
	const names = [...new Set(plugins)].map((plugin) => displayName(plugin) ?? plugin);
	return (
		<div className="flex items-center gap-1 pt-0.5 pl-[22px] text-caption text-ink-faint" data-answered-by={plugins.join(" ")}>
			<Plug size={11} strokeWidth={1.9} aria-hidden />
			{t("tools.answeredBy", { name: formatList(names) })}
		</div>
	);
}
