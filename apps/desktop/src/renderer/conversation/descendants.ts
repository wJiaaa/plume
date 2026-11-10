import type { SessionSummary } from "@plume/contract";

/** 沿真实父链找全部后代，不借当前焦点，也不漏掉子任务里的再派发。 */
export function conversationDescendants(parentId: string, sessions: readonly SessionSummary[]): SessionSummary[] {
	const family = new Set([parentId]);
	const children: SessionSummary[] = [];
	let added = true;
	while (added) {
		added = false;
		for (const session of sessions) {
			if (!session.parentId || !family.has(session.parentId) || family.has(session.id)) continue;
			family.add(session.id);
			children.push(session);
			added = true;
		}
	}
	return children;
}
