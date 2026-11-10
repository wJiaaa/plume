import type { SessionSummary } from "@plume/contract";

export type SessionSort = "updatedAt" | "createdAt" | "manual";

/** 显示和拖动共用同一顺序；还没排过的新会话在最前面。 */
export function orderedSessions(sessions: SessionSummary[], sort: SessionSort, custom: string[] = []): SessionSummary[] {
	const rank = new Map(custom.map((id, index) => [id, index]));
	return [...sessions].sort((a, b) => {
		if (sort === "manual") {
			const left = rank.get(a.id) ?? -1;
			const right = rank.get(b.id) ?? -1;
			if (left !== right) return left - right;
		}
		const field = sort === "createdAt" ? "createdAt" : "updatedAt";
		return b[field] - a[field];
	});
}

export function moveBeforeOrAfter<T>(items: T[], source: T, target: T, placement: "before" | "after"): T[] | null {
	if (source === target || !items.includes(source) || !items.includes(target)) return null;
	const next = items.filter((item) => item !== source);
	next.splice(next.indexOf(target) + (placement === "after" ? 1 : 0), 0, source);
	return next.every((item, index) => item === items[index]) ? null : next;
}
