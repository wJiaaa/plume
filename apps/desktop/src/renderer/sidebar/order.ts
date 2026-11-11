import type { SessionSummary } from "@plume/contract";

export type SessionSort = "updatedAt" | "createdAt" | "manual";

/**
 * 一个项目实际怎么排：列表设置选的是所有项目的排法，拖过的项目（`dragged`）单独切成手动，别的项目照旧。
 */
export function projectSort(projectId: string, sort: SessionSort, dragged: readonly string[]): SessionSort {
	return dragged.includes(projectId) ? "manual" : sort;
}

/** 显示和拖动共用同一顺序；还没排过的新会话在最前面，彼此按新建先后，不随活动跳。 */
export function orderedSessions(sessions: SessionSummary[], sort: SessionSort, custom: string[] = []): SessionSummary[] {
	const rank = new Map(custom.map((id, index) => [id, index]));
	return [...sessions].sort((a, b) => {
		if (sort === "manual") {
			const left = rank.get(a.id) ?? -1;
			const right = rank.get(b.id) ?? -1;
			if (left !== right) return left - right;
		}
		const field = sort === "updatedAt" ? "updatedAt" : "createdAt";
		return b[field] - a[field];
	});
}

export function moveBeforeOrAfter<T>(items: T[], source: T, target: T, placement: "before" | "after"): T[] | null {
	if (source === target || !items.includes(source) || !items.includes(target)) return null;
	const next = items.filter((item) => item !== source);
	next.splice(next.indexOf(target) + (placement === "after" ? 1 : 0), 0, source);
	return next.every((item, index) => item === items[index]) ? null : next;
}
