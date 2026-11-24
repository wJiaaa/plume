/**
 * 已归档聊天的分组与筛选纯函数，供设置页「已归档的聊天」和单测共用。
 */

import type { ProjectEntry, SessionSummary } from "@plume/contract";

/** 不属于任何项目（或项目已经移除）的会话归在这一组，和侧栏的「聊天」一样。 */
export const LOOSE_PROJECT_KEY = "";

export interface ArchivedGroup {
	key: string;
	name: string;
	sessions: SessionSummary[];
}

/** 选出所有顶层已归档会话（子会话、插件独立会话不列在这里）。 */
export function selectArchivedSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
	return sessions.filter((session) => session.archived && session.kind === "top");
}

/**
 * 按会话记录的项目 id 分组，和侧栏保持一致：同一个目录可以登记成几个项目；
 * 没有项目或项目已移除的会话统一落到 `LOOSE_PROJECT_KEY`。
 *
 * 组内按最后活动时间降序；组间按会话数降序，数量相同时按组内最新会话时间降序，避免列表顺序抖动。
 */
export function groupArchivedSessions(archived: readonly SessionSummary[], projects: readonly ProjectEntry[], looseName: string): ArchivedGroup[] {
	const names = new Map(projects.map((entry) => [entry.id, entry.name]));
	const byKey = new Map<string, ArchivedGroup>();
	for (const session of archived) {
		const name = session.project ? names.get(session.project) : undefined;
		const key = name !== undefined && session.project ? session.project : LOOSE_PROJECT_KEY;
		const entry = byKey.get(key) ?? { key, name: name ?? looseName, sessions: [] };
		entry.sessions.push(session);
		byKey.set(key, entry);
	}
	return [...byKey.values()]
		.map((group) => ({ ...group, sessions: group.sessions.sort((a, b) => b.updatedAt - a.updatedAt) }))
		.sort((a, b) => b.sessions.length - a.sessions.length || (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
}

/** 当前选中的项目筛选在恢复/删除后若已经没有归档会话，自动回退到「所有项目」。 */
export function resolveProjectFilter(selected: string, groups: readonly ArchivedGroup[]): string {
	if (selected === "all") return "all";
	return groups.some((group) => group.key === selected) ? selected : "all";
}

/** 按项目筛选和搜索关键词过滤分组，空组不保留。 */
export function filterArchivedGroups(groups: readonly ArchivedGroup[], project: string, query: string): ArchivedGroup[] {
	const needle = query.trim().toLowerCase();
	const scoped = project === "all" ? groups : groups.filter((group) => group.key === project);
	if (!needle) return [...scoped];
	return scoped
		.map((group) => ({
			...group,
			sessions: group.sessions.filter((session) => session.title.toLowerCase().includes(needle)),
		}))
		.filter((group) => group.sessions.length > 0);
}
