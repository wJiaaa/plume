/**
 * 会话是哪一种（`SessionSummary.kind`）和钩子、工具拿到的那份会话信息（`SessionScope`），都从摘要上的 `parentId`、`owner` 算出。
 * 本体里判断「是不是人的那段对话」只经这里，不在各处自己拼两个字段。
 */

import type { SessionKind, SessionScope, SessionSummary } from "@plume/contract";

export function kindOf(summary: Pick<SessionSummary, "parentId" | "owner">): SessionKind {
	return summary.parentId ? "child" : summary.owner ? "standalone" : "top";
}

/** 给钩子输入和 `ToolRun` 的那份：每次现拷，插件改了手上的不影响摘要。 */
export function sessionScope(summary: SessionSummary): SessionScope {
	return {
		id: summary.id,
		kind: summary.kind,
		...(summary.parentId ? { parentId: summary.parentId } : {}),
		...(summary.owner ? { owner: summary.owner } : {}),
		...(summary.spawnedFrom ? { spawnedFrom: { ...summary.spawnedFrom } } : {}),
		...(summary.project ? { project: summary.project } : {}),
		...(summary.steward ? { steward: summary.steward } : {}),
	};
}
